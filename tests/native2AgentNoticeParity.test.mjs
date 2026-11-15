import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * `agents:notice` parity: classification, payload, runtime identity and escalation.
 *
 * The oracle is `src/main/pi/AgentManager.ts` (`abort`, `escalateAbortIfStillRunning`)
 * + `src/main/backend/createBackend.ts` (`onThinkingLevelAdjusted`) +
 * `src/main/backend/sessionRuntimeBridge.ts` (`emitSessionNotice`) +
 * `src/renderer/src/hooks/useSessionRuntimeBridge.ts` (toast consumption).
 *
 * There are exactly three producers at HEAD e978ad8a:
 *  1. abort accepted            → `app.abortRequested`, info, 2500 ms
 *  2. abort escalation exhausted → `app.abortSlow`, warning, 6000 ms
 *  3. persisted thinking level clamped → `app.thinkingUnsupported`, info, 4000 ms
 * Everything else (prompt/transport/session errors) stays a timeline `error` row; this
 * suite asserts that no notice is invented for those paths and that no pi error text
 * ever reaches a toast (the notice shape has no `debugDetails` field).
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-notice";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal pi session file: header, optional model/thinking change, one user turn. */
function writeSessionFile(sessionsDir, projectPath, name, { provider = "anthropic", modelId = "claude-opus-4", thinkingLevel = "" } = {}) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider, modelId },
	];
	if (thinkingLevel) {
		entries.push({ type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-01-01T00:00:00.500Z", thinkingLevel });
	}
	entries.push({
		type: "message",
		id: "u1",
		parentId: thinkingLevel ? "t1" : "m1",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
	});
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

/** `~/.pi/agent/models.json` with the given per-model thinking-level declarations. */
function writeModelsJson(home, models) {
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { anthropic: { models } } }),
	);
}

/** Every `agents:notice` envelope the renderer received, in arrival order. */
const noticeEvents = (sse) => sse.frames
	.filter((frame) => frame.payload.channel === "sessions:runtime-event")
	.map((frame) => frame.payload.args[0])
	.filter((event) => event.sourceChannel === "agents:notice");

