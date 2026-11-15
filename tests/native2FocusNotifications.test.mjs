import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	FakeHost,
	SseClient,
	backendEnvFor,
	createBackendFixture,
	createFakePi,
	resolveBackendExecutable,
	rpc,
	spawnBackend,
	startBackendSession,
	waitForRendererReady,
} from "./helpers/native2BackendHarness.mjs";

// Focus targets, desktop notifications and the version-isolated single instance.
//
// Everything here drives a real `PiDeckBackend.exe` through the real wire protocols
// (host bridge frames + renderer loopback RPC/SSE). The oracle is
// src/main/singleInstance.ts + src/main/utils/focusTarget.ts +
// src/native-node/host/NativeBackendHost.ts + src/native-node/platform/NativeNotifications.ts
// + AgentManager.notifySessionEnd, so the assertions are about observable behaviour:
// which frames/events the renderer and the host see, and what the second process exits
// with.

const executable = resolveBackendExecutable();
const VERSION = "0.4.3";
const RECORD_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_RECORD_ID = "22222222-3333-4444-5555-666666666666";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const clipboardHandler = () => ({
	result: { text: "", html: "", filePaths: [], hasImage: false, sequence: 0 },
});

function readLockFiles(userData) {
	const directory = join(userData, "instance-locks");
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((name) => name.endsWith(".lock"))
		.sort();
}

