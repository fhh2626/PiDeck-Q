import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { backendTestAvailability, SseClient } from "./helpers/native2BackendHarness.mjs";
import {
	channelEvents, createSuiteProject, removeSuiteProject, runtimeEnvelopes,
	sleep, startRuntimeBackend, waitFor,
} from "./helpers/native2RuntimeEvents.mjs";

const availability = backendTestAvailability();
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const entryReply = { data: { entries: [], leafId: null } };
const targetOf = (runtime) => ({ sessionId: runtime.sessionId, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration });
const commandCount = (session, name) => session.fake.commands().filter((event) => event.command === name).length;

/** Release a reply held inside the test fixture, never a production runtime control path. */
function releaseReply(session, gate) {
	writeFileSync(`${session.fake.scenarioPath}.${gate}`, "released");
}

/** Poll public bindings so the test schedules races against a committed identity. */
async function waitForGeneration(session, agentId, generation) {
	const deadline = Date.now() + 10_000;
	do {
		const listed = await session.invoke("sessions:runtime-list", []);
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
		const current = listed.payload.result.find((runtime) => runtime.agentId === agentId
			&& runtime.runtimeGeneration === generation);
		if (current) return current;
		await sleep(20);
	} while (Date.now() < deadline);
	assert.fail(`runtime generation ${generation} was never committed`);
}

describe("native2 projection replacement races", { skip: availability.skip }, () => {
	let root;
	let projectPath;
	before(() => { ({ root, projectPath } = createSuiteProject("pideck-projection-replacement-")); });
	after(() => removeSuiteProject(root));

	for (const commitsFirst of [true, false]) {
		test(`newer replacement ${commitsFirst ? "commits before" : "commits after"} the pending entries reply`, { timeout: 25_000 }, async (t) => {
			const session = await startRuntimeBackend(t, {
				projectPath, projectId: `projection-replacement-${commitsFirst}`,
				scenario: { responses: {
					clone: [
						{ data: { sessionId: "first-replacement" } },
						{ data: { sessionId: "second-replacement" }, ...(commitsFirst ? {} : { replyGate: "second-clone" }) },
					],
					get_messages: [
						{ data: { messages: [] } },
						{ data: { messages: [assistant("superseded snapshot")] } },
						{ data: { messages: [assistant(commitsFirst ? "current snapshot" : "uncommitted snapshot")] } },
						{ data: { messages: [assistant("current snapshot")] } },
					],
					get_entries: [
						entryReply,
						{ ...entryReply, replyGate: "first-entries" },
						{ ...entryReply, ...(commitsFirst ? {} : { replyGate: "uncommitted-entries" }) },
						entryReply,
					],
				} },
			});
			const { record, target } = await session.activate(`replacement-${commitsFirst}`);
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect(); t.after(() => sse.close());

			const first = session.invoke("sessions:runtime-clone", [target]);
			await waitFor(() => commandCount(session, "get_entries") === 2, 10_000, "first held projection");
			const firstBinding = await waitForGeneration(session, target.agentId, target.runtimeGeneration + 1);
			const second = session.invoke("sessions:runtime-clone", [targetOf(firstBinding)]);
			await waitFor(() => commandCount(session, "clone") === 2, 10_000, "second replacement RPC");

			if (commitsFirst) {
				await waitForGeneration(session, target.agentId, target.runtimeGeneration + 2);
				releaseReply(session, "first-entries");
			} else {
				// B owns the reservation but has not committed. A's response must not
				// fail B later or publish its obsolete snapshot into the reserved runtime.
				releaseReply(session, "first-entries");
				await waitFor(() => commandCount(session, "get_entries") === 3, 10_000, "unbound retry");
				releaseReply(session, "second-clone");
				await waitForGeneration(session, target.agentId, target.runtimeGeneration + 2);
				releaseReply(session, "uncommitted-entries");
			}

			const [older, current] = await Promise.all([first, second]);
			assert.equal(older.payload.ok, true, JSON.stringify(older.payload));
			assert.equal(older.payload.result.ok, false, "the superseded replacement must not acknowledge stale success");
			assert.equal(older.payload.result.error.code, "SESSION_RUNTIME_CHANGED");
			assert.equal(current.payload.ok, true, JSON.stringify(current.payload));
			assert.equal(current.payload.result.ok, true, "the current committed replacement must succeed");
			assert.equal(current.payload.result.value.runtimeGeneration, target.runtimeGeneration + 2);
			assert.equal(commandCount(session, "get_messages"), commitsFirst ? 3 : 4);

			await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
				payload.messages.some((row) => row.text === "current snapshot")));
			const messages = runtimeEnvelopes(sse, record.id).filter((event) => event.sourceChannel === "agents:message");
			assert.ok(messages.every((event) => event.payload.messages.every((row) =>
				row.text !== "superseded snapshot" && row.text !== "uncommitted snapshot")));
			assert.equal(messages.at(-1).runtimeGeneration, target.runtimeGeneration + 2);
			const finalBinding = await waitForGeneration(session, target.agentId, target.runtimeGeneration + 2);
			assert.equal(finalBinding.sessionId, current.payload.result.value.targetSessionId);
			const state = await session.invoke("sessions:runtime-state", [targetOf(finalBinding)]);
			assert.equal(state.payload.result.ok, true, "the successful replacement must remain addressable");
		});
	}
});
