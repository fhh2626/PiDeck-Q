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
const PROJECT_ID = "runtime-envelope";

/** Minimal pi session file: header + one completed user/assistant turn. */
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
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi there" }],
				timestamp: 1_767_225_602_000,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
			},
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

const textStream = (text) => [
	{ event: { type: "agent_start" } },
	{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
	{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: text } } },
	{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } } },
	{ event: { type: "agent_end", messages: [] } },
	{ event: { type: "agent_settled" } },
];

/** Runtime envelopes for one session, in arrival order. */
function runtimeEvents(sse, sessionId) {
	return sse.frames
		.map((frame) => frame.payload)
		.filter((payload) => payload.channel === "sessions:runtime-event")
		.map((payload) => payload.args[0])
		.filter((event) => event && event.sessionId === sessionId);
}

async function waitFor(predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = predicate();
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("expected condition did not become true");
}

if (executable) {
	describe("native2 runtime event envelopes (agents:state projection)", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-envelope-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {}, settings = {} } = {}) => {
			let fake = null;
			const name = `s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
			let plannedPath = "";
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US", ...settings },
				prepare: (fixture) => {
					plannedPath = join(fixture.sessions, `${name}.jsonl`);
					// A scenario that needs the future session path (subagent ownership frames) is
					// built here instead of in the test body.
					const built = typeof scenario === "function" ? scenario(plannedPath) : scenario;
					// pi reports the file it owns; the runtime state projection reads usage
					// from that path, so the fake must return the real fixture file.
					fake = createFakePi(fixture, {
						...built,
						state: { ...(built.state ?? {}), sessionFile: plannedPath },
					});
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, name);
			assert.equal(filePath, plannedPath);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find(
				(entry) => String(entry.filePath).replaceAll("\\", "/") === filePath.replaceAll("\\", "/"),
			);
			assert.ok(record, "imported session must appear in the catalog");
			return { ...session, fake, record, filePath };
		};

		test("activation publishes the per-tab agents:state envelope the renderer actually consumes", async (t) => {
			const { invoke, record, baseUrl, token, fake, filePath } = await start(t, {
				scenario: { turns: [{ ack: true, events: textStream("hello") }] },
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;

			const envelope = await sse.waitFor((frame) => {
				const event = frame.payload?.args?.[0];
				return frame.payload?.channel === "sessions:runtime-event"
					&& event?.sourceChannel === "agents:state"
					&& event.agentId === target.agentId
					&& event.payload?.status === "idle";
			});
			const state = envelope.payload.args[0];
			assert.equal(state.kind, "event");
			assert.equal(state.sessionId, record.id);
			assert.equal(state.agentId, target.agentId);
			assert.equal(state.runtimeGeneration, target.runtimeGeneration);
			assert.equal(state.payload.id, target.agentId);
			assert.equal(state.payload.projectId, PROJECT_ID);
			assert.equal(String(state.payload.cwd).replaceAll("\\", "/"), projectPath.replaceAll("\\", "/"));
			assert.equal(typeof state.payload.createdAt, "number");
			assert.equal(state.payload.sessionPath.replaceAll("\\", "/"), filePath.replaceAll("\\", "/"));

			// The raw tab list still exists (LAN snapshot trigger + existing subscribers).
			assert.equal(
				sse.frames.some((frame) => frame.payload?.channel === "agents:state"
					&& Array.isArray(frame.payload.args?.[0])
					&& frame.payload.args[0].some((tab) => tab.id === target.agentId)),
				true,
				"raw agents:state tab list must keep being published",
			);

			// A later status change must arrive through the same envelope channel: the
			// renderer never re-reads listRuntimes(), so a raw-only update leaves the
			// sidebar dot and the agent inventory stale forever.
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "envelope-1",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			await waitFor(() => runtimeEvents(sse, record.id).some(
				(event) => event.sourceChannel === "agents:state" && event.payload?.status === "running",
			));
			const settled = await waitFor(() => {
				const states = runtimeEvents(sse, record.id).filter((event) => event.sourceChannel === "agents:state");
				const runningIndex = states.findIndex((event) => event.payload?.status === "running");
				if (runningIndex < 0) return null;
				return states.slice(runningIndex + 1).find((event) => event.payload?.status === "idle") ?? null;
			});
			assert.equal(settled.runtimeGeneration, target.runtimeGeneration, "generation is stable within one run");
			assert.ok(fake.readLog().some((entry) => entry.kind === "command" && entry.command === "prompt"));
		});

		test("a crashed anonymous runtime is discarded from the catalog, not just hidden", async (t) => {
			const { invoke, baseUrl, token } = await start(t, {
				// pi dies with the prompt on the wire: the runtime is closed without a file.
				scenario: { turns: [{ exitBeforeAck: true }] },
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const created = await invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const anonymous = created.payload.result.session;
			assert.equal(anonymous.noSession, true);

			const activated = await invoke("sessions:runtime-activate", [anonymous.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;

			await invoke("sessions:send-prompt", [{
				sessionId: anonymous.id,
				requestId: "crash-1",
				message: "die",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			const closed = await sse.waitFor((frame) => {
				const event = frame.payload?.args?.[0];
				return frame.payload?.channel === "sessions:runtime-event"
					&& event?.sourceChannel === "agents:state"
					&& event.sessionId === anonymous.id
					&& event.payload?.status === "closed"
					&& event.payload?.noSession === true;
			});
			assert.equal(closed.payload.args[0].agentId, target.agentId);

			const detach = await sse.waitFor((frame) => {
				const event = frame.payload?.args?.[0];
				return frame.payload?.channel === "sessions:runtime-event"
					&& event?.kind === "detach"
					&& event.sessionId === anonymous.id;
			});
			assert.equal(detach.payload.args[0].agentId, target.agentId);

			const catalog = await invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(catalog.payload.ok, true, JSON.stringify(catalog.payload));
			assert.equal(
				catalog.payload.result.some((entry) => entry.id === anonymous.id),
				false,
				"a crashed --no-session runtime must not leave a phantom catalog record",
			);
			const runtimes = await invoke("sessions:runtime-list");
			assert.deepEqual(runtimes.payload.result, []);
		});

		test("an ask raised before the binding exists is cancelled instead of blocking pi", async (t) => {
			const { invoke, record, baseUrl, token, fake } = await start(t, {
				scenario: {
					// Emitted at process start, i.e. before the coordinator binds the runtime.
					onStart: [{
						delayMs: 0,
						event: { type: "extension_ui_request", id: "ui-unbound", method: "confirm", title: "Proceed?" },
					}],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));

			const cancelled = await waitFor(() => fake.readLog().find((entry) => entry.kind === "command"
				&& entry.command === "extension_ui_response"
				&& entry.payload?.id === "ui-unbound"));
			assert.equal(cancelled.payload.cancelled, true, "an unbound dialog ask must be answered with cancelled:true");

			assert.equal(
				runtimeEvents(sse, record.id).some((event) => event.sourceChannel === "agents:ui-request"
					&& event.payload?.requestId === "ui-unbound"),
				false,
				"an unbound ask must not be projected to the renderer",
			);
		});
		test("a runtime that dies mid-reply clears its per-agent state before the closed frame", async (t) => {
			const childFile = join(projectPath, "crash-child.jsonl");
			const { invoke, record, baseUrl, token, filePath } = await start(t, {
				// Subagent status frames are owner-relative, so the scenario needs the path pi
				// will report as `sessionFile` (the fixture file this test imports).
				scenario: (sessionPath) => ({
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
							{
								delayMs: 10,
								event: {
									type: "message_update",
									message: { role: "assistant", content: [] },
									assistantMessageEvent: { type: "text_delta", delta: "partial" },
								},
							},
							{
								delayMs: 10,
								event: {
									type: "extension_ui_request",
									id: "status-crash",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-crash",
									statusText: JSON.stringify({
										version: 1,
										ownerSessionId: sessionPath,
										parentToolCallId: "tool-1",
										workflowRunId: "wf-crash",
										sequence: 1,
										complete: false,
										truncated: false,
										observedAt: 1_767_225_600_000,
										children: [{
											taskKey: "k1",
											sessionFile: childFile,
											state: "running",
											agent: "researcher",
											executionId: "exec-crash",
										}],
									}),
								},
							},
						],
						// pi dies here (exit code 1, no `agent_settled`): the tab is still streaming.
						crashAfterEvents: true,
					}],
				}),
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "crash-midturn",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			// The child row has to be live *before* the crash, otherwise the retraction below
			// would pass even if no row ever existed.
			const liveRun = await waitFor(() => runtimeEvents(sse, record.id)
				.filter((event) => event.sourceChannel === "agents:subagent-status")
				.map((event) => event.payload?.runs)
				.find((runs) => Array.isArray(runs) && runs.length === 1
					&& String(runs[0].sessionFile).replaceAll("\\", "/") === childFile.replaceAll("\\", "/")));
			assert.equal(liveRun[0].status, "running");

			// `waitFor` treats -1 as found, so the index is mapped to null until it exists.
			const closedIndex = await waitFor(() => {
				const index = sse.frames.findIndex((frame) => {
					const event = frame.payload?.args?.[0];
					return frame.payload?.channel === "sessions:runtime-event"
						&& event?.sourceChannel === "agents:state"
						&& event.sessionId === record.id
						&& event.payload?.status === "closed";
				});
				return index >= 0 ? index : null;
			});

			// Oracle `clearAgentState`: the dead runtime's child rows are retracted and its
			// local streaming flag is patched to false, *before* the closed state frame.
			const retracted = sse.frames.findIndex((frame, index) => index < closedIndex
				&& frame.payload?.channel === "sessions:runtime-event"
				&& frame.payload.args[0]?.sourceChannel === "agents:subagent-status"
				&& frame.payload.args[0].agentId === target.agentId
				&& Array.isArray(frame.payload.args[0].payload?.runs)
				&& frame.payload.args[0].payload.runs.length === 0);
			assert.ok(retracted >= 0, "a crashed runtime must retract its subagent rows before closing");

			const flags = sse.frames.findIndex((frame, index) => index < closedIndex
				&& frame.payload?.channel === "sessions:runtime-event"
				&& frame.payload.args[0]?.sourceChannel === "agents:runtime-state"
				&& frame.payload.args[0].agentId === target.agentId
				&& frame.payload.args[0].payload?.state?.isStreaming === false);
			assert.ok(flags >= 0, "a crashed runtime must settle its streaming flags before closing");
			assert.equal(sse.frames[flags].payload.args[0].payload.state.isExecutingTool, false);

			const runtimes = await invoke("sessions:runtime-list");
			assert.deepEqual(runtimes.payload.result, []);
			assert.equal(filePath.endsWith(".jsonl"), true);
		});
	});
}