/** Isolated directory that is always removed, even when an assertion fails. */
function createFixture(t, options = {}) {
	const fixture = createBackendFixture(options);
	t.after(() => rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	return fixture;
}

/**
 * One scratch root for every project directory this file needs.
 *
 * It is removed once, after the last test, so a still-running backend reports a genuine
 * leak instead of racing a per-test cleanup that would mask the assertion.
 */
let scratchRoot = "";
before(() => {
	scratchRoot = mkdtempSync(join(tmpdir(), "pideck-native2-focus-"));
});
after(() => {
	if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function projectDirectory(label) {
	const directory = join(scratchRoot, `${label}-${Math.random().toString(16).slice(2, 8)}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

/**
 * Start one backend against its own fake Qt host.
 *
 * A helper (not `startBackendSession`) is needed because a secondary process is not
 * expected to become a renderer host at all.
 */
async function spawnInstance(t, { fixture, argv = [], version = VERSION, handlers = {}, expectReady = true }) {
	const host = new FakeHost({
		token: `focus-token-${Math.random().toString(16).slice(2)}`,
		handlers: {
			"clipboard.metadataSnapshot": clipboardHandler,
			"application.exitSecondary": () => ({ result: null }),
			...handlers,
		},
	});
	const hostPort = await host.start();
	const process_ = spawnBackend({
		executable,
		hostPort,
		token: host.token,
		env: backendEnvFor(fixture, {
			PIDECK_VERSION: version,
			PIDECK_ARGV_JSON: JSON.stringify(["PiDeck-Q.exe", ...argv]),
		}),
	});
	t.after(async () => {
		if (process_.child.exitCode === null) process_.child.kill();
		await host.stop();
	});
	const ready = expectReady ? await waitForRendererReady(host) : null;
	return {
		host,
		backend: process_,
		ready,
		invoke: (channel, args = []) => rpc(ready.url, ready.token, channel, args),
	};
}

function startSse(t, ready) {
	const sse = new SseClient(`${ready.url}__pideck/events?token=${encodeURIComponent(ready.token)}`);
	t.after(() => sse.close());
	return sse;
}

const channelFrames = (sse, channel) => sse.frames
	.map((frame) => frame.payload)
	.filter((payload) => payload.channel === channel);

const hostMethods = (host, prefix) => host.requests
	.map((request) => request.method)
	.filter((method) => method.startsWith(prefix));

/**
 * Wait for a process to exit, but fail with context instead of hanging.
 * A secondary that silently became a primary never exits, and a 60 s test timeout hides
 * which invariant broke.
 */
async function exitWithin(process_, timeoutMs = 15_000) {
	const outcome = await Promise.race([
		process_.exited,
		new Promise((resolve) => setTimeout(() => resolve({ code: "no-exit", stderr: process_.output.stderr }), timeoutMs)),
	]);
	assert.notEqual(outcome.code, "no-exit", `process did not exit within ${timeoutMs}ms: ${outcome.stderr}`);
	return outcome;
}

if (executable) {
	describe("native2 single instance + focus target", () => {
		test("a secondary launch forwards its argv, exits 0, and the primary delivers the target", async (t) => {
			const session = await startBackendSession(t, {});
			const sse = startSse(t, session.ready);
			await sse.connect();
			// A visible window is what makes the oracle push a live frame *and* keep the
			// pullable copy.
			session.host.emit("window.ready");
			await sse.waitFor("native.eventChannelReady").catch(() => undefined);

			const secondary = await spawnInstance(t, {
				fixture: session.fixture,
				argv: [`pideck://session/${RECORD_ID}`],
				expectReady: false,
			});
			const exit = await exitWithin(secondary.backend);
			assert.equal(exit.code, 0, `secondary must exit cleanly: ${exit.stderr}`);
			assert.match(exit.stderr, /delivered=1/, "the primary must ACK the forwarded payload");
			// A secondary launch is only a launch attempt: it must not create a second
			// renderer (or touch the user's catalog) for the same profile.
			assert.equal(
				secondary.host.frames.some((frame) => frame.type === "event" && frame.name === "renderer.ready"),
				false,
				"a secondary instance must not announce a renderer",
			);
			assert.deepEqual(
				secondary.host.requests.map((request) => request.method),
				["application.exitSecondary"],
				"the secondary asks its own host to quit instead of looking like a crash",
			);

			const frame = await sse.waitFor("app:focus-session-target");
			const target = frame.payload.args[0];
			assert.equal(target.sessionId, RECORD_ID);
			assert.match(target.id, UUID_PATTERN);
			// The window requests are written before the frame is pushed; waiting for both
			// keeps the assertion about `window.*` order and not about socket parse timing.
			await session.host.waitForRequest("window.focus");
			assert.deepEqual(
				hostMethods(session.host, "window."),
				["window.show", "window.focus"],
				"a secondary launch restores the primary window",
			);

			// The pull path returns the same object and does not consume it.
			const pulled = await session.invoke("app:get-focus-target-pending");
			assert.equal(pulled.payload.ok, true, JSON.stringify(pulled.payload));
			assert.deepEqual(pulled.payload.result, target);
			assert.deepEqual((await session.invoke("app:get-focus-target-pending")).payload.result, target);
		});

		test("an ACK clears only the handled id; a stale ACK never drops a newer target", async (t) => {
			const session = await startBackendSession(t, {});
			session.host.emit("window.ready");

			const firstSecondary = await spawnInstance(t, {
				fixture: session.fixture,
				argv: [`pideck://session/${RECORD_ID}`],
				expectReady: false,
			});
			assert.equal((await exitWithin(firstSecondary.backend)).code, 0);
			const first = (await session.invoke("app:get-focus-target-pending")).payload.result;
			assert.equal(first.sessionId, RECORD_ID);

			// A newer notification supersedes the pending target with a fresh id.
			const secondSecondary = await spawnInstance(t, {
				fixture: session.fixture,
				argv: [`pideck://session/${OTHER_RECORD_ID}`],
				expectReady: false,
			});
			assert.equal((await exitWithin(secondSecondary.backend)).code, 0);
			const second = (await session.invoke("app:get-focus-target-pending")).payload.result;
			assert.equal(second.sessionId, OTHER_RECORD_ID);
			assert.notEqual(second.id, first.id);

			// Renderer input is untrusted: a non-string, empty or oversized id must not reach
			// the pending-target owner (the oracle silently ignores it).
			for (const bad of [42, "", "x".repeat(129), null]) {
				const ignored = await session.invoke("app:ack-focus-target", [bad]);
				assert.equal(ignored.payload.ok, true, JSON.stringify(ignored.payload));
			}
			// A late ACK for the older target must not clear the newer one.
			await session.invoke("app:ack-focus-target", [first.id]);
			assert.deepEqual((await session.invoke("app:get-focus-target-pending")).payload.result, second);

			await session.invoke("app:ack-focus-target", [second.id]);
			assert.equal((await session.invoke("app:get-focus-target-pending")).payload.result, null);
			// Repeated ACKs are idempotent, not an error.
			const repeated = await session.invoke("app:ack-focus-target", [second.id]);
			assert.equal(repeated.payload.ok, true);
			assert.equal((await session.invoke("app:get-focus-target-pending")).payload.result, null);
		});

		test("a legacy pideck://agent link resolves through the live runtime binding", async (t) => {
			const projectPath = projectDirectory("agent");
			// Activation spawns pi, so the case needs the scripted fake (the desktop must not
			// depend on a real pi install being present on the test machine).
			const session = await startBackendSession(t, {
				projects: [{ id: "focus", path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					const fake = createFakePi(fixture, {});
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			writeSessionFile(session.fixture.sessions, projectPath, "session-agent");
			const list = await session.invoke("sessions:catalog-list", ["focus"]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => String(entry.filePath).includes("session-agent"));
			assert.ok(record, JSON.stringify(list.payload.result));
			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const agentId = activated.payload.result.value.agentId;
			session.host.emit("window.ready");

			const secondary = await spawnInstance(t, {
				fixture: session.fixture,
				argv: [`pideck://agent/${agentId}`],
				expectReady: false,
			});
			assert.equal((await exitWithin(secondary.backend)).code, 0);
			// The renderer indexes sessions by the stable record id, so the agent id must be
			// resolved before it is queued — a pi session id would silently never match.
			const target = (await session.invoke("app:get-focus-target-pending")).payload.result;
			assert.equal(target.sessionId, record.id);
		});

		test("an unresolvable legacy agent link only restores the window and is reported", async (t) => {
			const session = await startBackendSession(t, {});
			session.host.emit("window.ready");
			const secondary = await spawnInstance(t, {
				fixture: session.fixture,
				argv: [`pideck://agent/${OTHER_RECORD_ID}`],
				expectReady: false,
			});
			assert.equal((await exitWithin(secondary.backend)).code, 0);
			// No agent owns that id, so inventing a pending target would leave a jump the
			// renderer can never resolve. The window still comes back, and the drop is logged.
			await session.host.waitForRequest("window.focus");
			assert.equal((await session.invoke("app:get-focus-target-pending")).payload.result, null);
			const logged = await waitForLog(session, "Focus request target is not bound to a session");
			assert.equal(logged.level, "warn");
			assert.equal(logged.detail.agentId, OTHER_RECORD_ID);
		});

		test("another version never joins this version's instance and keeps its own lock", async (t) => {
			const fixture = createFixture(t, {});
			const first = await spawnInstance(t, { fixture });
			assert.deepEqual(readLockFiles(fixture.userData), [`${VERSION}.lock`]);
			const firstSse = startSse(t, first.ready);
			await firstSse.connect();
			first.host.emit("window.ready");

			// Same user data, different version: a separate claim, lock and endpoint.
			const other = await spawnInstance(t, {
				fixture,
				version: "9.9.9",
				argv: [`pideck://session/${RECORD_ID}`],
			});
			assert.ok(other.ready?.url, "the other version must start as its own primary");
			assert.deepEqual(readLockFiles(fixture.userData), [`${VERSION}.lock`, "9.9.9.lock"]);
			assert.equal(
				other.host.requests.some((request) => request.method === "application.exitSecondary"),
				false,
				"a version mismatch must not be forwarded to the other instance",
			);

			assert.equal((await first.invoke("app:get-focus-target-pending")).payload.result, null);
			assert.deepEqual(channelFrames(firstSse, "app:focus-session-target"), [], "no focus frame may cross versions");

			// A clean shutdown of the 9.9.9 instance removes only its own lock.
			other.host.emit("application.prepareQuit");
			assert.equal((await exitWithin(other.backend)).code, 0);
			assert.deepEqual(readLockFiles(fixture.userData), [`${VERSION}.lock`]);

			first.host.emit("application.prepareQuit");
			assert.equal((await exitWithin(first.backend)).code, 0);
			assert.deepEqual(readLockFiles(fixture.userData), []);
		});

		test("clean shutdown releases the lock so the next launch can be primary", async (t) => {
			const fixture = createFixture(t, {});
			const first = await spawnInstance(t, { fixture });
			assert.deepEqual(readLockFiles(fixture.userData), [`${VERSION}.lock`]);
			first.host.emit("application.prepareQuit");
			const exit = await exitWithin(first.backend);
			assert.equal(exit.code, 0);
			assert.deepEqual(readLockFiles(fixture.userData), [], "quit must release the version lock");

			// The endpoint is gone too: the next launch claims it instead of forwarding.
			const again = await spawnInstance(t, { fixture, argv: [`pideck://session/${RECORD_ID}`] });
			assert.ok(again.ready?.url);
			assert.deepEqual(readLockFiles(fixture.userData), [`${VERSION}.lock`]);
			assert.equal(
				again.host.requests.some((request) => request.method === "application.exitSecondary"),
				false,
				"a released lock must not make the next launch secondary",
			);
			// This process's own argv is a protocol activation, so the target is queued.
			const pending = (await again.invoke("app:get-focus-target-pending")).payload.result;
			assert.equal(pending.sessionId, RECORD_ID);
		});
	});

	describe("native2 notification producer", () => {
		test("a completed turn shows a toast that jumps to the stable session id", async (t) => {
			const { session, record } = await startCompletedTurn(t);
			const shown = await session.host.waitForRequest("notification.show");
			assert.match(shown.params.id, /^notification-\d+$/);
			assert.equal(shown.params.title, "PiDeck-Q");
			// The localized body uses the live tab title (copied from the catalog record).
			assert.equal(shown.params.body, `${record.title} completed its response`);
			assert.equal(shown.params.silent, false);
			// The activation URL must carry the catalog record id (what the renderer indexes),
			// never the pi session id.
			assert.equal(shown.params.activationUrl, `pideck://session/${record.id}`);

			const sse = startSse(t, session.ready);
			await sse.connect();
			session.host.emit("window.ready");
			session.host.emit("notification.clicked", { id: shown.params.id });

			const frame = await sse.waitFor("app:focus-session-target");
			assert.equal(frame.payload.args[0].sessionId, record.id);
			await session.host.waitForRequest("window.focus");
			assert.deepEqual(hostMethods(session.host, "window."), ["window.show", "window.focus"]);
			const pending = (await session.invoke("app:get-focus-target-pending")).payload.result;
			assert.equal(pending.sessionId, record.id);

			// Dismissal releases the callback: a later click on the same id does nothing.
			session.host.emit("notification.dismissed", { id: shown.params.id });
			await new Promise((resolve) => setTimeout(resolve, 150));
			await session.invoke("app:ack-focus-target", [pending.id]);
			const focusedBefore = hostMethods(session.host, "window.focus").length;
			session.host.emit("notification.clicked", { id: shown.params.id });
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(hostMethods(session.host, "window.focus").length, focusedBefore);
			assert.equal((await session.invoke("app:get-focus-target-pending")).payload.result, null);
		});

		test("the completion gate suppresses disabled notifications and aborted turns", async (t) => {
			// `enableNotifications: false` is the user's switch: no toast at all.
			const disabled = await startCompletedTurn(t, { settings: { enableNotifications: false } });
			await settleQuietly(disabled);
			assert.equal(
				disabled.session.host.requests.some((request) => request.method === "notification.show"),
				false,
				"a disabled notification setting must not reach the host",
			);

			// A user abort is not a completion: the abort's settled event must not notify.
			const aborted = await startCompletedTurn(t, { abortBeforeSettle: true });
			await settleQuietly(aborted);
			assert.equal(
				aborted.session.host.requests.some((request) => request.method === "notification.show"),
				false,
				"an aborted turn must not claim the session completed",
			);
		});

		test("a failed toast is reported, and tray fallback releases the callback", async (t) => {
			const failing = await startCompletedTurn(t, {
				hostHandlers: {
					"notification.show": () => ({ result: { backend: "none", interactive: false } }),
				},
			});
			await failing.session.host.waitForRequest("notification.show");
			const logged = await waitForLog(failing.session, "Session notification failed to show");
			assert.equal(logged.level, "warn");
			assert.equal(logged.scope, "agent");
			assert.equal(logged.detail.agentId, failing.activated.agentId);

			const tray = await startCompletedTurn(t, {
				hostHandlers: {
					// A tray balloon is non-interactive, so the host reports it that way.
					"notification.show": () => ({ result: { backend: "tray", interactive: false } }),
				},
			});
			const shown = await tray.session.host.waitForRequest("notification.show");
			tray.session.host.emit("notification.clicked", { id: shown.params.id });
			await new Promise((resolve) => setTimeout(resolve, 250));
			assert.equal(
				tray.session.host.requests.some((request) => request.method === "window.focus"),
				false,
				"a tray fallback has no interactive click",
			);
			assert.equal((await tray.session.invoke("app:get-focus-target-pending")).payload.result, null);
		});

		test("an ask from an unfocused session raises a toast that jumps back to it", async (t) => {
			const { session, record, sse } = await startAskTurn(t);
			// The user is looking at another session when the ask arrives.
			await session.invoke("sessions:set-focused-session", [OTHER_RECORD_ID]);
			await sendTurn(session, record);
			await waitForAsk(sse, "ask-1");

			const shown = await session.host.waitForRequest("notification.show");
			assert.match(shown.params.id, /^notification-\d+$/);
			assert.equal(shown.params.title, "PiDeck-Q");
			// AgentManager.notifyAskPending: the question (truncated) rides in the body.
			assert.equal(shown.params.body, `“${record.title}” is asking: Pick one`);
			assert.equal(shown.params.silent, false);
			assert.equal(shown.params.activationUrl, `pideck://session/${record.id}`);

			// Clicking the toast focuses the window and re-queues that session.
			session.host.emit("window.ready");
			session.host.emit("notification.clicked", { id: shown.params.id });
			await session.host.waitForRequest("window.focus");
		});

		test("the ask toast is gated by focus, per-run dedupe and the notification setting", async (t) => {
			const focused = await startAskTurn(t);
			// The asking session is the focused one: no toast, the user sees the card already.
			await focused.session.invoke("sessions:set-focused-session", [focused.record.id]);
			await sendTurn(focused.session, focused.record);
			await waitForAsk(focused.sse, "ask-1");
			assert.equal(notificationShows(focused.session).length, 0);

			const unfocused = await startAskTurn(t, { turnAsks: [["ask-1", "ask-2"], ["ask-3"]] });
			await unfocused.session.invoke("sessions:set-focused-session", [OTHER_RECORD_ID]);
			await sendTurn(unfocused.session, unfocused.record);
			await waitForAsk(unfocused.sse, "ask-2");
			// Two asks in one run must not produce two splashes (AgentManager.notifiedAskAgents).
			assert.equal(notificationShows(unfocused.session).length, 1, JSON.stringify(notificationShows(unfocused.session)));

			// A new run re-arms the reminder: the second prompt asks again and notifies again.
			await sendTurn(unfocused.session, unfocused.record, "req-ask-2");
			await waitForAsk(unfocused.sse, "ask-3");
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && notificationShows(unfocused.session).length < 2) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.equal(notificationShows(unfocused.session).length, 2, JSON.stringify(notificationShows(unfocused.session)));

			const disabled = await startAskTurn(t, { settings: { enableNotifications: false } });
			await disabled.session.invoke("sessions:set-focused-session", [OTHER_RECORD_ID]);
			await sendTurn(disabled.session, disabled.record);
			await waitForAsk(disabled.sse, "ask-1");
			assert.equal(notificationShows(disabled.session).length, 0);
		});

		test("a long ask question is truncated and an empty one falls back to the pending copy", async (t) => {
			const long = "x".repeat(70);
			const { session, record, sse } = await startAskTurn(t, { title: long });
			await session.invoke("sessions:set-focused-session", [OTHER_RECORD_ID]);
			await sendTurn(session, record);
			await waitForAsk(sse, "ask-1");
			const shown = await session.host.waitForRequest("notification.show");
			assert.equal(shown.params.body, `“${record.title}” is asking: ${"x".repeat(60)}…`);

			const empty = await startAskTurn(t, { title: "" });
			await empty.session.invoke("sessions:set-focused-session", [OTHER_RECORD_ID]);
			await sendTurn(empty.session, empty.record);
			await waitForAsk(empty.sse, "ask-1");
			const fallback = await empty.session.host.waitForRequest("notification.show");
			// No question content: the generic "waiting for your confirmation" copy.
			assert.equal(fallback.params.body, `“${empty.record.title}” is waiting for your confirmation`);
		});
	});
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Minimal pi session file: header, model change, one user and one assistant turn. */
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

const assistantTurn = (text) => [
	{ event: { type: "agent_start" } },
	{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
	{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_start" } } },
	{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: text } } },
	{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_end" } } },
	{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } } },
	{ event: { type: "agent_end", messages: [] } },
	{ event: { type: "agent_settled" } },
];

/**
 * Activate one session and drive a real turn through the scriptable fake pi.
 *
 * `abortBeforeSettle` aborts while the turn is still streaming, so the later settled
 * event is an abort-settled — the case the completion toast must ignore.
 */
async function startCompletedTurn(t, { settings = {}, hostHandlers = {}, abortBeforeSettle = false } = {}) {
	const projectPath = projectDirectory("notify");
	let fake = null;
	const session = await startBackendSession(t, {
		projects: [{ id: "notify", path: projectPath }],
		settings: { language: "en-US", ...settings },
		hostHandlers: {
			"notification.show": () => ({ result: { backend: "toast", interactive: true } }),
			...hostHandlers,
		},
		prepare: (fixture) => {
			fake = createFakePi(fixture, {
				turns: abortBeforeSettle
					? [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ delayMs: 500, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop" } } },
							{ event: { type: "agent_end", messages: [] } },
							{ event: { type: "agent_settled" } },
						],
					}]
					: [{ ack: true, events: assistantTurn("done") }],
			});
			return {
				settings: { customPiPath: fake.shim },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			};
		},
	});
	writeSessionFile(session.fixture.sessions, projectPath, "session-complete");
	const list = await session.invoke("sessions:catalog-list", ["notify"]);
	assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
	const record = list.payload.result.find((entry) => String(entry.filePath).includes("session-complete"));
	assert.ok(record, JSON.stringify(list.payload.result));
	const activated = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
	const target = activated.payload.result.value;
	const sent = await session.invoke("sessions:send-prompt", [{
		sessionId: record.id,
		requestId: "req-notify",
		message: "hello",
		agentId: target.agentId,
		runtimeGeneration: target.runtimeGeneration,
	}]);
	assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));
	if (abortBeforeSettle) {
		// Stop before the scripted turn finishes: the abort flag is what the gate must read.
		await new Promise((resolve) => setTimeout(resolve, 150));
		await session.invoke("sessions:runtime-abort", [{
			sessionId: record.id,
			agentId: target.agentId,
			runtimeGeneration: target.runtimeGeneration,
		}]);
	}
	return { session, record, activated: target, fake };
}