const noticeWaiter = (sse, predicate = () => true) => (frame) => frame.payload.channel === "sessions:runtime-event"
	&& frame.payload.args[0].sourceChannel === "agents:notice"
	&& predicate(frame.payload.args[0]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!executable) {
	describe("native2 agents:notice parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 agents:notice parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-notice-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * Start a backend on the scriptable fake pi and import one session.
		 *
		 * `home` is the fake `PIDECK_HOME`; `~/.pi/agent/models.json` is read from there,
		 * which is the same file the Node oracle's `resolveModelThinkingSupport` reads.
		 */
		const start = async (t, { scenario = {}, file = {}, models = null } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					const home = join(fixture.root, "home");
					mkdirSync(home, { recursive: true });
					if (models) writeModelsJson(home, models);
					// `honorThinkingLevel` makes the fake report back the level it accepted, which
					// is what pi does and what the clamp/notice decisions are derived from.
					fake = createFakePi(fixture, { honorThinkingLevel: true, ...scenario });
					return {
						settings: { customPiPath: fake.shim },
						env: {
							PIDECK_HOME: home,
							PIDECK_HOST_HOME: home,
							FAKE_PI_SCENARIO: fake.scenarioPath,
							FAKE_PI_LOG: fake.logPath,
						},
					};
				},
			});
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, `s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, file);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			return { ...session, fake, record, filePath };
		};

		const sseFor = (t, { baseUrl, token }) => {
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			// Subscribe before the runtime exists: the notice must not be lost.
			const connected = sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			return { sse, connected };
		};

		const targetOf = (record, target) => ({
			sessionId: record.id,
			agentId: target.agentId,
			runtimeGeneration: target.runtimeGeneration,
		});

		test("abort emits the exact app.abortRequested toast with the bound runtime identity", async (t) => {
			const { invoke, fake, record, baseUrl, token } = await start(t, {
				// pi stops promptly: the escalation must find `isStreaming:false` and stay silent.
				scenario: { responses: { get_state: [{ data: { sessionId: "pi-notice", sessionFile: "", sessionName: "", model: { provider: "anthropic", id: "claude-opus-4" }, thinkingLevel: "high", isStreaming: false } }] } },
			});
			const { sse, connected } = sseFor(t, { baseUrl, token });
			await connected;

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;
			assert.equal(target.runtimeGeneration, 1);

			const aborted = await invoke("sessions:runtime-abort", [targetOf(record, target)]);
			assert.equal(aborted.payload.result.ok, true, JSON.stringify(aborted.payload));

			const frame = await sse.waitFor(noticeWaiter(sse));
			const event = frame.payload.args[0];
			// Runtime identity: the toast is scoped to the session and the live generation.
			assert.equal(event.kind, "event");
			assert.equal(event.sessionId, record.id);
			assert.equal(event.agentId, target.agentId);
			assert.equal(event.runtimeGeneration, target.runtimeGeneration);
			// Payload is exactly the oracle's: copy key, fallback text, severity, lifetime.
			assert.deepEqual(event.payload, {
				agentId: target.agentId,
				message: "已请求停止当前响应",
				i18nKey: "app.abortRequested",
				kind: "info",
				duration: 2500,
			});

			// Escalation window (1.5 s settle fallback + 4 s verify) passes silently.
			await delay(2_200);
			assert.deepEqual(noticeEvents(sse).filter((entry) => entry.payload.kind === "warning"), []);
			assert.equal(fake.commands().some((entry) => entry.command === "abort_bash"), false,
				"a pi that answered the abort must not be escalated");
			assert.equal(noticeEvents(sse).length, 1, "abort emits exactly one toast");
			// `agentRendererOutput.ts`: the channel is enveloped only, never sent raw.
			assert.deepEqual(
				sse.frames.filter((frame) => frame.payload.channel === "agents:notice"),
				[],
				"agents:notice must not be broadcast outside the session envelope",
			);
		});

		test("a pi that keeps streaming is escalated with abort_bash and warns once", async (t) => {
			const stopped = { sessionId: "pi-notice", sessionFile: "", sessionName: "", model: { provider: "anthropic", id: "claude-opus-4" }, thinkingLevel: "high", isStreaming: false };
			const stuck = { ...stopped, isStreaming: true };
			const { invoke, fake, record, baseUrl, token } = await start(t, {
				// get_state calls: 1) activation 2) the post-bind runtime-state push
				// 3) the escalation probe → only the last one sees a blocked pi.
				scenario: { responses: { get_state: [{ data: stopped }, { data: stopped }, { data: stuck }] } },
			});
			const { sse, connected } = sseFor(t, { baseUrl, token });
			await connected;

			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const aborted = await invoke("sessions:runtime-abort", [targetOf(record, target)]);
			assert.equal(aborted.payload.result.ok, true, JSON.stringify(aborted.payload));

			await sse.waitFor(noticeWaiter(sse, (event) => event.payload.i18nKey === "app.abortRequested"));
			// The warning only arrives after the second abort + verify window (~5.5 s).
			const warning = await sse.waitFor(
				noticeWaiter(sse, (event) => event.payload.i18nKey === "app.abortSlow"),
				15_000,
			);
			const event = warning.payload.args[0];
			assert.equal(event.sessionId, record.id);
			assert.equal(event.agentId, target.agentId);
			assert.equal(event.runtimeGeneration, target.runtimeGeneration);
			assert.deepEqual(event.payload, {
				agentId: target.agentId,
				message: "停止响应较慢，可尝试重启会话",
				i18nKey: "app.abortSlow",
				kind: "warning",
				duration: 6000,
			});

			const commands = fake.commands().map((entry) => entry.command);
			assert.ok(commands.includes("abort_bash"), JSON.stringify(commands));
			assert.equal(commands.filter((name) => name === "abort").length, 2, "the escalation re-sends abort once");
			assert.equal(commands.filter((name) => name === "abort_bash").length, 1);
			// The escalation probe runs before the kill attempt.
			assert.ok(commands.indexOf("abort_bash") > commands.indexOf("abort"));
		});

		test("activation clamps an unsupported thinking level and toasts once with generation 0", async (t) => {
			const { invoke, fake, record, baseUrl, token } = await start(t, {
				file: { modelId: "claude-sonnet-4", thinkingLevel: "xhigh" },
				// The persisted model declares `max` but not `xhigh`.
				models: [{ id: "claude-sonnet-4", thinkingLevelMap: { max: "max" } }],
			});
			const { sse, connected } = sseFor(t, { baseUrl, token });
			await connected;

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const event = (await sse.waitFor(noticeWaiter(sse))).payload.args[0];
			assert.equal(event.sessionId, record.id);
			// applyPreferences runs before `bind`, so the oracle's emitSessionNotice sends 0.
			assert.equal(event.runtimeGeneration, 0);
			assert.deepEqual(event.payload, {
				agentId: event.agentId,
				i18nKey: "app.thinkingUnsupported",
				i18nParams: { level: "xhigh", fallback: "high" },
				kind: "info",
				duration: 4000,
			});

			const thinking = fake.commands().filter((entry) => entry.command === "set_thinking_level");
			assert.equal(thinking.length, 1);
			assert.equal(thinking[0].payload.level, "high", "the clamped level is the one sent to pi");

			// The stored preference follows pi: the picker must not show xhigh again.
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const stored = list.payload.result.find((entry) => entry.id === record.id);
			assert.equal(stored.thinkingLevel, "high");
			await delay(300);
			assert.equal(noticeEvents(sse).length, 1, "the clamp is announced exactly once");
		});

		test("a model switch clamps the stored extended level and toasts with the live generation", async (t) => {
			const { invoke, fake, record, baseUrl, token } = await start(t, {
				file: { modelId: "claude-opus-4", thinkingLevel: "xhigh" },
				models: [
					{ id: "claude-opus-4", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
					// Target model: no extended level declared at all.
					{ id: "claude-sonnet-4", thinkingLevelMap: {} },
				],
			});
			const { sse, connected } = sseFor(t, { baseUrl, token });
			await connected;

			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			await delay(300);
			assert.deepEqual(noticeEvents(sse), [], "a supported level must not be announced");

			const switched = await invoke("sessions:runtime-set-model", [targetOf(record, target), "anthropic", "claude-sonnet-4"]);
			assert.equal(switched.payload.result.ok, true, JSON.stringify(switched.payload));

			const event = (await sse.waitFor(noticeWaiter(sse))).payload.args[0];
			assert.equal(event.sessionId, record.id);
			assert.equal(event.agentId, target.agentId);
			assert.equal(event.runtimeGeneration, target.runtimeGeneration);
			assert.deepEqual(event.payload.i18nParams, { level: "xhigh", fallback: "high" });
			assert.equal(event.payload.i18nKey, "app.thinkingUnsupported");
			assert.equal(event.payload.kind, "info");
			assert.equal(event.payload.duration, 4000);

			const levels = fake.commands().filter((entry) => entry.command === "set_thinking_level").map((entry) => entry.payload.level);
			assert.deepEqual(levels, ["xhigh", "high"], "activation applies the stored level, the switch clamps it");
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const stored = list.payload.result.find((entry) => entry.id === record.id);
			assert.equal(stored.thinkingLevel, "high");
			assert.equal(stored.model.modelId, "claude-sonnet-4");
		});

		test("a replaced runtime never escalates: the old generation's timer is fenced", async (t) => {
			const stopped = { sessionId: "pi-notice", sessionFile: "", sessionName: "", model: { provider: "anthropic", id: "claude-opus-4" }, thinkingLevel: "high", isStreaming: false };
			const stuck = { ...stopped, isStreaming: true };
			const { invoke, fake, record, baseUrl, token } = await start(t, {
				scenario: { responses: { get_state: [{ data: stopped }, { data: stuck }] } },
			});
			const { sse, connected } = sseFor(t, { baseUrl, token });
			await connected;

			const first = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			await invoke("sessions:runtime-abort", [targetOf(record, first)]);
			// Replace the runtime well inside the 1.5 s escalation window: the blocked pi of
			// generation 1 must not be probed, killed or announced for generation 2.
			const stoppedResult = await invoke("sessions:runtime-stop", [targetOf(record, first)]);
			assert.equal(stoppedResult.payload.ok, true, JSON.stringify(stoppedResult.payload));
			const second = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			assert.equal(second.runtimeGeneration, first.runtimeGeneration + 1);
			assert.notEqual(second.agentId, first.agentId);

			await delay(6_500);
			const notices = noticeEvents(sse);
			assert.deepEqual(notices.filter((entry) => entry.payload.kind === "warning"), []);
			assert.deepEqual(notices.filter((entry) => entry.agentId === first.agentId).map((entry) => entry.payload.i18nKey), ["app.abortRequested"]);
			assert.equal(fake.commands().some((entry) => entry.command === "abort_bash"), false,
				"a stale generation must never send abort_bash");
			// The new runtime is alive and untouched by the old escalation.
			const list = await invoke("sessions:runtime-list");
			assert.equal(slash(list.payload.result[0]?.sessionId ?? ""), slash(record.id));
		});

		test("normal turns and prompt failures emit no notice (errors stay timeline rows)", async (t) => {
			const SECRET = "sk-live-NOTICE-SECRET-9137";
			const { invoke, record, baseUrl, token } = await start(t, {
				scenario: {
					turns: [
						{
							ack: true,
							events: [
								{ event: { type: "agent_start" } },
								{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
								{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } } },
								{ event: { type: "agent_end", messages: [] } },
								{ event: { type: "agent_settled" } },
							],
						},
						{ ack: false, error: `provider exploded: api_key=${SECRET}` },
					],
				},
			});
			const { sse, connected } = sseFor(t, { baseUrl, token });
			await connected;

			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const first = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "notice-ok",
				message: "hi",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(first.payload.result.accepted, true, JSON.stringify(first.payload));
			await sse.waitFor((frame) => frame.payload.channel === "agents:state"
				&& frame.payload.args[0].some?.((tab) => tab.id === target.agentId && tab.status === "idle"), 15_000).catch(() => undefined);

			const rejected = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "notice-fail",
				message: "boom",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(rejected.payload.result.accepted, false, JSON.stringify(rejected.payload));
			assert.equal(rejected.payload.result.i18nKey, "diagnostic.promptRejected");
			assert.match(rejected.payload.result.debugDetails, new RegExp(SECRET));

			await delay(500);
			assert.deepEqual(noticeEvents(sse), [], "no notice may be emitted for turns or prompt failures");
			assert.equal(JSON.stringify(noticeEvents(sse)).includes(SECRET), false,
				"a pi error string must never reach a toast");
		});

		test("the notice copy keys exist in both renderer locales", () => {
			const zh = readFileSync(join(process.cwd(), "src/renderer/src/i18n/rendererCopy.zh-CN.ts"), "utf8");
			const en = readFileSync(join(process.cwd(), "src/renderer/src/i18n/rendererCopy.en-US.ts"), "utf8");
			for (const key of ["app.abortRequested", "app.abortSlow", "app.thinkingUnsupported"]) {
				assert.match(zh, new RegExp(`"${key.replaceAll(".", "\\.")}"`), `zh-CN copy for ${key}`);
				assert.match(en, new RegExp(`"${key.replaceAll(".", "\\.")}"`), `en-US copy for ${key}`);
			}
			// The thinking copy needs both params; a missing placeholder renders literally.
			for (const [locale, source] of [["zh-CN", zh], ["en-US", en]]) {
				const at = source.indexOf('"app.thinkingUnsupported"');
				assert.ok(at >= 0, `${locale} must define app.thinkingUnsupported`);
				// The en-US copy wraps onto the next line, so inspect a short window.
				const window = source.slice(at, at + 160);
				assert.ok(window.includes("{level}") && window.includes("{fallback}"), `${locale}: ${window}`);
			}
		});
	});
}
