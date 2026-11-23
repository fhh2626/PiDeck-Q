import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal pi session file: header, model change, one user turn. */
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
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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
	{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_start" } } },
	{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: text } } },
	{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_end" } } },
	{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } } },
	{ event: { type: "agent_end", messages: [] } },
	{ event: { type: "agent_settled" } },
];

if (executable) {
	describe("native2 session runtime parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-runtime-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/** Start a backend whose pi is the scriptable fake, and import one session. */
		const start = async (t, { scenario = {}, settings = {} } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US", ...settings },
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, `s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			return { ...session, fake, record, filePath };
		};

		test("activation spawns pi with sanitized argv and publishes the runtime envelope", async (t) => {
			const { invoke, fake, record, filePath, baseUrl, token } = await start(t);
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			// The renderer subscribes before it asks for a runtime: no event may be lost.
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const info = activated.payload.result.value;
			assert.equal(info.sessionId, record.id);
			assert.match(info.agentId, /^[0-9a-f-]{36}$/);
			assert.equal(info.runtimeGeneration, 1);
			assert.equal(info.cwd.replaceAll("\\", "/"), projectPath.replaceAll("\\", "/"));
			assert.equal(slash(info.sessionPath), slash(filePath));

			const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
			assert.ok(spawn, "pi must have been spawned");
			assert.ok(spawn.argv.includes("--mode"), JSON.stringify(spawn.argv));
			assert.equal(spawn.argv[spawn.argv.indexOf("--mode") + 1], "rpc");
			assert.equal(slash(spawn.argv[spawn.argv.indexOf("--session") + 1]), slash(filePath));
			// The renderer never supplies an executable: the launch comes from settings.
			assert.equal(spawn.argv.some((argument) => argument.includes("PiDeckBackend")), false);
			assert.equal(spawn.env.PIDECK_DESKTOP, "1");
			assert.equal(spawn.env.PIDECK_SESSION_ID, record.id);
			assert.equal(spawn.env.PIDECK_UI_LANGUAGE, "en-US");
			assert.equal(spawn.env.PIDECK_HOST_TOKEN, null, "host token must never reach pi");

			const event = await sse.waitFor((frame) => frame.payload.channel === "sessions:runtime-event");
			const envelope = event.payload.args[0];
			assert.equal(envelope.kind, "event");
			assert.equal(envelope.sessionId, record.id);
			assert.equal(envelope.agentId, info.agentId);
			assert.equal(envelope.runtimeGeneration, 1);
			assert.equal(typeof envelope.sourceChannel, "string");
			assert.ok(Object.hasOwn(envelope, "payload"));
		});

		test("send-prompt is idempotent per requestId and never echoes an ack as assistant text", async (t) => {
			const { invoke, fake, record, baseUrl, token } = await start(t, {
				// The ack carries no text and no message events: an echo would be fabricated.
				scenario: { turns: [{ ack: true, events: [{ event: { type: "agent_start" } }, { event: { type: "agent_end", messages: [] } }, { event: { type: "agent_settled" } }] }] },
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			const input = {
				sessionId: record.id,
				requestId: "req-1",
				message: "hello pi",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			};
			const first = await invoke("sessions:send-prompt", [input]);
			assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
			assert.equal(first.payload.result.accepted, true);
			assert.equal(first.payload.result.sessionId, record.id);
			assert.equal(first.payload.result.requestId, "req-1");

			const second = await invoke("sessions:send-prompt", [input]);
			assert.deepEqual(second.payload.result, first.payload.result, "the same requestId must be idempotent");
			const prompts = fake.commands().filter((entry) => entry.command === "prompt");
			assert.equal(prompts.length, 1, "only one prompt may reach pi");
			assert.equal(prompts[0].payload.message, "hello pi");

			// Let the turn finish, then assert no assistant text was invented.
			// agents:state is a global channel (not enveloped): the tab list is the payload.
			await sse.waitFor((frame) => frame.payload.channel === "agents:state"
				&& frame.payload.args[0].some?.((tab) => tab.status === "idle")).catch(() => undefined);
			const streams = sse.frames
				.map((frame) => frame.payload)
				.filter((payload) => payload.channel === "sessions:runtime-event")
				.map((payload) => payload.args[0])
				.filter((event) => event.sourceChannel === "agents:text-stream")
				.map((event) => event.payload);
			assert.deepEqual(streams.filter((stream) => stream.done && stream.text), [], "an ack must not become assistant text");
		});

		test("streaming text, thinking and tool edges are projected with the session identity", async (t) => {
			const { invoke, record, baseUrl, token } = await start(t, {
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
							{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_start" } } },
							{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", delta: "pondering" } } },
							{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_end" } } },
							{ event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp/a" } } },
							{ event: { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false } },
							{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "answer" } } },
							{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop" } } },
							{ event: { type: "agent_end", messages: [] } },
							{ event: { type: "agent_settled" } },
						],
					}],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "req-stream",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			const events = (channel) => sse.frames
				.map((frame) => frame.payload)
				.filter((payload) => payload.channel === "sessions:runtime-event")
				.map((payload) => payload.args[0])
				.filter((event) => event.sourceChannel === channel);

			// `agents:state` is also emitted during activation (already idle), so the settle
			// wait must look only at frames that arrived after the turn finished.
			const waitForFrame = async (predicate, from = 0) => {
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					for (let index = from; index < sse.frames.length; index += 1) {
						if (predicate(sse.frames[index])) return index;
					}
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				throw new Error("expected frame did not arrive");
			};
			const doneIndex = await waitForFrame((frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:text-stream"
				&& frame.payload.args[0].payload.done === true);
			await waitForFrame((frame) => frame.payload.channel === "agents:state"
				&& frame.payload.args[0].some?.((tab) => tab.status === "idle"), doneIndex);

			const thinking = events("agents:thinking");
			assert.ok(thinking.length > 0, "thinking must be projected");
			// Live frames use the delta protocol after the first push (oracle
			// `emitThinkingNow`); the accumulated text is what the renderer shows.
			assert.equal(thinking[0].payload.text ?? thinking[0].payload.delta, "pondering");
			assert.equal(thinking[0].sessionId, record.id);
			assert.equal(thinking[0].agentId, target.agentId);
			assert.equal(thinking.at(-1).payload.done, true);

			const streams = events("agents:text-stream");
			const liveText = streams
				.filter((event) => event.payload.done !== true)
				.map((event) => event.payload.delta ?? event.payload.text ?? "")
				.join("");
			assert.equal(liveText, "answer", "live frames must accumulate to the reply text");

			const runtimeStates = events("agents:runtime-state");
			// Tool edges carry a monotonic toolStateSequence; every frame sharing a
			// sequence must agree, so the sequence is the stable identity here.
			const bySequence = new Map();
			for (const event of runtimeStates) {
				const state = event.payload.state;
				if (!state || typeof state.toolStateSequence !== "number") continue;
				if (!bySequence.has(state.toolStateSequence)) bySequence.set(state.toolStateSequence, state);
			}
			assert.equal(bySequence.get(1)?.isExecutingTool, true, JSON.stringify([...bySequence]));
			assert.equal(bySequence.get(1)?.executingToolName, "read");
			assert.equal(bySequence.get(2)?.isExecutingTool, false);

			const messages = events("agents:message");
			const rows = messages.at(-1).payload.messages;
			assert.equal(rows.some((row) => row.role === "assistant" && row.text === "answer"), true);
			const tool = rows.find((row) => row.meta?.type === "tool" || row.role === "tool");
			assert.ok(tool, `expected a tool row, got ${JSON.stringify(rows.map((row) => row.role))}`);
		});

		test("restart bumps the generation and rejects the stale target", async (t) => {
			const { invoke, record } = await start(t);
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const first = activated.payload.result.value;
			const restarted = await invoke("sessions:runtime-restart", [{
				sessionId: record.id,
				agentId: first.agentId,
				runtimeGeneration: first.runtimeGeneration,
			}]);
			assert.equal(restarted.payload.ok, true, JSON.stringify(restarted.payload));
			const second = restarted.payload.result.value.runtime;
			assert.equal(second.runtimeGeneration, first.runtimeGeneration + 1);

			const stale = await invoke("sessions:runtime-state", [{
				sessionId: record.id,
				agentId: first.agentId,
				runtimeGeneration: first.runtimeGeneration,
			}]);
			// A stale target is a command-level failure, not a transport failure: the
			// renderer distinguishes "re-activate" from "the RPC broke".
			assert.equal(stale.payload.ok, true, JSON.stringify(stale.payload));
			assert.equal(stale.payload.result.ok, false);
			assert.equal(stale.payload.result.error.code, "SESSION_RUNTIME_CHANGED");

			const current = await invoke("sessions:runtime-state", [{
				sessionId: record.id,
				agentId: second.agentId,
				runtimeGeneration: second.runtimeGeneration,
			}]);
			assert.equal(current.payload.ok, true, JSON.stringify(current.payload));
			assert.equal(current.payload.result.ok, true, JSON.stringify(current.payload));
		});

		test("two sessions keep independent runtimes and envelopes", async (t) => {
			const { invoke, fixture, fake, record } = await start(t, {
				scenario: { turns: [{ ack: true, events: textStream("first") }, { ack: true, events: textStream("second") }] },
			});
			const otherPath = writeSessionFile(fixture.sessions, projectPath, "second-session");
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const other = list.payload.result.find((entry) => slash(entry.filePath) === slash(otherPath));
			assert.ok(other);

			const a = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const b = (await invoke("sessions:runtime-activate", [other.id])).payload.result.value;
			assert.notEqual(a.agentId, b.agentId);
			assert.equal(b.runtimeGeneration, 1, "generations are per session");

			const list_ = await invoke("sessions:runtime-list");
			assert.equal(list_.payload.ok, true);
			const ids = list_.payload.result.map((entry) => entry.sessionId).sort();
			assert.deepEqual(ids, [record.id, other.id].sort());

			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "a", message: "one", agentId: a.agentId, runtimeGeneration: a.runtimeGeneration }]);
			await invoke("sessions:send-prompt", [{ sessionId: other.id, requestId: "b", message: "two", agentId: b.agentId, runtimeGeneration: b.runtimeGeneration }]);
			const prompts = fake.commands().filter((entry) => entry.command === "prompt").map((entry) => entry.payload.message);
			assert.deepEqual(prompts.sort(), ["one", "two"]);
		});

		test("anonymous sessions launch pi with --no-session and never write a file", async (t) => {
			const { invoke, fake, fixture } = await start(t);
			const created = await invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const record = created.payload.result.session;
			assert.equal(record.noSession, true);
			assert.equal(record.filePath ?? "", "");

			const before = readdirSync(fixture.sessions).sort();
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const info = activated.payload.result.value;
			assert.equal(info.sessionId, record.id);
			assert.equal(info.runtimeGeneration, 1);

			const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
			assert.ok(spawn, "pi must have been spawned");
			assert.ok(spawn.argv.includes("--no-session"), JSON.stringify(spawn.argv));
			assert.equal(spawn.argv.includes("--session"), false, JSON.stringify(spawn.argv));
			// An anonymous runtime is transient: no JSONL may appear in the sessions dir.
			assert.deepEqual(readdirSync(fixture.sessions).sort(), before);
		});

		test("activation publishes the initial transcript flush with the runtime identity", async (t) => {
			const { invoke, record, baseUrl, token } = await start(t, {
				scenario: {
					messages: [
						{ role: "user", content: [{ type: "text", text: "hello from disk" }] },
						{ role: "assistant", content: [{ type: "text", text: "hi from disk" }] },
					],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload).slice(0, 400));
			const target = activated.payload.result.value;

			// The projection loads before the runtime binding exists; the flush must still
			// reach the renderer, enveloped with the identity it now has.
			const deadline = Date.now() + 10_000;
			let delivered = null;
			while (Date.now() < deadline && !delivered) {
				for (const frame of sse.frames) {
					if (frame.payload.channel !== "sessions:runtime-event") continue;
					const event = frame.payload.args[0];
					if (event.sourceChannel !== "agents:message") continue;
					delivered = event;
				}
				if (!delivered) await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(delivered, "activation must publish the transcript flush");
			assert.equal(delivered.sessionId, record.id);
			assert.equal(delivered.agentId, target.agentId);
			assert.equal(delivered.runtimeGeneration, target.runtimeGeneration);
			const texts = delivered.payload.messages.map((row) => row.text);
			assert.ok(texts.includes("hello from disk"), JSON.stringify(texts));
			assert.ok(texts.includes("hi from disk"), JSON.stringify(texts));
			// Tool payloads are stripped for delivery: `meta.result` never reaches the renderer.
			assert.equal(delivered.payload.messages.some((row) => row.meta?.result !== undefined), false);
		});

		test("ui-response answers the pending ask and rejects an unknown request", async (t) => {
			const { invoke, fake, record, baseUrl, token } = await start(t, {
				scenario: {
					// The ask arrives mid-turn, exactly like a real pi tool asking the user.
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: { type: "extension_ui_request", id: "ask-1", method: "select", title: "Pick one", options: ["A", "B"] } },
						],
					}],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "ask-turn",
				message: "ask me",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			const uiFrame = await sse.waitFor((frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:ui-request");
			const uiRequest = uiFrame.payload.args[0];
			assert.equal(uiRequest.payload.requestId, "ask-1");
			assert.equal(uiRequest.payload.method, "select");
			assert.deepEqual(uiRequest.payload.options, ["A", "B"]);
			assert.equal(uiRequest.sessionId, record.id);

			const answered = await invoke("sessions:ui-response", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
				requestId: "ask-1",
				response: { value: "A" },
			}]);
			assert.equal(answered.payload.ok, true, JSON.stringify(answered.payload));
			// The desktop writes this frame without awaiting an ACK. Its RPC reply can
			// arrive before the separate pi process consumes stdin and records receipt.
			await waitFor(() => fake.commands().some((entry) => entry.command === "extension_ui_response"
				&& entry.payload.id === "ask-1"), 10_000, "pi receipt of the ask response");
			const uiResponses = fake.commands().filter((entry) => entry.command === "extension_ui_response");
			assert.equal(uiResponses.length, 1);
			assert.equal(uiResponses[0].payload.value, "A");

			const unknown = await invoke("sessions:ui-response", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
				requestId: "missing",
				response: { value: "A" },
			}]);
			assert.equal(unknown.payload.ok, true, JSON.stringify(unknown.payload));
			assert.equal(unknown.payload.result.ok, false);
			assert.equal(unknown.payload.result.error.code, "MESSAGE_NOT_FOUND");
		});

		test("commands, models, compact, export and clone reach pi and return its data", async (t) => {
			const { invoke, fake, record } = await start(t, {
				scenario: {
					models: [{ id: "claude-sonnet-4", provider: "anthropic", name: "Sonnet 4" }],
					commands: [{ name: "compact", description: "Compact" }],
					exportPath: "C:/tmp/export.html",
				},
			});
			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const args = [{ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration }];

			const commands = await invoke("sessions:runtime-commands", args);
			assert.equal(commands.payload.ok, true, JSON.stringify(commands.payload));
			assert.equal(commands.payload.result.value.value[0].name, "compact");

			const models = await invoke("sessions:runtime-list-models", args);
			assert.equal(models.payload.ok, true, JSON.stringify(models.payload));
			assert.equal(models.payload.result.value.value[0].id, "claude-sonnet-4");

			const compacted = await invoke("sessions:runtime-compact", [...args, "keep the plan"]);
			assert.equal(compacted.payload.ok, true, JSON.stringify(compacted.payload));
			const compactCommand = fake.commands().find((entry) => entry.command === "compact");
			assert.equal(compactCommand.payload.customInstructions, "keep the plan");

			const exported = await invoke("sessions:runtime-export-html", args);
			assert.equal(exported.payload.ok, true, JSON.stringify(exported.payload));
			assert.equal(exported.payload.result.value.value.path, "C:/tmp/export.html");

			const cloned = await invoke("sessions:runtime-clone", args);
			assert.equal(cloned.payload.ok, true, JSON.stringify(cloned.payload));
			assert.equal(cloned.payload.result.ok, true, JSON.stringify(cloned.payload));
			assert.ok(fake.commands().some((entry) => entry.command === "clone"));
			// Clone replaces the process identity: the previous generation is stale.
			const rebound = (await invoke("sessions:runtime-list")).payload.result[0];
			assert.equal(rebound.runtimeGeneration, target.runtimeGeneration + 1);
			const staleAfterClone = await invoke("sessions:runtime-state", args);
			assert.equal(staleAfterClone.payload.result.error.code, "SESSION_RUNTIME_CHANGED");

			const current = [{ sessionId: record.id, agentId: rebound.agentId, runtimeGeneration: rebound.runtimeGeneration }];
			const thinking = await invoke("sessions:runtime-set-thinking", [...current, "low"]);
			assert.equal(thinking.payload.result.ok, true, JSON.stringify(thinking.payload));
			const setThinking = fake.commands().filter((entry) => entry.command === "set_thinking_level");
			assert.equal(setThinking.at(-1).payload.level, "low");

			const model = await invoke("sessions:runtime-set-model", [...current, "anthropic", "claude-sonnet-4"]);
			assert.equal(model.payload.result.ok, true, JSON.stringify(model.payload));
			const setModel = fake.commands().filter((entry) => entry.command === "set_model");
			assert.equal(setModel.at(-1).payload.provider, "anthropic");
			assert.equal(setModel.at(-1).payload.modelId, "claude-sonnet-4");
		});

		test("runtime commands reject a malformed target at the channel boundary", async (t) => {
			const { invoke, record } = await start(t);
			const missing = await invoke("sessions:runtime-state", [{ sessionId: record.id }]);
			assert.equal(missing.payload.ok, false);
			assert.match(missing.payload.error.message, /agentId/);

			const unknown = await invoke("sessions:runtime-activate", ["not-a-session"]);
			assert.equal(unknown.payload.ok, true, JSON.stringify(unknown.payload));
			assert.equal(unknown.payload.result.ok, false);
			assert.equal(unknown.payload.result.error.code, "SESSION_NOT_FOUND");
		});

		test("stopping a runtime closes pi and detaches the session", async (t) => {
			const { invoke, fake, record, baseUrl, token } = await start(t);
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const stopped = await invoke("sessions:runtime-stop", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(stopped.payload.ok, true, JSON.stringify(stopped.payload));

			const detach = await sse.waitFor((frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].kind === "detach");
			assert.equal(detach.payload.args[0].sessionId, record.id);
			const list = await invoke("sessions:runtime-list");
			assert.deepEqual(list.payload.result, []);
			assert.ok(fake.readLog().length > 0);
		});

		// A review repro claimed `sessions:runtime-stop` can erase the runtime an in-flight
		// activation is still building, so `sessions:runtime-activate` never settles. The stop
		// channel cannot reach that process: `requireTarget` refuses any target whose session has
		// no binding (`RuntimeCoordinator.cpp`), and an activation binds only in its last step,
		// so while it is pending no client-supplied agent id addresses it and `forgetAgent` is
		// unreachable from this path. This pins both halves: the stop is refused while
		// `get_messages` is still outstanding, and the activation then settles by itself.
		test("a stop cannot erase the runtime an in-flight activation is still building", async (t) => {
			const { invoke, fake, record } = await start(t, {
				// Object form applies to this spawn only, so the activation is provably mid-flight
				// when the stop is attempted instead of having quietly finished first.
				scenario: { responses: { get_messages: { delayMs: 1_200, data: { messages: [] } } } },
			});
			const pending = invoke("sessions:runtime-activate", [record.id]);
			// Wait until pi really received the projection load: past `get_state`, still unbound.
			const deadline = Date.now() + 5_000;
			while (!fake.commands().some((entry) => entry.command === "get_messages")) {
				if (Date.now() > deadline) assert.fail("the activation never asked pi for the projection");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			const unknownAgentId = "00000000-0000-4000-8000-000000000000";
			const refused = await invoke("sessions:runtime-stop", [{
				sessionId: record.id,
				agentId: unknownAgentId,
				runtimeGeneration: 1,
			}]);
			assert.equal(refused.payload.ok, true, JSON.stringify(refused.payload));
			assert.equal(refused.payload.result.ok, false, JSON.stringify(refused.payload.result));
			// Unbound target, so the refusal happens before any agent identity is considered.
			assert.equal(refused.payload.result.error.code, "SESSION_RUNTIME_UNAVAILABLE");

			let stallTimer = null;
			t.after(() => clearTimeout(stallTimer));
			const settled = await Promise.race([
				pending,
				new Promise((resolve) => {
					stallTimer = setTimeout(() => resolve({ stalled: true }), 20_000);
				}),
			]);
			assert.equal(settled.stalled, undefined, "the activation must settle on its own");
			assert.equal(settled.payload.ok, true, JSON.stringify(settled.payload));
			const info = settled.payload.result.value;
			assert.equal(info.sessionId, record.id);
			assert.notEqual(info.agentId, unknownAgentId, "the refused stop must not be the bound runtime");

			const list = await invoke("sessions:runtime-list");
			assert.deepEqual(list.payload.result.map((entry) => entry.sessionId), [record.id]);
		});

		test("a clean pi exit reconnects the same runtime once instead of closing it", async (t) => {
			const { invoke, baseUrl, token, record } = await start(t, {
				scenario: {
					turns: [
						{ ack: true, events: textStream("first"), exitCleanlyAfterTurn: true },
						{ ack: true, events: textStream("second") },
					],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "req-clean-exit",
				message: "one",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			// Oracle `handleProcessExit`: code 0 + a session file == pi restarting itself, so the
			// runtime reconnects under the same identity instead of detaching.
			const deadline = Date.now() + 15_000;
			let listing = [];
			while (Date.now() < deadline) {
				listing = (await invoke("sessions:runtime-list")).payload.result ?? [];
				if (listing.some((runtimeEntry) => runtimeEntry.status === "idle"
					&& runtimeEntry.agentId === target.agentId)) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const entry = listing.find((runtimeEntry) => runtimeEntry.sessionId === record.id);
			assert.ok(entry, JSON.stringify(listing));
			assert.equal(entry.agentId, target.agentId, "the renderer target must stay valid");
			assert.equal(entry.runtimeGeneration, target.runtimeGeneration);
			assert.equal(entry.status, "idle");
			assert.equal(
				sse.frames.some((frame) => frame.payload.channel === "sessions:runtime-event"
					&& frame.payload.args[0].kind === "detach"),
				false,
				"a clean restart must not detach the session",
			);

			// The reconnect appends the localized row only after its history reload, so wait
			// for that frame instead of assuming the order (idle is set before the reload).
			const rowDeadline = Date.now() + 10_000;
			let sawReconnectRow = false;
			while (Date.now() < rowDeadline && !sawReconnectRow) {
				sawReconnectRow = sse.frames.some((frame) => frame.payload.channel === "sessions:runtime-event"
					&& frame.payload.args[0].sourceChannel === "agents:message"
					&& JSON.stringify(frame.payload.args[0].payload).includes("reconnected automatically"));
				if (!sawReconnectRow) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(sawReconnectRow, true, "the reconnect must post its localized diagnostic row");

			// The replacement process really serves the next prompt.
			const again = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "req-after-clean-exit",
				message: "two",
				agentId: entry.agentId,
				runtimeGeneration: entry.runtimeGeneration,
			}]);
			assert.equal(again.payload.ok, true, JSON.stringify(again.payload));
			assert.equal(again.payload.result.accepted, true);
		});

		test("the session file is the only state owner: activation reads history from disk", async (t) => {
			const { invoke, record, filePath } = await start(t);
			await invoke("sessions:runtime-activate", [record.id]);
			// The runtime must not rewrite the session file just by activating it.
			const before_ = readFileSync(filePath, "utf8");
			const state = await invoke("sessions:runtime-state", [{
				sessionId: record.id,
				agentId: (await invoke("sessions:runtime-list")).payload.result[0].agentId,
				runtimeGeneration: 1,
			}]);
			assert.equal(state.payload.ok, true, JSON.stringify(state.payload));
			// The channel is typed `SessionTargetedValue<AgentRuntimeState>` in desktopApi, so it
			// must carry the projection, not pi's raw `get_state` data.
			const runtimeState = state.payload.result.value.value;
			assert.equal(runtimeState.modelName, "claude-sonnet-4");
			assert.equal(runtimeState.provider, "anthropic");
			assert.equal(runtimeState.modelId, "claude-sonnet-4");
			assert.equal(runtimeState.thinkingLevel, "high");
			assert.equal(runtimeState.isStreaming, false);
			assert.equal("sessionFile" in runtimeState, false, `raw pi state leaked: ${JSON.stringify(runtimeState)}`);
			assert.equal("sessionId" in runtimeState, false, `raw pi state leaked: ${JSON.stringify(runtimeState)}`);
			assert.equal(readFileSync(filePath, "utf8"), before_);
		});
	});
}
