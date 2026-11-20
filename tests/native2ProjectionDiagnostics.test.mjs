import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { backendTestAvailability, SseClient } from "./helpers/native2BackendHarness.mjs";
import {
	channelEvents, createSuiteProject, removeSuiteProject, slash, sleep,
	startRuntimeBackend, waitFor, writeSessionFile,
} from "./helpers/native2RuntimeEvents.mjs";

const entryReply = { data: { entries: [], leafId: null } };
const targetOf = (runtime) => ({ sessionId: runtime.sessionId, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration });
const failed = (errorMessage) => ({ role: "assistant", content: [], stopReason: "error", errorMessage });
const count = (session, name) => session.fake.commands().filter((row) => row.command === name).length;

/** Observe replacement commit through the public runtime list, not a timer assumption. */
async function bindingAt(session, filePath) {
	for (let attempt = 0; attempt < 250; attempt += 1) {
		const listed = await session.invoke("sessions:runtime-list", []);
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
		const current = listed.payload.result.find((row) => slash(row.sessionPath) === slash(filePath));
		if (current) return current;
		await sleep(20);
	}
	assert.fail(`session file ${filePath} was never bound`);
}

describe("native2 projection diagnostic ownership", { skip: backendTestAvailability().skip }, () => {
	let root;
	let projectPath;
	before(() => { ({ root, projectPath } = createSuiteProject("pideck-projection-diagnostics-")); });
	after(() => removeSuiteProject(root));

	const cases = ["anchored", "unanchored", "removed"].flatMap((mode) =>
		["task", "user"].map((boundary) => ({ mode, boundary })));
	for (const { mode, boundary } of cases) {
		test(`projection preserves diagnostic turn ownership: ${mode}/${boundary}`, async (t) => {
			const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
			const entries = (ids) => ({ data: { entries: ids.map((id, index) => ({
				type: "message", id, parentId: index ? ids[index - 1] : null,
				message: user(id === "u1" ? "first" : "second"),
			})), leafId: ids.at(-1) ?? null } });
			const initialEntries = mode === "unanchored" ? entryReply : entries(["u1"]);
			const finalMessages = mode === "removed" ? [user("second")] : [user("first"), user("second")];
			const finalEntries = entries(mode === "removed" ? ["u2"] : ["u1", "u2"]);
			const session = await startRuntimeBackend(t, { projectPath, projectId: `anchor-${mode}-${boundary}`, scenario: {
				responses: {
					get_messages: [{ data: { messages: [user("first")] } }, { data: { messages: finalMessages } }, { data: { messages: finalMessages } }],
					get_entries: [initialEntries, { ...finalEntries, replyGate: "anchor" }, finalEntries],
					get_commands: { data: { commands: [] }, eventsBeforeReply: [
						{ type: "agent_end", messages: [failed("anchor failure")] },
						...(boundary === "task" ? [
							{ type: "message_end", message: { role: "custom", type: "custom_message", customType: "pi-deck-todo-task-start", display: true, content: "second task" } },
						] : [{ type: "agent_start" }]),
					] },
				},
			} });
			const { record, target } = await session.activate(`anchor-${mode}`);
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect(); t.after(() => sse.close());
			const pending = session.invoke("sessions:runtime-compact", [targetOf(target)]);
			await waitFor(() => count(session, "get_entries") === 2);
			await session.invoke("sessions:runtime-commands", [targetOf(target)]);
			await waitFor(() => channelEvents(sse, record.id, "agents:message").some((p) => p.messages.some((r) => r.meta?.debugDetails === "anchor failure")));
			if (boundary === "task") {
				await waitFor(() => channelEvents(sse, record.id, "agents:message").some((p) => p.messages.some((r) => r.meta?.type === "todoTask" && r.text === "second task")));
			} else {
				// A queued follow-up has reopened the same runtime. Without agent_start,
				// activation correctly replaces an error-state runtime instead of reusing it.
				const sent = await session.prompt(record, "second", "later-live-user");
				assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
				await waitFor(() => channelEvents(sse, record.id, "agents:message").some((p) =>
					p.messages.some((r) => r.role === "user" && r.meta?.optimisticRequestId === "later-live-user")));
			}
			writeFileSync(`${session.fake.scenarioPath}.anchor`, "released");
			const result = (await pending).payload.result;
			assert.equal(result.ok, true, JSON.stringify(result));
			await waitFor(() => channelEvents(sse, record.id, "agents:message").some((p) => p.messages.some((r) => r.meta?.entryId === "u2")));
			const rows = channelEvents(sse, record.id, "agents:message").at(-1).messages;
			const diagnostic = rows.findIndex((r) => r.meta?.debugDetails === "anchor failure");
			if (mode === "anchored") {
				assert.ok(diagnostic > rows.findIndex((r) => r.meta?.entryId === "u1"));
				assert.ok(diagnostic < rows.findIndex((r) => r.meta?.entryId === "u2"));
			} else assert.equal(diagnostic, -1, "unidentifiable or removed origin must not migrate to the next turn");
		});
	}

	test("coalesced replacement keeps its own later diagnostic without importing the old session's error", async (t) => {
		const firstFile = writeSessionFile(projectPath, projectPath, "first-clone");
		const secondFile = writeSessionFile(projectPath, projectPath, "second-clone");
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "diagnostic-ownership",
			scenario: { responses: {
				clone: [{ data: { sessionFile: firstFile } }, { data: { sessionFile: secondFile } }],
				get_messages: [
					{ data: { messages: [] } },
					{ data: { messages: [{ role: "user", content: [{ type: "text", text: "first snapshot" }] }] } },
					{ data: { messages: [{ role: "user", content: [{ type: "text", text: "second snapshot" }] }] } },
				],
				get_entries: [
					entryReply, { ...entryReply, replyGate: "first-diagnostic-entries" },
					{ ...entryReply, eventsBeforeReply: [{ type: "agent_end", messages: [failed("new provider failure")] }] },
					entryReply,
				],
				get_commands: { data: { commands: [] }, eventsBeforeReply: [
					{ type: "agent_end", messages: [failed("old provider failure")] },
				] },
			} },
		});
		const { target } = await session.activate("original");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		const first = session.invoke("sessions:runtime-clone", [target]);
		await waitFor(() => count(session, "get_entries") === 2);
		const firstBinding = await bindingAt(session, firstFile);
		await session.invoke("sessions:runtime-commands", [targetOf(firstBinding)]);
		await waitFor(() => channelEvents(sse, firstBinding.sessionId, "agents:message").some((payload) =>
			payload.messages.some((row) => row.meta?.debugDetails === "old provider failure")));

		const second = session.invoke("sessions:runtime-clone", [targetOf(firstBinding)]);
		const secondBinding = await bindingAt(session, secondFile);
		assert.notEqual(firstBinding.sessionId, secondBinding.sessionId);
		writeFileSync(`${session.fake.scenarioPath}.first-diagnostic-entries`, "released");
		const [oldResult, newResult] = await Promise.all([first, second]);
		assert.equal(oldResult.payload.result.ok, false);
		assert.equal(oldResult.payload.result.error.code, "SESSION_RUNTIME_CHANGED");
		assert.equal(newResult.payload.result.ok, true, JSON.stringify(newResult.payload));
		await waitFor(() => channelEvents(sse, secondBinding.sessionId, "agents:message").some((payload) =>
			payload.messages.some((row) => row.text === "second snapshot" && row.meta?._piDeckMsgSeq === 0)));
		const rows = channelEvents(sse, secondBinding.sessionId, "agents:message").at(-1).messages;
		assert.equal(rows.filter((row) => row.meta?.debugDetails === "old provider failure").length, 0,
			"a new binding must not inherit local diagnostics from an older refresh ticket");
		assert.equal(rows.filter((row) => row.meta?.debugDetails === "new provider failure").length, 1,
			"the current binding's diagnostic must survive its own retry exactly once");
	});
});