/**
 * Wait until the scripted turn really settled, then give the toast path a moment.
 * Without this, "no notification" could just mean the turn had not finished yet.
 */
async function settleQuietly({ fake }) {
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		const settled = fake.readLog().some((entry) => entry.kind === "event" && entry.event?.type === "agent_settled");
		if (settled) {
			await new Promise((resolve) => setTimeout(resolve, 250));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("the scripted turn never settled");
}

/**
 * Activate one session with a scripted ask turn.
 *
 * The turns never settle on purpose: a pending ask means pi is still waiting, and a
 * settled turn would also raise the completion toast and muddle the ask assertions.
 */
async function startAskTurn(t, { settings = {}, turnAsks = [["ask-1"]], title = "Pick one" } = {}) {
	const projectPath = projectDirectory("ask");
	let fake = null;
	const askEvent = (id) => (title
		? { event: { type: "extension_ui_request", id, method: "select", title, options: ["A", "B"] } }
		: { event: { type: "extension_ui_request", id, method: "confirm", options: [] } });
	const turns = turnAsks.map((ids) => ({
		ack: true,
		events: ids.map((id, askIndex) => ({ delayMs: 20 + askIndex * 20, ...askEvent(id) })),
	}));
	// `agent_start` must precede the ask of its own run: it is what re-arms the reminder.
	for (const turn of turns) turn.events.unshift({ event: { type: "agent_start" } });
	const session = await startBackendSession(t, {
		projects: [{ id: "ask", path: projectPath }],
		settings: { language: "en-US", ...settings },
		hostHandlers: {
			"notification.show": () => ({ result: { backend: "toast", interactive: true } }),
		},
		prepare: (fixture) => {
			fake = createFakePi(fixture, { turns });
			return {
				settings: { customPiPath: fake.shim },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			};
		},
	});
	const sse = startSse(t, session.ready);
	await sse.connect();
	writeSessionFile(session.fixture.sessions, projectPath, "session-ask");
	const list = await session.invoke("sessions:catalog-list", ["ask"]);
	assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
	const record = list.payload.result.find((entry) => String(entry.filePath).includes("session-ask"));
	assert.ok(record, JSON.stringify(list.payload.result));
	const activated = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
	return { session, record, activated: activated.payload.result.value, fake, sse };
}

/** One prompt for the session's runtime (the fake pi answers every turn by index). */
async function sendTurn(session, record, requestId = `req-${Math.random().toString(16).slice(2, 8)}`) {
	const runtimes = await session.invoke("sessions:runtime-list", []);
	const target = (runtimes.payload.result ?? []).find((entry) => entry.sessionId === record.id);
	assert.ok(target, JSON.stringify(runtimes.payload));
	const sent = await session.invoke("sessions:send-prompt", [{
		sessionId: record.id,
		requestId,
		message: "hello",
		agentId: target.agentId,
		runtimeGeneration: target.runtimeGeneration,
	}]);
	assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));
	return sent.payload.result;
}

/**
 * Wait until the renderer actually saw the ask.
 *
 * "No toast" is only meaningful once the ask exists, so every gating assertion waits for
 * this frame first instead of racing a fixed sleep.
 */
async function waitForAsk(sse, requestId, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const seen = sse.frames.some((frame) => {
			const envelope = frame.payload?.args?.[0];
			return frame.payload?.channel === "sessions:runtime-event"
				&& envelope?.sourceChannel === "agents:ui-request"
				&& envelope.payload?.requestId === requestId;
		});
		if (seen) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`the ask was never delivered to the renderer: ${requestId}`);
}

/** Every `notification.show` the fake host received, in order. */
function notificationShows(session) {
	return session.host.requests.filter((request) => request.method === "notification.show");
}

/** Poll the app log until the expected record appears (the toast failure is async). */
async function waitForLog(session, message, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const listed = await session.invoke("logs:list", [{ search: message, level: "warn" }]);
		const entries = listed.payload.result ?? [];
		const match = entries.find((entry) => entry.message === message);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`app log entry did not appear: ${message}`);
}
