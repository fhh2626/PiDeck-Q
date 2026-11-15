import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeHttpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
	createFakePi,
	httpRequest,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * Settle fallback parity for runtimes that never emit `agent_settled`.
 *
 * Oracle `AgentManager`: `agent_end` arms `AGENT_SETTLED_TIMEOUT_MS` (5 000 ms) —
 * `RUST_AGENT_SETTLED_TIMEOUT_MS` (250 ms) when `agent_start` carried a `sessionId`, i.e.
 * the pi_agent_rust / Pi-Bolt lifecycle serializer — and
 * `markIdleIfPiReportsNoWork` then confirms with `get_state` (not streaming, not
 * compacting, no queued message) before claiming idle. Gates before the poll: pending ask,
 * compaction in flight, live assistant row, executing tool. The fallback also emits a
 * local `agent_settled` so the LAN stream finishes.
 *
 * Everything here is observed through public surfaces: `sessions:runtime-event` frames
 * (`agents:state`, `agents:text-stream`) and the browser `POST /api/chat` SSE stream.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "settled-fallback";
const SECRET = "settled-fallback-token-0123456789ABCDEF";
const slash = (value) => String(value).replaceAll("\\", "/");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function waitForWeb(port, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await httpRequest(`http://127.0.0.1:${port}/api/health`);
			if (response.status === 200) return;
		} catch {
			// service still starting
		}
		await sleep(50);
	}
	throw new Error("LAN web service did not start");
}

/**
 * Minimal browser-side reader for the AI SDK v1 stream (`POST /api/chat`).
 *
 * Frames keep their arrival time so a test can prove the stream finished *because* the
 * fallback settled the turn instead of hanging until the client gives up.
 */
function openChatStream(port, body) {
	const frames = [];
	const waiters = [];
	let buffer = "";
	let ended = false;
	const payload = JSON.stringify(body);
	const deliver = (frame) => {
		frames.push(frame);
		for (const waiter of [...waiters]) {
			if (!waiter.match(frame)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			clearTimeout(waiter.timer);
			waiter.resolve(frame);
		}
	};
	const consume = (chunk) => {
		buffer += chunk;
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const dataLines = block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""));
			if (dataLines.length > 0) {
				const data = dataLines.join("\n");
				if (data === "[DONE]") deliver({ kind: "done", at: Date.now() });
				else {
					try {
						deliver({ kind: "frame", json: JSON.parse(data), at: Date.now() });
					} catch {
						deliver({ kind: "raw", data, at: Date.now() });
					}
				}
			}
			boundary = buffer.indexOf("\n\n");
		}
	};
	const request = nodeHttpRequest(
		{
			host: "127.0.0.1",
			port,
			path: "/api/chat",
			method: "POST",
			agent: false,
			headers: {
				accept: "text/event-stream",
				authorization: `Bearer ${SECRET}`,
				"content-type": "application/json",
				"content-length": String(Buffer.byteLength(payload)),
			},
		},
		(response) => {
			response.setEncoding("utf8");
			response.on("data", consume);
			response.on("end", () => {
				ended = true;
			});
		},
	);
	request.on("error", () => {
		ended = true;
	});
	request.write(payload);
	request.end();
	return {
		frames,
		get ended() {
			return ended;
		},
		types: () => frames.filter((frame) => frame.kind === "frame").map((frame) => frame.json?.type),
		hasDone: () => frames.some((frame) => frame.kind === "done"),
		waitFor(match, timeoutMs = 15_000) {
			const predicate = typeof match === "function" ? match : (frame) => frame.kind === match;
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const waiter = {
					match: predicate,
					resolve,
					timer: setTimeout(() => {
						waiters.splice(waiters.indexOf(waiter), 1);
						reject(new Error(`chat frame did not arrive (${this.types().join(",")})`));
					}, timeoutMs),
				};
				waiters.push(waiter);
			});
		},
		close() {
			request.destroy();
		},
	};
}

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

const messageStart = (id) => ({ type: "message_start", message: { id, role: "assistant", content: [] } });
const textDelta = (delta) => ({
	type: "message_update",
	message: { role: "assistant", content: [] },
	assistantMessageEvent: { type: "text_delta", delta },
});
const messageEnd = (text) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
});

/** Runtime envelopes of one session/channel in arrival order. */
function channelEvents(sse, sessionId, channel) {
	return sse.frames
		.map((frame) => frame.payload)
		.filter((payload) => payload.channel === "sessions:runtime-event")
		.map((payload) => payload.args[0])
		.filter((event) => event && event.sessionId === sessionId && event.sourceChannel === channel)
		.map((event) => event.payload);
}

