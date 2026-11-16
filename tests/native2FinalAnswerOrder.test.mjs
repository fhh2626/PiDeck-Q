import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { backendTestAvailability, SseClient } from "./helpers/native2BackendHarness.mjs";
import {
	channelEvents, createSuiteProject, messageEnd, messageStart,
	removeSuiteProject, startRuntimeBackend, waitFor,
} from "./helpers/native2RuntimeEvents.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { buildTurnDisplay } from "../src/renderer/src/components/session/timeline/buildTurnDisplay.ts";

const { groupToolMessages } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");
const availability = backendTestAvailability();
const FINAL_TEXT = "The investigation is complete. Here is the final answer.";
const HISTORY_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6l8AAAAASUVORK5CYII=";
const imageContent = [{ type: "image", mimeType: "image/png", data: HISTORY_IMAGE }];
const commandTarget = (record, target) => ({ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration });

/** Read an explicit message flush after earlier terminal events have been observed. */
async function readRows(session, sse, record, target) {
	const count = channelEvents(sse, record.id, "agents:message").length;
	const result = await session.invoke("sessions:runtime-flush-messages", [commandTarget(record, target)]);
	assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
	assert.equal(result.payload.result.ok, true, JSON.stringify(result.payload));
	await waitFor(() => channelEvents(sse, record.id, "agents:message").length > count);
	return channelEvents(sse, record.id, "agents:message").at(-1).messages;
}

/** Empty tool-use replies are distinct messages, even though their bodies are identical. */
function toolTurn(id, toolName) {
	return [
		{ event: messageStart(`assistant-${id}`) },
		{ event: { type: "message_end", message: {
			role: "assistant", stopReason: "toolUse", content: [
				{ type: "thinking", thinking: `Planning ${id}` },
				{ type: "toolCall", id, name: toolName, arguments: {} },
			],
		} } },
		{ event: { type: "tool_execution_start", toolCallId: id, toolName, args: {} } },
		{ event: { type: "tool_execution_end", toolCallId: id, toolName,
			result: { content: [{ type: "text", text: `${id} finished` }] } } },
	];
}

