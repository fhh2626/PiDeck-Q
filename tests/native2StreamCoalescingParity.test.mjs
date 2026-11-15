import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-stream";

function writeSessionFile(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

function events(sse, sessionId, channel) {
	return sse.frames
		.map((frame) => frame.payload)
		.filter((payload) => payload.channel === "sessions:runtime-event")
		.map((payload) => payload.args[0])
		.filter((event) => event && event.sessionId === sessionId && event.sourceChannel === channel)
		.map((event) => event.payload);
}

async function waitFor(predicate, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = predicate();
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("expected condition did not become true");
}

if (executable) {
	describe("native2 streaming / tool-update coalescing parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-stream-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {} } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const filePath = writeSessionFile(
				session.fixture.sessions,
				projectPath,
				`s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
			);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find(
				(entry) => String(entry.filePath).replaceAll("\\", "/") === filePath.replaceAll("\\", "/"),
			);
			assert.ok(record, "imported session must appear in the catalog");
			return { ...session, fake, record };
		};

		test("200 text deltas collapse into a bounded number of frames with delta form", async (t) => {
			const deltas = Array.from({ length: 200 }, (_, index) => `chunk${index} `);
			const fullText = deltas.join("");
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start" } },
						{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
						...deltas.map((delta) => ({
							event: {
								type: "message_update",
								message: { role: "assistant", content: [] },
								assistantMessageEvent: { type: "text_delta", delta },
							},
						})),
						{
							event: {
								type: "message_end",
								message: { role: "assistant", content: [{ type: "text", text: fullText }], stopReason: "stop" },
							},
						},
						{ event: { type: "agent_end", messages: [] } },
						{ event: { type: "agent_settled" } },
					],
				}],
			};
			const { invoke, record, baseUrl, token } = await start(t, { scenario });
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "stream-1",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			const frames = await waitFor(() => {
				const seen = events(sse, record.id, "agents:text-stream");
				return seen.some((payload) => payload.done === true) ? seen : null;
			});
			assert.ok(
				frames.length <= 10,
				`200 deltas must be coalesced into a bounded frame count, saw ${frames.length}`,
			);
			assert.equal(
				frames.some((payload) => typeof payload.delta === "string" && payload.delta.length > 0),
				true,
				`expected at least one delta frame, saw ${JSON.stringify(frames.slice(0, 4))}`,
			);
			// Replayed frames concatenate to the final text: a dropped/duplicated delta would
			// make the live row diverge from the settled History row. The terminal frame may
			// be a delta as well (oracle emits a delta when the previous frame already held
			// the full text).
			const rebuilt = frames
				.map((payload) => (typeof payload.delta === "string" ? payload.delta : payload.text ?? ""))
				.join("");
			assert.equal(rebuilt, fullText);
		});

		test("thinking ends with done=false and only message_end sends done=true", async (t) => {
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start" } },
						{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
						{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", delta: "ponder" } } },
						{ delayMs: 20, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_end" } } },
						{ delayMs: 20, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "answer" } } },
						{ delayMs: 20, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" } } },
						{ event: { type: "agent_end", messages: [] } },
						{ event: { type: "agent_settled" } },
					],
				}],
			};
			const { invoke, record, baseUrl, token } = await start(t, { scenario });
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "thinking-1",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			const thinking = await waitFor(() => {
				const frames = events(sse, record.id, "agents:thinking");
				return frames.length > 0 && frames.some((payload) => payload.done === true) ? frames : null;
			});
			const endFrame = thinking.find((payload) => payload.done === false && payload.endedAt > 0);
			assert.ok(endFrame, `thinking_end must publish a done=false frame, saw ${JSON.stringify(thinking)}`);
			assert.equal(endFrame.text ?? endFrame.delta, "ponder");
			const doneFrame = thinking.find((payload) => payload.done === true);
			assert.equal(doneFrame.text, "ponder", "the terminal thinking frame carries the full text");
			assert.equal(
				thinking.filter((payload) => payload.done === true).length,
				1,
				"only message_end may close the live thinking bubble",
			);
		});

		test("tool_execution_update does not flush a message window or poll runtime state per frame", async (t) => {
			const updates = Array.from({ length: 40 }, (_, index) => ({
				event: {
					type: "tool_execution_update",
					toolCallId: "call-1",
					toolName: "bash",
					partialResult: { content: [{ type: "text", text: `line ${index}` }] },
				},
			}));
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start" } },
						{ event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo" } } },
						...updates,
						{
							event: {
								type: "tool_execution_end",
								toolCallId: "call-1",
								toolName: "bash",
								result: { content: [{ type: "text", text: "done" }] },
								isError: false,
							},
						},
						{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } } },
						{ event: { type: "agent_end", messages: [] } },
						{ event: { type: "agent_settled" } },
					],
				}],
			};
			const { invoke, record, baseUrl, token, fake } = await start(t, { scenario });
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "tool-1",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			await waitFor(() => events(sse, record.id, "agents:message").some((frame) => frame.messages.some(
				(row) => (row.meta?.type === "tool" || row.role === "tool") && row.meta?.status === "done",
			)) && events(sse, record.id, "agents:state").some((payload) => payload.status === "idle"));

			const runtimeStates = events(sse, record.id, "agents:runtime-state");
			const sequences = new Set(
				runtimeStates
					.map((payload) => payload.state?.toolStateSequence)
					.filter((value) => typeof value === "number"),
			);
			const edges = [...sequences].filter((value) => value > 0).sort();
			assert.deepEqual(edges, [1, 2], `only start/end may publish tool edges, saw ${JSON.stringify([...sequences])}`);

			const statsPolls = fake.readLog().filter((entry) => entry.kind === "command" && entry.command === "get_session_stats");
			assert.ok(statsPolls.length < 20, `40 updates must not trigger a full state poll each, saw ${statsPolls.length} polls`);

			const messageFrames = events(sse, record.id, "agents:message");
			assert.ok(messageFrames.length < 25, `40 updates must be coalesced, saw ${messageFrames.length} message frames`);
			const toolRow = messageFrames.at(-1).messages.find((row) => row.meta?.type === "tool" || row.role === "tool");
			assert.ok(toolRow, "the terminal frame must carry the tool row");
			assert.equal(toolRow.meta?.status ?? toolRow.status, "done", JSON.stringify(toolRow));
		});
	});
}