function statusFrames(sse, sessionId) {
	return channelEvents(sse, sessionId, "agents:state").map((tab) => tab.status);
}

/**
 * Status frames of the current run: everything from the first `running` frame on.
 *
 * Activation legitimately publishes `idle` before the first prompt, so a bare
 * `includes("idle")` would pass for the wrong reason.
 */
function runStatuses(sse, sessionId) {
	const statuses = statusFrames(sse, sessionId);
	const start = statuses.indexOf("running");
	return start < 0 ? [] : statuses.slice(start);
}

async function waitFor(predicate, timeoutMs = 15_000, label = "condition") {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = predicate();
		if (found) return found;
		await sleep(20);
	}
	throw new Error(`${label} did not become true`);
}

if (executable) {
	describe("native2 settle fallback parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-settled-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {}, web = false } = {}) => {
			let fake = null;
			const port = web ? await freePort() : 0;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: {
					language: "en-US",
					...(web
						? {
								webServiceEnabled: true,
								webServiceHost: "127.0.0.1",
								webServicePort: port,
								webServiceAccessToken: SECRET,
							}
						: {}),
				},
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			if (web) await waitForWeb(port);
			return { ...session, fake, port };
		};

		const activate = async (session, name) => {
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, name);
			const listed = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "the session file must be imported into the catalog");
			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			return { record, target: activated.payload.result.value };
		};

		const connectSse = async (t, session) => {
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			return sse;
		};

		test("a runtime that never sends agent_settled settles via get_state and finishes the LAN stream", async (t) => {
			// `sessionId` on agent_start is the oracle's Rust/Pi-Bolt witness: 250 ms budget.
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start", sessionId: "pi-rust-1" } },
						{ event: messageStart("msg_rust") },
						{ delayMs: 20, event: textDelta("rust answer") },
						{ delayMs: 20, event: messageEnd("rust answer") },
						// No agent_settled at all — this is the whole point of the case.
						{ delayMs: 20, event: { type: "agent_end", messages: [] } },
					],
				}],
			};
			const session = await start(t, { scenario, web: true });
			const { record } = await activate(session, `rust-${Date.now()}`);
			const sse = await connectSse(t, session);

			const stream = openChatStream(session.port, {
				id: record.id,
				trigger: "submit-message",
				messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "go" }] }],
			});
			t.after(() => stream.close());

			const finishStarted = Date.now();
			await stream.waitFor((frame) => frame.kind === "frame" && frame.json?.type === "finish", 10_000);
			const finishAt = Date.now() - finishStarted;
			await stream.waitFor("done", 5_000);
			assert.ok(
				finishAt < 4_000,
				`the Rust-class fallback must settle within its 250 ms budget, took ${finishAt} ms`,
			);
			assert.equal(stream.frames.some((frame) => frame.kind === "frame" && frame.json?.type === "error"), false);

			// Desktop view: the tab must leave `running`, otherwise edit/delete/resend stay hidden.
			await waitFor(() => statusFrames(sse, record.id).includes("idle"), 5_000, "idle state frame");
			const statuses = statusFrames(sse, record.id);
			assert.equal(
				statuses.includes("error"),
				false,
				`a clean fallback settle must not paint an error: ${JSON.stringify(statuses)}`,
			);
			// The reply itself is intact in the projection.
			const messages = channelEvents(sse, record.id, "agents:message");
			assert.equal(
				messages.at(-1).messages.some((row) => row.role === "assistant" && row.text === "rust answer"),
				true,
				JSON.stringify(messages.at(-1).messages.map((row) => [row.role, row.text])),
			);
			// get_state really was the authority (the oracle polls before claiming idle).
			const polls = session.fake.readLog().filter((entry) => entry.kind === "command" && entry.command === "get_state");
			assert.ok(polls.length > 0, "the fallback must confirm with get_state");
		});

		test("the TypeScript runtime keeps its 5 s window instead of the 250 ms one", async (t) => {
			// No `sessionId` on agent_start: the TypeScript lifecycle, which normally settles
			// itself. The fallback must stay a slow safety net, not a 250 ms race that could
			// settle a run pi is still continuing (overflow retry / queued follow-up).
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start" } },
						{ event: messageStart("msg_ts") },
						{ delayMs: 20, event: textDelta("ts answer") },
						{ delayMs: 20, event: messageEnd("ts answer") },
						{ delayMs: 20, event: { type: "agent_end", messages: [] } },
					],
				}],
			};
			const session = await start(t, { scenario });
			const { record } = await activate(session, `ts-${Date.now()}`);
			const sse = await connectSse(t, session);
			const sent = await session.invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "ts-1",
				message: "go",
			}]);
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));

			await waitFor(
				() => channelEvents(sse, record.id, "agents:text-stream").some((payload) => payload.done === true),
				10_000,
				"reply text done frame",
			);
			await sleep(1_500);
			assert.equal(
				runStatuses(sse, record.id).includes("idle"),
				false,
				`the TypeScript runtime must not be settled after 1.5 s: ${JSON.stringify(statusFrames(sse, record.id))}`,
			);
			await waitFor(() => runStatuses(sse, record.id).includes("idle"), 9_000, "5 s fallback idle");
		});

		test("a pending ask gates the fallback settle", async (t) => {
			// pi is blocked on `extension_ui_response`; settling the turn would leave a dead
			// dialog and a runtime the user can no longer answer. Oracle gate:
			// `pendingUIRequests.size > 0`.
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start", sessionId: "pi-rust-ask" } },
						{ event: messageStart("msg_ask") },
						{ delayMs: 20, event: textDelta("need input") },
						{ delayMs: 20, event: { type: "extension_ui_request", id: "ask-1", method: "input", title: "Name?" } },
						{ delayMs: 20, event: messageEnd("need input") },
						{ delayMs: 20, event: { type: "agent_end", messages: [] } },
					],
				}],
			};
			const session = await start(t, { scenario });
			const { record, target } = await activate(session, `ask-${Date.now()}`);
			const sse = await connectSse(t, session);
			await session.invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "ask-turn-1",
				message: "go",
			}]);
			await waitFor(
				() => channelEvents(sse, record.id, "agents:ui-request").some((payload) => payload.requestId === "ask-1"),
				10_000,
				"ask request frame",
			);
			// Longer than the 250 ms Rust budget: the ask must hold the turn open.
			await sleep(1_200);
			assert.equal(
				runStatuses(sse, record.id).includes("idle"),
				false,
				`a pending ask must block the settle: ${JSON.stringify(statusFrames(sse, record.id))}`,
			);
			// Answering it releases the gate; the next agent_end settles normally.
			const answered = await session.invoke("sessions:ui-response", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
				requestId: "ask-1",
				value: "Ada",
			}]);
			assert.equal(answered.payload.ok, true, JSON.stringify(answered.payload));
		});

		test("a runtime without agent_settled settles on every turn, not just the first", async (t) => {
			// The watchdog is armed per run (`agent_end` captures the process + run generation at
			// arm time). A stale arming must therefore never settle the *next* run, while a
			// missing re-arm would leave the second turn `running` forever — the one failure this
			// case catches deterministically, without racing a stream mid-reply.
			const reply = (id, text) => [
				{ event: { type: "agent_start", sessionId: "pi-rust-two" } },
				{ event: messageStart(id) },
				{ delayMs: 20, event: textDelta(text) },
				{ delayMs: 20, event: messageEnd(text) },
				// No agent_settled on either turn.
				{ delayMs: 20, event: { type: "agent_end", messages: [] } },
			];
			const scenario = {
				turns: [
					{ ack: true, events: reply("msg_one", "first answer") },
					{ ack: true, events: reply("msg_two", "second answer") },
				],
			};
			const session = await start(t, { scenario });
			const { record } = await activate(session, `two-${Date.now()}`);
			const sse = await connectSse(t, session);

			const replies = () => {
				const list = [];
				let current = "";
				for (const payload of channelEvents(sse, record.id, "agents:text-stream")) {
					current += typeof payload.text === "string" ? payload.text : payload.delta ?? "";
					if (payload.done === true) {
						list.push(current);
						current = "";
					}
				}
				return list;
			};
			const idleFrames = () => statusFrames(sse, record.id).filter((status) => status === "idle").length;

			await session.invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "two-1", message: "one" }]);
			await waitFor(() => replies().length === 1, 10_000, "first reply");
			await waitFor(() => idleFrames() >= 1, 5_000, "first fallback settle");
			// The abort-free second turn must re-arm and settle on its own watchdog.
			await session.invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "two-2", message: "two" }]);
			await waitFor(() => replies().length === 2, 10_000, "second reply");
			await waitFor(() => idleFrames() >= 2, 5_000, "second fallback settle");
			assert.deepEqual(replies(), ["first answer", "second answer"]);
			assert.equal(statusFrames(sse, record.id).includes("error"), false, "no turn may be painted as failed");
		});
	});
}