describe("native2 final answer ordering", {
	skip: availability.skip,
}, () => {
	let root;
	let projectPath;
	before(() => { ({ root, projectPath } = createSuiteProject("pideck-native2-final-order-")); });
	after(() => removeSuiteProject(root));

	for (const kind of ["image", "thinking", "text"]) {
		test(`reload defers an active ${kind} reply and keeps repeated content as distinct messages`, async (t) => {
			// Neither IDs nor timestamps are supplied: equal image/reasoning/text content
			// must not be guessed to mean the same message. A boundary refresh needs no guess.
			const content = kind === "image" ? imageContent : kind === "thinking"
				? [{ type: "thinking", thinking: "repeated reasoning" }]
				: [{ type: "text", text: "repeated answer" }];
			const old = { role: "assistant", content, stopReason: "toolUse" };
			const active = { role: "assistant", content, stopReason: "stop" };
			const session = await startRuntimeBackend(t, {
				projectPath, projectId: `reload-${kind}`,
				scenario: {
					responses: {
						get_messages: [{ data: { messages: [old] } }, { data: { messages: [old, active] } }],
						// The test explicitly releases the terminal event, after checking the skeleton.
						get_commands: { data: { commands: [] }, eventsBeforeReply: [
							{ type: "message_end", message: active }, { type: "agent_end", messages: [] }, { type: "agent_settled" },
						] },
					},
					turns: [{ ack: true, events: [
						{ event: { type: "agent_start" } }, { event: messageStart("active") },
						{ event: { type: "compaction_end", result: {} } },
					] }],
				},
			});
			const { record, target } = await session.activate(`reload-${kind}`);
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect(); t.after(() => sse.close());
			await session.prompt(record, "reload", `reload-${kind}`);
			await waitFor(() => channelEvents(sse, record.id, "agents:state").some((tab) => tab.compactionCount > 0));
			const before = await readRows(session, sse, record, target);
			const skeleton = before.filter((row) => row.role === "assistant").at(-1);
			assert.equal(skeleton.text, "");
			assert.equal(before.filter((row) => row.role === "assistant").length, 2);
			assert.equal(session.fake.commands().filter((event) => event.command === "get_messages").length, 1,
				"projection must not replace an in-flight empty skeleton");

			await session.invoke("sessions:runtime-commands", [commandTarget(record, target)]);
			await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
				payload.messages.filter((row) => row.role === "assistant").at(-1)?.meta?._piDeckMsgSeq === 1));
			const rows = (await readRows(session, sse, record, target)).filter((row) => row.role === "assistant");
			assert.equal(rows.length, 2, JSON.stringify(rows));
			assert.notEqual(rows[0].id, rows[1].id);
			assert.equal(rows[0].stopReason, "toolUse");
			assert.equal(rows[1].stopReason, "stop");
			if (kind === "image") assert.deepEqual(rows.map((row) => row.images[0].data), [HISTORY_IMAGE, HISTORY_IMAGE]);
			else if (kind === "thinking") assert.deepEqual(rows.map((row) => row.thinking), ["repeated reasoning", "repeated reasoning"]);
			else assert.deepEqual(rows.map((row) => row.text), ["repeated answer", "repeated answer"]);
		});
	}

	test("stopping a runtime clears a projection waiting for an unfinished assistant", async (t) => {
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "reload-stop",
			scenario: { turns: [{ ack: true, events: [
				{ event: { type: "agent_start" } }, { event: messageStart("unfinished") },
				{ event: { type: "compaction_end", result: {} } },
			] }] },
		});
		const { record, target } = await session.activate("reload-stop");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		await session.prompt(record, "reload", "reload-stop");
		await waitFor(() => channelEvents(sse, record.id, "agents:state").some((tab) => tab.compactionCount > 0));
		const stopped = await session.invoke("sessions:runtime-stop", [commandTarget(record, target)]);
		assert.equal(stopped.payload.ok, true, JSON.stringify(stopped.payload));
		assert.equal(stopped.payload.result.ok, true, JSON.stringify(stopped.payload));
		const remaining = await session.invoke("sessions:runtime-list", []);
		assert.deepEqual(remaining.payload.result, []);
		assert.equal(session.fake.commands().filter((event) => event.command === "get_messages").length, 1);
	});

	test("pi exit during get_entries never publishes the captured snapshot", async (t) => {
		const stale = "snapshot from dead runtime";
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "entries-exit",
			scenario: {
				responses: {
					get_messages: [{ data: { messages: [] } }, { data: { messages: [messageEnd(stale).message] } }],
					get_entries: [{ data: { entries: [], leafId: null } }, { exitBeforeReply: true }],
				},
				turns: [{ ack: true, events: [{ event: { type: "compaction_end", result: {} } }] }],
			},
		});
		const { record } = await session.activate("entries-exit");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		await session.prompt(record, "reload", "entries-exit");
		await waitFor(() => channelEvents(sse, record.id, "agents:state").some((tab) => tab.status === "closed"));
		assert.ok(channelEvents(sse, record.id, "agents:message").every((payload) =>
			payload.messages.every((row) => row.text !== stale)));
	});

	test("events during get_entries force a fresh snapshot and eventually apply the refresh", async (t) => {
		const final = messageEnd("live after snapshot").message;
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "reload-race",
			scenario: {
				responses: {
					get_messages: [
						{ data: { messages: [] } },
						{ data: { messages: [{ role: "user", content: [{ type: "text", text: "stale snapshot" }] }] } },
						{ data: { messages: [final] } },
					],
					get_entries: [{ data: { entries: [], leafId: null } }, {
						data: { entries: [], leafId: null }, eventsBeforeReply: [
							messageStart("race"), { type: "message_end", message: final },
							{ type: "agent_end", messages: [] }, { type: "agent_settled" },
						],
					}, { data: { entries: [], leafId: null } }],
				},
				turns: [{ ack: true, events: [
					{ event: { type: "agent_start" } }, { event: { type: "compaction_end", result: {} } },
				] }],
			},
		});
		const { record, target } = await session.activate("reload-race");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		await session.prompt(record, "reload", "reload-race");
		await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
			payload.messages.some((row) => row.text === "live after snapshot" && row.meta?._piDeckMsgSeq === 0)));
		assert.equal(session.fake.commands().filter((event) => event.command === "get_messages").length, 3);
		const frames = channelEvents(sse, record.id, "agents:message");
		assert.ok(frames.every((payload) => payload.messages.every((row) => row.text !== "stale snapshot")));
		const rows = await readRows(session, sse, record, target);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].text, "live after snapshot");
	});

	test("a second reload request during get_entries is not satisfied by the earlier snapshot", async (t) => {
		const final = messageEnd("fresh compaction snapshot").message;
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "reload-coalescing",
			scenario: {
				responses: {
					get_messages: [
						{ data: { messages: [] } },
						{ data: { messages: [messageEnd("outdated compaction snapshot").message] } },
						{ data: { messages: [final] } },
					],
					get_entries: [
						{ data: { entries: [], leafId: null } },
						{ data: { entries: [], leafId: null }, eventsBeforeReply: [{ type: "compaction_end", result: {} }] },
						{ data: { entries: [], leafId: null } },
					],
				},
				turns: [{ ack: true, events: [{ event: { type: "compaction_end", result: {} } }] }],
			},
		});
		const { record, target } = await session.activate("reload-coalescing");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		await session.prompt(record, "compact", "reload-coalescing");
		await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
			payload.messages.some((row) => row.text === "fresh compaction snapshot")));
		assert.equal(session.fake.commands().filter((event) => event.command === "get_messages").length, 3);
		const rows = await readRows(session, sse, record, target);
		assert.deepEqual(rows.map((row) => row.text), ["fresh compaction snapshot"]);
	});

	test("a newer reload survives a failed in-flight get_messages request", async (t) => {
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "reload-read-error",
			scenario: {
				responses: { get_messages: [
					{ data: { messages: [] } },
					{ error: "snapshot unavailable", eventsBeforeReply: [{ type: "compaction_end", result: {} }] },
					{ data: { messages: [messageEnd("recovered snapshot").message] } },
				] },
				turns: [{ ack: true, events: [{ event: { type: "compaction_end", result: {} } }] }],
			},
		});
		const { record } = await session.activate("reload-read-error");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		await session.prompt(record, "compact", "reload-read-error");
		await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
			payload.messages.some((row) => row.text === "recovered snapshot")));
		assert.equal(session.fake.commands().filter((event) => event.command === "get_messages").length, 3);
	});

	test("deferred compaction projection preserves a later failed-turn diagnostic", async (t) => {
		const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" };
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "reload-error",
			scenario: {
				responses: {
					get_messages: [{ data: { messages: [] } }, { data: { messages: [
						{ role: "user", content: [{ type: "text", text: "projected failure turn" }] }, failed,
					] } }],
					get_commands: { data: { commands: [] }, eventsBeforeReply: [
						{ type: "agent_end", messages: [failed] },
					] },
				},
				turns: [{ ack: true, events: [
					{ event: { type: "agent_start" } }, { event: messageStart("failed") },
					{ event: { type: "compaction_end", result: {} } },
				] }],
			},
		});
		const { record, target } = await session.activate("reload-error");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		await session.prompt(record, "reload", "reload-error");
		await waitFor(() => channelEvents(sse, record.id, "agents:state").some((tab) => tab.compactionCount > 0));
		await session.invoke("sessions:runtime-commands", [commandTarget(record, target)]);
		await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
			payload.messages.some((row) => row.text === "projected failure turn" && row.meta?._piDeckMsgSeq === 0)));
		const rows = await readRows(session, sse, record, target);
		assert.equal(rows.filter((row) => row.role === "error" && row.meta?.debugDetails === "provider failed").length, 1);
	});

	test("projection retry across settlement retains the 50-turn cache limit", async (t) => {
		const history = Array.from({ length: 55 }, (_, i) => ({
			role: "user", content: [{ type: "text", text: `turn-${i}` }],
		}));
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "reload-trim",
			scenario: {
				responses: {
					get_messages: { data: { messages: history } },
					get_entries: [
						{ data: { entries: [], leafId: null } },
						{ data: { entries: [], leafId: null }, eventsBeforeReply: [{ type: "agent_settled" }] },
						{ data: { entries: [], leafId: null } },
					],
				},
				turns: [{ ack: true, events: [{ event: { type: "compaction_end", result: {} } }] }],
			},
		});
		const { record, target } = await session.activate("reload-trim");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		await session.prompt(record, "reload", "reload-trim");
		await waitFor(() => session.fake.commands().filter((event) => event.command === "get_messages").length >= 3);
		await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
			payload.messages.some((row) => row.text === "turn-54" && row.meta?._piDeckMsgSeq === 54)));
		const rows = (await readRows(session, sse, record, target)).filter((row) => row.role === "user");
		assert.equal(rows.length, 50);
		assert.equal(rows[0].text, "turn-5");
	});

	test("runtime exit fails a manual compaction waiting for an unfinished assistant", { timeout: 10_000 }, async (t) => {
		let phase = "starting fixture";
		t.after(() => { if (t.signal.aborted) t.diagnostic(phase); });
		const session = await startRuntimeBackend(t, {
			projectPath, projectId: "reload-exit",
			scenario: {
				responses: { get_commands: { exitBeforeReply: true } },
				turns: [{ ack: true, events: [
					{ event: { type: "agent_start" } }, { event: messageStart("unfinished") },
				] }],
			},
		});
		const { record, target } = await session.activate("reload-exit");
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect(); t.after(() => sse.close());
		phase = "waiting for active assistant";
		await session.prompt(record, "reload", "reload-exit");
		await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) =>
			payload.messages.some((row) => row.role === "assistant")));
		phase = "waiting for compact RPC";
		const compacting = session.invoke("sessions:runtime-compact", [commandTarget(record, target), "compact now"]);
		await waitFor(() => session.fake.commands().some((event) => event.command === "compact"));
		// Kill pi after compact ACKed but before the deferred projection could run.
		phase = "waiting for exit-trigger RPC";
		await session.invoke("sessions:runtime-commands", [commandTarget(record, target)]);
		phase = "waiting for compaction failure";
		const result = await compacting;
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		assert.equal(result.payload.result.ok, false, "a projection that never ran cannot acknowledge compaction success");
		await waitFor(() => channelEvents(sse, record.id, "sessions:runtime-detach").length > 0);
		const remaining = await session.invoke("sessions:runtime-list", []);
		assert.equal(remaining.payload.result.some((entry) => entry.sessionId === record.id), false);
		assert.equal(session.fake.commands().filter((event) => event.command === "get_messages").length, 1);
	});

	test("an anonymous activation exiting during its initial projection removes its transient catalog row", async (t) => {
		const projectId = "projection-startup-exit";
		const session = await startRuntimeBackend(t, {
			projectPath, projectId, scenario: { responses: { get_messages: { exitBeforeReply: true } } },
		});
		const created = await session.invoke("sessions:create-anonymous", [{ projectId }]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const record = created.payload.result.session;
		assert.ok(record.id);
		const activated = await session.invoke("sessions:runtime-activate", [record.id]);
		assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
		assert.equal(activated.payload.result.ok, false, JSON.stringify(activated.payload));
		const listed = await session.invoke("sessions:catalog-list", [projectId, { scan: false }]);
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
		assert.equal(listed.payload.result.some((entry) => entry.id === record.id), false,
			"failed projection startup must use the same transient cleanup as failed get_state");
	});

	for (const fromHistory of [false, true]) {
		test(`final answer stays after tools with ${fromHistory ? "a projected" : "a live"} empty assistant`, async (t) => {
			const session = await startRuntimeBackend(t, {
				projectPath, projectId: "final-answer-order",
				scenario: {
					messages: fromHistory ? [{ role: "assistant", content: imageContent, stopReason: "toolUse" }] : [],
					turns: [{ ack: true, events: [
						{ event: { type: "agent_start" } }, ...toolTurn("read-1", "read"), ...toolTurn("subagent-1", "subagent"),
						{ event: messageStart("final-assistant") }, { event: messageEnd(FINAL_TEXT) },
						{ event: { type: "agent_end", messages: [] } }, { event: { type: "agent_settled" } },
					] }],
				},
			});
			const { record, target } = await session.activate(`final-order-${fromHistory}`);
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect(); t.after(() => sse.close());
			const sent = await session.prompt(record, "Investigate and summarize", `final-order-${fromHistory}`);
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));
			assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
			await waitFor(() => channelEvents(sse, record.id, "agents:message").some((payload) => payload.messages.some((row) => row.text === FINAL_TEXT)));
			await waitFor(() => channelEvents(sse, record.id, "agents:state").some((tab) => tab.status === "idle"));
			const rows = await readRows(session, sse, record, target);
			assert.equal(rows.at(-1).text, FINAL_TEXT);
			const currentTurn = rows.slice(rows.findLastIndex((row) => row.role === "user") + 1);
			assert.deepEqual(currentTurn.map((row) => row.role), ["assistant", "tool", "assistant", "tool", "assistant"]);
			const assistants = currentTurn.filter((row) => row.role === "assistant");
			assert.equal(new Set(assistants.map((row) => row.id)).size, 3);
			assert.deepEqual(assistants.map((row) => row.stopReason), ["toolUse", "toolUse", "stop"]);
			if (fromHistory) {
				assert.equal(rows[0].text, "");
				assert.equal(rows[0].images[0].data, HISTORY_IMAGE);
				assert.equal(rows[0].stopReason, "toolUse");
			}
			const run = groupToolMessages(rows).filter((item) => item.kind === "agent-run").at(-1);
			assert.ok(run);
			const display = buildTurnDisplay(run, { showThinking: true, isComplete: true });
			assert.equal(display.at(-1).kind, "final-answer");
			assert.equal(display.at(-1).message.text, FINAL_TEXT);
		});
	}
});
