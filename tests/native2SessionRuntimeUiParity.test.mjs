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
import { waitFor } from "./helpers/native2RuntimeEvents.mjs";

/**
 * Interactive runtime parity: ask completion, cancellation, prompt delivery classification,
 * manual compaction gating, subagent live status and runtime listing.
 *
 * Every expectation is derived from the Node oracle (`AgentManager.sendUIResponse`,
 * `AgentManager.abort`, `SessionRuntimeCoordinator.send`, `SubagentRunTracker`,
 * `SessionRuntimeCoordinator.listRuntimes`) and asserted over the real wire:
 * `PiDeckBackend.exe` plus the `sessions:runtime-event` envelope the renderer consumes.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-ui";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal pi session file so the catalog has a real identity to activate. */
function writeSessionFile(sessionsDir, projectPath, name, text = "hello") {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text }], timestamp: 1_767_225_601_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

/** Runtime envelopes from one source channel, optionally narrowed further. */
const runtimeEvents = (sse, sourceChannel, predicate = () => true) => sse.frames
	.filter((frame) => frame.payload.channel === "sessions:runtime-event")
	.map((frame) => frame.payload.args[0])
	.filter((event) => event.sourceChannel === sourceChannel && predicate(event));

if (!executable) {
	// Never let a missing build turn this suite into a silent pass.
	describe("native2 session runtime interaction parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 session runtime interaction parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-ui-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * Start a backend with the scriptable fake pi, import one session and activate it.
		 * `scenario` may be a function of the (pre-created) session file so a test can script
		 * payloads that must name the session's own path (subagent owner checks).
		 */
		const start = async (t, { scenario = {}, name = "ui" } = {}) => {
			let fake = null;
			let filePath = "";
			let resolvedScenario = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					filePath = writeSessionFile(
						fixture.sessions,
						projectPath,
						`${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
					);
					resolvedScenario = typeof scenario === "function" ? scenario(filePath) : scenario;
					fake = createFakePi(fixture, resolvedScenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			const target = (await session.invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			const args = [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}];
			return { ...session, fake, record, filePath, target, sse, args, scenario: resolvedScenario };
		};

		/** One prompt turn that opens with `agent_start` and then emits `ask`. */
		const askTurn = (ask) => ({
			turns: [{
				ack: true,
				events: [
					{ event: { type: "agent_start" } },
					{ event: ask },
				],
			}],
		});

		const waitForAsk = (sse, requestId) => sse.waitFor((frame) => frame.payload.channel === "sessions:runtime-event"
			&& frame.payload.args[0].sourceChannel === "agents:ui-request"
			&& frame.payload.args[0].payload.requestId === requestId, 10_000);

		/** Poll a client-side condition (used for events that are not ask completions). */
		const waitForCondition = async (predicate, timeoutMs = 10_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.fail("condition was not met before the timeout");
		};

		const waitForCompletion = (sse, requestId) => sse.waitFor((frame) => frame.payload.channel === "sessions:runtime-event"
			&& frame.payload.args[0].sourceChannel === "agents:ui-request"
			&& frame.payload.args[0].payload.requestId === requestId
			&& frame.payload.args[0].payload.completed === true, 10_000);

		test("ui-response closes the ask card without waiting for pi's ACK", async (t) => {
			// pi takes a long time to answer the UI frame; the desktop must not block on it.
			const { invoke, fake, record, target, sse, args } = await start(t, {
				scenario: {
					...askTurn({ type: "extension_ui_request", id: "ask-1", method: "select", title: "Pick one", options: ["A", "B"] }),
					responses: { extension_ui_response: { delayMs: 60_000 } },
				},
			});
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "ask-turn",
				message: "ask me",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			const ask = await waitForAsk(sse, "ask-1");
			assert.deepEqual(ask.payload.args[0].payload.options, ["A", "B"]);

			const startedAt = Date.now();
			const answered = await invoke("sessions:ui-response", [{
				...args[0],
				requestId: "ask-1",
				response: { value: "A" },
			}]);
			const elapsed = Date.now() - startedAt;
			assert.equal(answered.payload.ok, true, JSON.stringify(answered.payload));
			assert.equal(answered.payload.result.ok, true, JSON.stringify(answered.payload));
			assert.ok(elapsed < 5_000, `answering must not await pi's ACK (took ${elapsed}ms)`);

			// The renderer only clears the card on `completed`; without it the overlay stays
			// busy with every button disabled. Observe that before waiting for pi's receipt.
			const completion = await waitForCompletion(sse, "ask-1");
			const event = completion.payload.args[0];
			assert.equal(event.payload.value, "A");
			assert.equal(event.sessionId, record.id);
			assert.equal(event.agentId, target.agentId);
			assert.equal(event.runtimeGeneration, target.runtimeGeneration);

			// The raw write and UI completion do not acknowledge pi's stdin receipt.
			await waitFor(() => fake.commands().some((entry) => entry.command === "extension_ui_response"
				&& entry.payload.id === "ask-1"), 10_000, "pi receipt of the ask response without its ACK");
			// The frame pi receives carries the ask id plus the answer, nothing else.
			const frames = fake.commands().filter((entry) => entry.command === "extension_ui_response");
			assert.equal(frames.length, 1, JSON.stringify(frames));
			assert.equal(frames[0].payload.id, "ask-1");
			assert.equal(frames[0].payload.value, "A");
			assert.equal("cancelled" in frames[0].payload, false, JSON.stringify(frames[0].payload));

			// A second answer for the same ask is no longer pending.
			const again = await invoke("sessions:ui-response", [{ ...args[0], requestId: "ask-1", response: { value: "B" } }]);
			assert.equal(again.payload.result.ok, false, JSON.stringify(again.payload));
			assert.equal(again.payload.result.error.code, "MESSAGE_NOT_FOUND");
		});

		test("ask timeout closes pi and the renderer, and drops the pending request", async (t) => {
			const { invoke, record, target, sse, args, fake } = await start(t, {
				scenario: askTurn({
					type: "extension_ui_request",
					id: "ask-timeout",
					method: "input",
					title: "Name?",
					timeout: 150,
				}),
			});
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "timeout-turn",
				message: "ask with timeout",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			await waitForAsk(sse, "ask-timeout");

			const completion = await waitForCompletion(sse, "ask-timeout");
			assert.equal(completion.payload.args[0].payload.cancelled, true);

			// The completed event may reach SSE before pi records the cancellation frame.
			await waitFor(() => fake.commands().some((entry) => entry.command === "extension_ui_response"
				&& entry.payload.id === "ask-timeout"), 10_000, "pi receipt of the ask timeout cancellation");
			const frames = fake.commands().filter((entry) => entry.command === "extension_ui_response");
			assert.equal(frames.length, 1, JSON.stringify(frames));
			assert.equal(frames[0].payload.id, "ask-timeout");
			assert.equal(frames[0].payload.cancelled, true);

			// Both pending maps must be clear: a late answer cannot reach a request pi dropped.
			const late = await invoke("sessions:ui-response", [{ ...args[0], requestId: "ask-timeout", response: { value: "late" } }]);
			assert.equal(late.payload.result.ok, false, JSON.stringify(late.payload));
			assert.equal(late.payload.result.error.code, "MESSAGE_NOT_FOUND");
		});

		test("abort cancels a pending ask with value:null (never cancelled:true)", async (t) => {
			const { invoke, fake, record, target, sse, args } = await start(t, {
				scenario: askTurn({ type: "extension_ui_request", id: "ask-abort", method: "select", title: "Pick", options: ["A", "B"] }),
			});
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "abort-turn",
				message: "ask then abort",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			await waitForAsk(sse, "ask-abort");

			const aborted = await invoke("sessions:runtime-abort", [args[0]]);
			assert.equal(aborted.payload.result.ok, true, JSON.stringify(aborted.payload));

			const frames = fake.commands().filter((entry) => entry.command === "extension_ui_response");
			assert.equal(frames.length, 1, JSON.stringify(frames));
			// `cancelled:true` makes pi answer `undefined` and ask_question silently picks the
			// first option; the oracle sends `value:null` instead.
			assert.equal(frames[0].payload.value, null);
			assert.equal("cancelled" in frames[0].payload, false, JSON.stringify(frames[0].payload));

			const completion = await waitForCompletion(sse, "ask-abort");
			assert.equal(completion.payload.args[0].payload.cancelled, true);

			const late = await invoke("sessions:ui-response", [{ ...args[0], requestId: "ask-abort", response: { value: "A" } }]);
			assert.equal(late.payload.result.ok, false, JSON.stringify(late.payload));
			assert.equal(late.payload.result.error.code, "MESSAGE_NOT_FOUND");
		});

		test("ask custom-option marker is stripped and allowOther is set", async (t) => {
			const { invoke, record, target, sse } = await start(t, {
				scenario: askTurn({
					type: "extension_ui_request",
					id: "ask-custom",
					method: "select",
					title: "Choose",
					options: ["A", "✎ 自行输入..."],
				}),
			});
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "custom-turn",
				message: "ask with custom row",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			const frame = await waitForAsk(sse, "ask-custom");
			const request = frame.payload.args[0].payload;
			// The extension's marker row is the desktop's own inline field, not an answer.
			assert.deepEqual(request.options, ["A"], JSON.stringify(request));
			assert.equal(request.allowOther, true);
			assert.equal(request.method, "select");
		});

		test("rejected steer keeps the running status and reports no delivery flag", async (t) => {
			const { invoke, record, target } = await start(t, {
				scenario: {
					turns: [
						{ ack: true, events: [{ event: { type: "agent_start" } }] },
						{ ack: false, error: "queue is busy" },
					],
				},
			});
			const running = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "steer-one",
				message: "one",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(running.payload.result.accepted, true, JSON.stringify(running.payload));

			const steer = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "steer-two",
				message: "two",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			const result = steer.payload.result;
			assert.equal(result.accepted, false, JSON.stringify(steer.payload));
			assert.equal(result.i18nKey, "diagnostic.promptRejected");
			// pi answered `success:false`, so it provably did not apply the prompt.
			assert.equal("delivery" in result, false, JSON.stringify(result));

			const list = await invoke("sessions:runtime-list", []);
			const entry = list.payload.result.find((candidate) => candidate.sessionId === record.id);
			assert.ok(entry, JSON.stringify(list.payload));
			assert.equal(entry.status, "running", "a rejected steer must not demote a running turn");
			assert.equal(entry.agentId, target.agentId);
		});

		test("prompt transport failure is reported as delivery:unknown", async (t) => {
			const { invoke, record, target } = await start(t, {
				scenario: { turns: [{ exitBeforeAck: true }] },
			});
			const sent = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "transport-fail",
				message: "pi dies here",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			const result = sent.payload.result;
			assert.equal(result.accepted, false, JSON.stringify(sent.payload));
			// pi may already have read the prompt: retrying could duplicate the message.
			assert.equal(result.delivery, "unknown", JSON.stringify(result));
			assert.equal(result.i18nKey, "diagnostic.promptDeliveryUnknown");
		});

		test("manual compaction releases the gate so a later auto-compaction reloads history", async (t) => {
			const { invoke, fake, record, target, sse, args } = await start(t, {
				scenario: {
					messages: [
						{ role: "user", content: [{ type: "text", text: "m1" }] },
						{ role: "assistant", content: [{ type: "text", text: "m2" }] },
					],
					turns: [
						{ ack: true, events: [{ event: { type: "agent_start" } }, { event: { type: "agent_settled" } }] },
						{ ack: true, events: [{ event: { type: "auto_compaction_end", result: { summary: "s" } } }] },
					],
				},
			});
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "pre-compact",
				message: "first turn",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			const compacted = await invoke("sessions:runtime-compact", [args[0], "keep the plan"]);
			assert.equal(compacted.payload.result.ok, true, JSON.stringify(compacted.payload));
			const compactCommand = fake.commands().find((entry) => entry.command === "compact");
			assert.equal(compactCommand.payload.customInstructions, "keep the plan");

			// The manual compact must restore a sendable status (it has no agent_settled).
			const afterCompact = await invoke("sessions:runtime-list", []);
			const entry = afterCompact.payload.result.find((candidate) => candidate.sessionId === record.id);
			assert.equal(entry.status, "idle", JSON.stringify(afterCompact.payload));

			// A silent prompt writes no user bubble, so any projection reload from here on is the
			// auto-compaction path. `get_messages` is the oracle's reload probe: the renderer-facing
			// frame alone is not enough because a transport resync re-pushes the cached window.
			const reloadsBefore = fake.commands().filter((entry) => entry.command === "get_messages").length;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "post-compact",
				message: "",
				agentMessage: "follow-up",
				silent: true,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			await waitForCondition(() => fake.commands()
				.filter((entry) => entry.command === "get_messages").length > reloadsBefore);
		});

		test("a duplicate manual compact resolves with the current state while one is in flight", async (t) => {
			const { invoke, fake, args } = await start(t, {
				scenario: { responses: { compact: { delayMs: 1_200, data: { summary: "ok" } } } },
			});
			const first = invoke("sessions:runtime-compact", [args[0], "first"]);
			// Let the first RPC reach pi before the duplicate, so the guard is the only cause.
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && !fake.commands().some((entry) => entry.command === "compact")) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const duplicate = await invoke("sessions:runtime-compact", [args[0], "second"]);
			// Oracle `compact()`: `if (compactingAgents.has || rpcCompactingAgents.has) return
			// getRuntimeState(agentId)` — a resolved command with the in-flight state, never an
			// error (the renderer would show a spurious "compaction failed" toast).
			assert.equal(duplicate.payload.result.ok, true, JSON.stringify(duplicate.payload));
			assert.equal(duplicate.payload.result.value.value.isCompacting, true,
				JSON.stringify(duplicate.payload.result.value.value));
			assert.equal(fake.commands().filter((entry) => entry.command === "compact").length, 1);
			assert.equal((await first).payload.result.ok, true);
		});

		test("subagent status heartbeats publish sanitizer-valid live rows", async (t) => {
			const childA = join(projectPath, "child-a.jsonl");
			const childB = join(projectPath, "child-b.jsonl");
			const childLegacyPrefix = join(projectPath, "child-legacy.jsonl");
			const childForeignOwner = join(projectPath, "child-foreign.jsonl");
			const childC = join(projectPath, "child-c.jsonl");
			const childD = join(projectPath, "child-d.jsonl");
			const snapshot = (owner, children, { complete = false, workflowRunId = "wf-1", sequence = 1 } = {}) => JSON.stringify({
				version: 1,
				ownerSessionId: owner,
				parentToolCallId: "tool-1",
				workflowRunId,
				sequence,
				complete,
				truncated: false,
				observedAt: 1_767_225_600_000,
				children,
			});
			const ownerOf = (sessionFilePath) => sessionFilePath;

			const { invoke, record, target, sse } = await start(t, {
				name: "subagent",
				scenario: (sessionFilePath) => ({
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: { type: "tool_execution_start", toolCallId: "tool-1", toolName: "subagent" } },
							{
								event: {
									type: "tool_execution_end",
									toolCallId: "tool-1",
									toolName: "subagent",
									result: {
										details: {
											results: [{ sessionFile: childA, runId: "run-a", agent: "explore", progress: { status: "running" } }],
										},
									},
								},
							},
							// Old/unknown key prefix: must be ignored (the extension uses the shared
							// `pideck.subagent-status.v1:` contract).
							{
								event: {
									type: "extension_ui_request",
									id: "status-legacy",
									method: "setStatus",
									statusKey: "pideck-subagent:wf-legacy",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k0", sessionFile: childLegacyPrefix, state: "running" }], { workflowRunId: "wf-legacy" }),
								},
							},
							// Foreign owner: a stale publisher must not light this session's sidebar.
							{
								event: {
									type: "extension_ui_request",
									id: "status-foreign",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-1",
									statusText: snapshot("D:/somewhere/else.jsonl", [{ taskKey: "k9", sessionFile: childForeignOwner, state: "running" }]),
								},
							},
							{
								event: {
									type: "extension_ui_request",
									id: "status-1",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-1",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k1", sessionFile: childB, state: "running", agent: "researcher", executionId: "exec-b" }]),
								},
							},
							{
								event: {
									type: "extension_ui_request",
									id: "status-2",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-1",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k1", sessionFile: childB, state: "completed", agent: "researcher", executionId: "exec-b" }], { sequence: 2 }),
								},
							},
							// A late heartbeat from the execution that already completed: the sidebar
							// must not re-light it (the oracle keeps an `owner.finished` tombstone).
							{
								event: {
									type: "extension_ui_request",
									id: "status-3",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-1",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k1", sessionFile: childB, state: "running", agent: "stale", executionId: "exec-b" }], { sequence: 3 }),
								},
							},
							// A *different* execution id on the same path is a genuine relaunch.
							{
								event: {
									type: "extension_ui_request",
									id: "status-4",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-1",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k1", sessionFile: childB, state: "running", agent: "fresh", executionId: "exec-b2" }], { sequence: 4 }),
								},
							},
							// Explicit slot clear (`statusText: ''`) closes exactly that workflow's rows.
							{
								event: {
									type: "extension_ui_request",
									id: "status-5",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-2",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k2", sessionFile: childC, state: "running", agent: "researcher" }], { workflowRunId: "wf-2" }),
								},
							},
							{
								event: {
									type: "extension_ui_request",
									id: "status-6",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-2",
									statusText: "",
								},
							},
							// A closed workflow cannot reopen itself, even with a higher sequence.
							{
								event: {
									type: "extension_ui_request",
									id: "status-7",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-2",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k2", sessionFile: childC, state: "running", agent: "revived" }], { workflowRunId: "wf-2", sequence: 3 }),
								},
							},
							// A `complete` frame is a final inventory: its owned rows close.
							{
								event: {
									type: "extension_ui_request",
									id: "status-8",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-3",
									statusText: snapshot(ownerOf(sessionFilePath), [{ taskKey: "k3", sessionFile: childD, state: "running", agent: "researcher" }], { workflowRunId: "wf-3" }),
								},
							},
							{
								event: {
									type: "extension_ui_request",
									id: "status-9",
									method: "setStatus",
									statusKey: "pideck.subagent-status.v1:wf-3",
									statusText: snapshot(ownerOf(sessionFilePath), [], { workflowRunId: "wf-3", complete: true, sequence: 2 }),
								},
							},
						],
					}],
				}),
			});
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "subagent-turn",
				message: "run a subagent",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			// The wf-3 `complete` frame plus the wf-2 dispose are the terminal signals.
			await waitForCondition(() => {
				const frames = runtimeEvents(sse, "agents:subagent-status");
				const latest = frames.at(-1);
				const sawChildC = frames.some((event) => event.payload.runs
					.some((run) => slash(run.sessionFile) === slash(childC)));
				const sawChildD = frames.some((event) => event.payload.runs
					.some((run) => slash(run.sessionFile) === slash(childD)));
				// The relaunched execution frame is the terminal state: tool row + fresh child B.
				const paths = latest === undefined ? [] : latest.payload.runs.map((run) => slash(run.sessionFile));
				return sawChildC
					&& sawChildD
					&& latest !== undefined
					&& latest.payload.runs.length === 2
					&& paths.includes(slash(childA))
					&& latest.payload.runs.some((run) => slash(run.sessionFile) === slash(childB) && run.agent === "fresh");
			});

			const frames = runtimeEvents(sse, "agents:subagent-status");
			assert.ok(frames.length > 0, "subagent status must reach the renderer");
			const seenPaths = new Set();
			for (const event of frames) {
				for (const run of event.payload.runs) {
					// Exactly what `sanitizeRuns` accepts; anything else is silently dropped.
					assert.equal(typeof run.sessionFile, "string", JSON.stringify(run));
					assert.ok(run.sessionFile.length > 0, JSON.stringify(run));
					assert.ok(run.status === "running" || run.status === "error", JSON.stringify(run));
					assert.equal(typeof run.updatedAt, "number", JSON.stringify(run));
					seenPaths.add(slash(run.sessionFile));
				}
			}
			assert.ok(seenPaths.has(slash(childA)), JSON.stringify([...seenPaths]));
			assert.ok(seenPaths.has(slash(childB)), JSON.stringify([...seenPaths]));
			// A disposed slot's row was published first, then closed by the empty heartbeat;
			// a `complete` frame published and closed its own row too.
			assert.ok(seenPaths.has(slash(childC)), JSON.stringify([...seenPaths]));
			assert.ok(seenPaths.has(slash(childD)), JSON.stringify([...seenPaths]));
			// The wrong prefix and the foreign owner never produced a row.
			assert.equal(seenPaths.has(slash(childLegacyPrefix)), false, JSON.stringify([...seenPaths]));
			assert.equal(seenPaths.has(slash(childForeignOwner)), false, JSON.stringify([...seenPaths]));

			// Neither the stale execution nor the closed workflow ever came back, in any frame.
			for (const event of frames) {
				for (const run of event.payload.runs) {
					assert.notEqual(run.agent, "stale", "a finished execution must not be revived");
					assert.notEqual(run.agent, "revived", "a closed status task must not reopen");
				}
			}
			const finalRuns = frames.at(-1).payload.runs;
			const finalPaths = finalRuns.map((run) => slash(run.sessionFile));
			// The relaunched wf-1 execution keeps its row; the tool-only row stays (not owned by
			// any closed workflow) and the wf-2 clear / wf-3 complete rows are gone.
			assert.deepEqual(
				[...finalPaths].sort(),
				[slash(childA), slash(childB)].sort(),
				JSON.stringify(finalRuns),
			);
			assert.equal(finalRuns.find((run) => slash(run.sessionFile) === slash(childB)).agent, "fresh");
		});

		test("runtime-list keeps an idle bound runtime and drops a stopped one", async (t) => {
			const { invoke, record, target, args } = await start(t);
			const listed = await invoke("sessions:runtime-list", []);
			const entry = listed.payload.result.find((candidate) => candidate.sessionId === record.id);
			assert.ok(entry, JSON.stringify(listed.payload));
			// An idle runtime (no turn running) is still a runtime the renderer hydrates from.
			assert.equal(entry.status, "idle");
			assert.equal(entry.agentId, target.agentId);
			assert.equal(entry.runtimeGeneration, target.runtimeGeneration);

			const stopped = await invoke("sessions:runtime-stop", [args[0]]);
			assert.equal(stopped.payload.result.ok, true, JSON.stringify(stopped.payload));
			const after = await invoke("sessions:runtime-list", []);
			assert.equal(
				after.payload.result.some((candidate) => candidate.sessionId === record.id),
				false,
				JSON.stringify(after.payload),
			);
		});
	});
}

