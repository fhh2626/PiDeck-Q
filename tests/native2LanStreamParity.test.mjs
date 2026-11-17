import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeHttpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
	createFakePi,
	httpRequest,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";
import { waitFor } from "./helpers/native2RuntimeEvents.mjs";

/**
 * LAN AI SDK v1 stream parity (`src/main/web/WebEventStream.ts`).
 *
 * The browser endpoint is the only protocol in the project that a phone actually reads,
 * so these tests drive the real backend over real HTTP: pi events come from the scripted
 * fake pi over real stdio JSON-RPC, the response is parsed as SSE, and every assertion is
 * about what a browser would observe.
 *
 * Deliberately not asserted here: JSON key order inside a frame (semantically irrelevant)
 * and anything that would also pass for a fake `data: [DONE]`.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "stream";
const SECRET = "lan-stream-secret-token-0123456789ABCDEF";
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
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const response = await httpRequest(`http://127.0.0.1:${port}/api/health`);
			if (response.status === 200) return JSON.parse(response.body);
		} catch (error) {
			lastError = error;
		}
		await sleep(50);
	}
	throw new Error(`web service did not start on ${port}: ${lastError?.message ?? "timeout"}`);
}

/** Authenticated JSON request helper. */
async function api(port, path, { method = "GET", token = SECRET, headers = {}, body = null } = {}) {
	const resolvedHeaders = { ...headers };
	if (token) resolvedHeaders.authorization = `Bearer ${token}`;
	const response = await httpRequest(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: resolvedHeaders,
		body: body === null ? null : JSON.stringify(body),
	});
	return {
		status: response.status,
		headers: response.headers,
		body: response.body,
		json: (() => {
			try {
				return JSON.parse(response.body);
			} catch {
				return null;
			}
		})(),
	};
}

/**
 * Streaming SSE client for the AI SDK endpoint.
 *
 * Uses Node's `http` client so chunked transfer decoding is the runtime's job (the
 * backend frames its body exactly like Node's own SSE responses). Frames keep their
 * arrival timestamp, so a test can prove a delta was delivered *while* the turn was still
 * running instead of being flushed after it finished.
 */
function openStream(port, path, { method = "GET", token = SECRET, body = null, headers = {} } = {}) {
	const frames = [];
	const waiters = [];
	let buffer = "";
	let status = 0;
	let responseHeaders = {};
	let ended = false;
	let responseRef = null;
	let resolveOpened;
	let rejectOpened;
	let resolveEnded;
	const opened = new Promise((resolve, reject) => {
		resolveOpened = resolve;
		rejectOpened = reject;
	});
	const endedPromise = new Promise((resolve) => {
		resolveEnded = resolve;
	});

	const deliver = (frame) => {
		frames.push(frame);
		for (const waiter of [...waiters]) {
			if (!waiter.match(frame)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			clearTimeout(waiter.timer);
			waiter.resolve(frame);
		}
	};

	const handleBlock = (block) => {
		let comment = false;
		const dataLines = [];
		for (const line of block.split("\n")) {
			if (line.startsWith(":")) {
				comment = true;
				continue;
			}
			if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
		}
		if (dataLines.length === 0) {
			if (comment) deliver({ kind: "comment", at: Date.now() });
			return;
		}
		const data = dataLines.join("\n");
		if (data === "[DONE]") {
			deliver({ kind: "done", at: Date.now() });
			return;
		}
		let json = null;
		try {
			json = JSON.parse(data);
		} catch {
			json = null;
		}
		deliver({ kind: "frame", json, data, at: Date.now() });
	};

	const consume = (chunk) => {
		buffer += chunk;
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			handleBlock(block);
			boundary = buffer.indexOf("\n\n");
		}
	};

	const resolvedHeaders = {
		accept: "text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...headers,
	};
	const payload = body === null ? null : JSON.stringify(body);
	if (payload !== null) resolvedHeaders["content-length"] = String(Buffer.byteLength(payload));

	const request = nodeHttpRequest(
		// No agent pool: a completed SSE response leaves a socket that must not be reused for
		// the next POST (Node 19+ keep-alive would hand out a socket the server just closed).
		{ host: "127.0.0.1", port, path, method, agent: false, headers: resolvedHeaders },
		(response) => {
			responseRef = response;
			status = response.statusCode ?? 0;
			responseHeaders = response.headers;
			resolveOpened();
			response.setEncoding("utf8");
			response.on("data", consume);
			// Abrupt server-side closes (service stop, backpressure cap) end the chunked body
			// early; the client only needs to know the stream is over.
			response.on("error", () => {
				if (ended) return;
				ended = true;
				deliver({ kind: "end", at: Date.now() });
				resolveEnded();
			});
			response.on("end", () => {
				ended = true;
				deliver({ kind: "end", at: Date.now() });
				resolveEnded();
			});
		},
	);
	request.on("error", (error) => {
		if (status === 0) rejectOpened(error);
		if (!ended) {
			ended = true;
			deliver({ kind: "end", at: Date.now() });
			resolveEnded();
		}
	});
	if (payload !== null) request.write(payload);
	request.end();

	return {
		opened,
		ended: endedPromise,
		frames,
		get status() {
			return status;
		},
		get headers() {
			return responseHeaders;
		},
		get closed() {
			return ended;
		},
		/** JSON frames only (heartbeat comments and `[DONE]` excluded). */
		json: () => frames.filter((frame) => frame.kind === "frame").map((frame) => frame.json),
		types: () => frames.filter((frame) => frame.kind === "frame").map((frame) => frame.json?.type),
		hasDone: () => frames.some((frame) => frame.kind === "done"),
		/** Stop reading the socket (backpressure test: TCP window closes). */
		pause: () => responseRef?.pause(),
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
						reject(
							new Error(
								`stream frame did not arrive (${frames
									.map((frame) => (frame.kind === "frame" ? frame.json?.type : frame.kind))
									.join(",")})`,
							),
						);
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

/** Concatenated text deltas of one stream (arrival order). */
function textOf(stream) {
	return stream
		.json()
		.filter((frame) => frame?.type === "text-delta")
		.map((frame) => frame.delta)
		.join("");
}

/** First frame of `type` carrying `toolCallId`. */
function frameById(frames, type, toolCallId) {
	return frames.find((frame) => frame.type === type && frame.toolCallId === toolCallId);
}

/** Minimal pi session file so a real runtime can be activated in the fixture. */
function writeSessionFile(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello from the web" }], timestamp: 1_767_225_601_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

const messageStart = (id) => ({
	type: "message_start",
	message: { id, role: "assistant", content: [] },
});

const textUpdate = (assistantMessageEvent) => ({
	type: "message_update",
	message: { role: "assistant", content: [] },
	assistantMessageEvent,
});

if (!executable) {
	describe("native2 LAN stream parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 LAN stream parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-lan-stream-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/** Boot a backend with the LAN service enabled and a scripted fake pi. */
		const start = async (t, { scenario = {}, settings = {}, env = {} } = {}) => {
			const port = await freePort();
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: {
					language: "en-US",
					webServiceEnabled: true,
					webServiceHost: "127.0.0.1",
					webServicePort: port,
					webServiceAccessToken: SECRET,
					...settings,
				},
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: {
							FAKE_PI_SCENARIO: fake.scenarioPath,
							FAKE_PI_LOG: fake.logPath,
							...env,
						},
					};
				},
			});
			await waitForWeb(port);
			return { ...session, fake, port };
		};

		/** Import one session file and activate it through the desktop channel. */
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

		const prompt = (session, sessionId, text, requestId) =>
			session.invoke("sessions:send-prompt", [{ sessionId, requestId, message: text }]);

		test("POST /api/chat streams AI SDK v1 frames while the turn is still running", async (t) => {
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ delayMs: 0, event: { type: "agent_start" } },
						{ delayMs: 20, event: messageStart("msg_1") },
						{ delayMs: 20, event: textUpdate({ type: "text_start" }) },
						{ delayMs: 40, event: textUpdate({ type: "text_delta", delta: "Hello " }) },
						{ delayMs: 40, event: textUpdate({ type: "text_delta", delta: "from the LAN" }) },
						{ delayMs: 40, event: textUpdate({ type: "text_end" }) },
						{ delayMs: 30, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello from the LAN" }], stopReason: "stop" } } },
						{ delayMs: 30, event: { type: "agent_end", messages: [] } },
						// The 900 ms gap is what proves the deltas were delivered *before* the
						// terminal frame instead of being flushed when the turn ended.
						{ delayMs: 900, event: { type: "agent_settled" } },
					],
				}],
			};
			const session = await start(t, { scenario });
			const { record } = await activate(session, `chat-${Date.now()}`);

			const stream = openStream(session.port, "/api/chat", {
				method: "POST",
				body: {
					id: record.id,
					trigger: "submit-message",
					messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello from the phone" }] }],
				},
			});
			t.after(() => stream.close());
			await stream.opened;

			assert.equal(stream.status, 200);
			assert.match(stream.headers["content-type"], /text\/event-stream/);
			assert.equal(stream.headers["x-vercel-ai-ui-message-stream"], "v1");
			assert.match(stream.headers["cache-control"], /no-cache/);
			assert.match(stream.headers["cache-control"], /no-transform/);
			assert.equal(stream.headers["x-accel-buffering"], "no");

			const firstDelta = await stream.waitFor(
				(frame) => frame.kind === "frame" && frame.json?.type === "text-delta",
			);
			assert.equal(stream.hasDone(), false, "the turn must still be running when the delta arrives");
			const done = await stream.waitFor("done");
			await stream.ended;

			assert.deepEqual(stream.types(), [
				"start",
				"text-start",
				"text-delta",
				"text-delta",
				"text-end",
				"finish",
			]);
			const frames = stream.json();
			assert.equal(frames[0].messageId, "msg_1");
			// One block id across start/delta/end: the SDK rejects mismatched ids.
			assert.equal(frames[1].id, frames[2].id);
			assert.equal(frames[2].id, frames[4].id);
			assert.equal(textOf(stream), "Hello from the LAN");
			assert.ok(done.at - firstDelta.at >= 400, `first delta ${done.at - firstDelta.at}ms before DONE`);
			assert.equal(stream.frames.at(-1).kind, "end");
			assert.equal(stream.frames.at(-2).kind, "done");

			// The prompt was dispatched once, with the last user text and no echoed payload.
			const prompts = session.fake.commands().filter((entry) => entry.command === "prompt");
			assert.equal(prompts.length, 1, JSON.stringify(session.fake.commands()));
			assert.equal(prompts[0].payload.message, "hello from the phone");
			assert.equal(prompts[0].payload.streamingBehavior, undefined);
			assert.equal(prompts[0].payload.requestId, undefined, "the delivery id is not pi's business");
		});

		test("thinking, tool cards and unrecorded tool results never invent an outcome", async (t) => {
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ delayMs: 0, event: { type: "agent_start" } },
						{ delayMs: 10, event: messageStart("msg_1") },
						{ delayMs: 10, event: textUpdate({ type: "thinking_delta", delta: "plan the " }) },
						{ delayMs: 10, event: textUpdate({ type: "thinking_delta", delta: "call" }) },
						{ delayMs: 10, event: textUpdate({ type: "thinking_end" }) },
						{ delayMs: 10, event: { type: "tool_execution_start", toolName: "bash", toolCallId: "tool-1", args: { command: "echo hi" } } },
						{ delayMs: 10, event: { type: "tool_execution_end", toolName: "bash", toolCallId: "tool-1", isError: false } },
						{ delayMs: 10, event: messageStart("msg_1") },
						{ delayMs: 10, event: textUpdate({ type: "text_delta", delta: "done" }) },
						{ delayMs: 10, event: textUpdate({ type: "text_end" }) },
						// Started but never finished: the run closes it as "result not recorded".
						{ delayMs: 10, event: { type: "tool_execution_start", toolName: "read", toolCallId: "tool-2", args: { path: "a.txt" } } },
						{ delayMs: 10, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } } },
						{ delayMs: 20, event: { type: "agent_settled" } },
					],
				}],
			};
			const session = await start(t, { scenario });
			const { record } = await activate(session, `tools-${Date.now()}`);

			const stream = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: record.id, messages: [{ role: "user", content: "run it" }] },
			});
			t.after(() => stream.close());
			await stream.opened;
			await stream.waitFor("done");
			await stream.ended;

			const frames = stream.json();
			assert.deepEqual(frames.map((frame) => frame.type), [
				"start",
				"reasoning-start",
				"reasoning-delta",
				"reasoning-delta",
				"reasoning-end",
				"tool-input-start",
				"tool-input-available",
				"tool-output-available",
				// Second LLM step in the same UI message.
				"start-step",
				"text-start",
				"text-delta",
				"text-end",
				"tool-input-start",
				"tool-input-available",
				// finish closes the dangling second tool back to "input available".
				"tool-input-available",
				"finish",
			]);
			const reasoning = frames
				.filter((frame) => frame.type === "reasoning-delta")
				.map((frame) => frame.delta)
				.join("");
			assert.equal(reasoning, "plan the call");
			assert.deepEqual(frameById(frames, "tool-input-available", "tool-1").input, { command: "echo hi" });
			// pi's `tool_execution_end` carries no renderable output; the translator must not
			// claim a result it never saw.
			assert.deepEqual(frameById(frames, "tool-output-available", "tool-1").output, {});
			assert.equal(frames.some((frame) => frame.type === "tool-output-error"), false);
			const dangling = frames.at(-2);
			assert.equal(dangling.toolCallId, "tool-2");
			assert.deepEqual(dangling.toolMetadata, { resultMissing: true });
			assert.deepEqual(dangling.input, { path: "a.txt" });
			assert.equal(frames.filter((frame) => frame.type === "finish").length, 1);
		});

		test("GET /stream observes a live run, joins late, and finishes immediately when idle", async (t) => {
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ delayMs: 0, event: { type: "agent_start" } },
						{ delayMs: 10, event: messageStart("msg_1") },
						{ delayMs: 250, event: textUpdate({ type: "text_delta", delta: "first " }) },
						{ delayMs: 600, event: textUpdate({ type: "text_delta", delta: "second part" }) },
						{ delayMs: 50, event: textUpdate({ type: "text_end" }) },
						{ delayMs: 30, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first second part" }], stopReason: "stop" } } },
						{ delayMs: 30, event: { type: "agent_end", messages: [] } },
						{ delayMs: 400, event: { type: "agent_settled" } },
					],
				}],
			};
			const session = await start(t, { scenario });

			// 1. An idle session has nothing to observe: the stream ends instead of hanging.
			const draft = await api(session.port, "/api/sessions", { method: "POST", body: { projectId: PROJECT_ID } });
			assert.equal(draft.status, 200, draft.body);
			const idle = openStream(session.port, `/api/sessions/${draft.json.session.id}/stream`);
			t.after(() => idle.close());
			await idle.opened;
			await idle.waitFor("done", 5_000);
			await idle.ended;
			assert.deepEqual(idle.types(), ["finish"]);

			// 2. A running session streams to a GET subscriber, including deltas that arrive
			//    after the subscription (the phone joined mid-turn).
			const { record } = await activate(session, `observe-${Date.now()}`);
			const sent = await prompt(session, record.id, "stream please", "req-observe");
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));

			const live = openStream(session.port, `/api/sessions/${record.id}/stream`);
			t.after(() => live.close());
			await live.opened;
			await live.waitFor("done");
			await live.ended;
			const text = textOf(live);
			assert.match(text, /second part/, `observed text: ${text}`);
			assert.equal(live.types().at(-1), "finish");
			assert.equal(live.hasDone(), true);
		});

		test("two sessions stream independently and a dropped socket does not disturb the other", async (t) => {
			const longTurn = (label, pad) => ({
				ack: true,
				events: [
					{ delayMs: 0, event: { type: "agent_start" } },
					{ delayMs: 10, event: messageStart("msg_1") },
					{ delayMs: 20, event: textUpdate({ type: "text_delta", delta: label }) },
					{ delayMs: 500, event: textUpdate({ type: "text_delta", delta: pad }) },
					{ delayMs: 60, event: textUpdate({ type: "text_end" }) },
					{ delayMs: 30, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `${label}${pad}` }], stopReason: "stop" } } },
					{ delayMs: 30, event: { type: "agent_end", messages: [] } },
					{ delayMs: 400, event: { type: "agent_settled" } },
				],
			});
			const session = await start(t, { scenario: { turns: [longTurn("A says ", "done A")] } });
			const first = await activate(session, `iso-a-${Date.now()}`);
			// Each session gets its own pi process, which reads the scenario on spawn: rewrite
			// it between activations so the two sessions run different scripts.
			const scenarioPath = session.fake.scenarioPath;
			const base = JSON.parse(readFileSync(scenarioPath, "utf8"));
			writeFileSync(scenarioPath, JSON.stringify({ ...base, turns: [longTurn("B says ", "done B")] }));
			const second = await activate(session, `iso-b-${Date.now()}`);

			const streamA = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: first.record.id, messages: [{ role: "user", content: "to A" }] },
			});
			const streamB = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: second.record.id, messages: [{ role: "user", content: "to B" }] },
			});
			t.after(() => {
				streamA.close();
				streamB.close();
			});
			await streamA.opened;
			await streamB.opened;

			await streamA.waitFor((frame) => frame.kind === "frame" && frame.json?.type === "text-delta");

			// A reconnecting phone attaches to the *same* run and receives only what the
			// first socket has not consumed yet.
			const reconnect = openStream(session.port, `/api/sessions/${first.record.id}/stream`);
			t.after(() => reconnect.close());
			await reconnect.opened;
			await reconnect.waitFor((frame) => frame.kind === "frame" && frame.json?.type === "text-delta");
			// Then it closes abruptly: the chat socket stays healthy.
			reconnect.close();

			await streamA.waitFor("done");
			await streamB.waitFor("done");
			await streamA.ended;
			await streamB.ended;

			assert.equal(textOf(streamA), "A says done A");
			assert.equal(textOf(streamB), "B says done B");
			assert.equal(streamA.json().some((frame) => String(frame?.delta ?? "").includes("B")), false);
			assert.equal(streamB.json().some((frame) => String(frame?.delta ?? "").includes("A")), false);
			assert.equal(streamA.hasDone(), true);
			assert.equal(streamB.hasDone(), true);
			await sleep(200);
			assert.equal((await api(session.port, "/api/health")).status, 200);
		});

		test("a late settled from an aborted run cannot finish the replacement run", async (t) => {
			const scenario = {
				turns: [
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 20, event: messageStart("msg_old") },
							{ delayMs: 200, event: textUpdate({ type: "text_delta", delta: "old answer" }) },
							// Residual delta after the abort: it belongs to the sealed generation.
							{ delayMs: 900, event: textUpdate({ type: "text_delta", delta: "late old" }) },
							{ delayMs: 300, event: { type: "agent_end", messages: [] } },
							{ delayMs: 900, event: { type: "agent_settled" } },
						],
					},
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 30, event: messageStart("msg_new") },
							// Before the aborted run's settled: the gate is still sealed for this run, so
							// the frame must not be delivered.
							{ delayMs: 170, event: textUpdate({ type: "text_delta", delta: "early new " }) },
							// After the aborted run's settled: the gate has advanced to this run.
							{ delayMs: 1_500, event: textUpdate({ type: "text_delta", delta: "late new" }) },
							{ delayMs: 30, event: textUpdate({ type: "text_end" }) },
							{ delayMs: 30, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late new" }], stopReason: "stop" } } },
							{ delayMs: 30, event: { type: "agent_end", messages: [] } },
							{ delayMs: 300, event: { type: "agent_settled" } },
						],
					},
				],
			};
			const session = await start(t, { scenario });
			const { record, target } = await activate(session, `generation-${Date.now()}`);

			// Stream A observes the first turn from the desktop side.
			const sent = await prompt(session, record.id, "first question", "req-gen-1");
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));
			const streamA = openStream(session.port, `/api/sessions/${record.id}/stream`);
			t.after(() => streamA.close());
			await streamA.opened;
			await streamA.waitFor((frame) => frame.kind === "frame" && frame.json?.delta === "old answer");

			// Abort ends that stream (the tab goes idle), then the user immediately sends a new
			// message: its `agent_start` arrives before the aborted run's settled.
			const aborted = await api(session.port, `/api/sessions/${record.id}/runtime/abort`, {
				method: "POST",
				body: { target },
			});
			assert.equal(aborted.status, 200, aborted.body);
			const streamB = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: record.id, messages: [{ role: "user", content: "second question" }] },
			});
			t.after(() => streamB.close());
			await streamB.opened;
			const promptSentAt = Date.now();

			await streamA.waitFor("done");
			await streamA.ended;
			// The aborted turn's late delta never reached the phone.
			assert.equal(textOf(streamA).includes("late old"), false, textOf(streamA));

			await streamB.waitFor("done", 20_000);
			await streamB.ended;

			const text = textOf(streamB);
			assert.match(text, /late new/, `replacement run must stream after the old settled, got: ${text}`);
			assert.equal(text.includes("late old"), false, `sealed delta leaked: ${text}`);
			assert.equal(text.includes("early new"), false, `pre-settled delta of the new run leaked: ${text}`);
			assert.equal(streamB.types().filter((type) => type === "finish").length, 1);
			// The new run's own message_start was sealed (it arrived before the aborted run's
			// settled), so the stream opens the text block itself and never sends a `start`.
			assert.equal(streamB.json()[0].type, "text-start");
			// The aborted run's settled (~1.7 s after the abort) must not have finished the new
			// stream; the new run's own settled does.
			const done = streamB.frames.find((frame) => frame.kind === "done");
			assert.ok(done.at - promptSentAt >= 1_600, `finished ${done.at - promptSentAt}ms after the re-prompt`);
		});

		test("a rejected prompt ends the stream with an error frame, never a fake success", async (t) => {
			const session = await start(t, { scenario: { turns: [{ ack: false, error: "model is unavailable" }] } });
			const { record } = await activate(session, `reject-${Date.now()}`);

			const stream = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: record.id, messages: [{ role: "user", content: "will fail" }] },
			});
			t.after(() => stream.close());
			await stream.opened;
			await stream.waitFor("done");
			await stream.ended;

			const frames = stream.json();
			assert.deepEqual(frames.map((frame) => frame.type), ["error", "finish"]);
			assert.equal(frames[0].errorText, "model is unavailable");
			assert.equal(stream.headers["x-vercel-ai-ui-message-stream"], "v1");
			assert.equal(stream.hasDone(), true);
			assert.equal(stream.types().some((type) => String(type).startsWith("text-")), false);

			// The rejection is still visible to the user: the runtime records the localized
			// failure row the web client renders from `/api/state` (the stream cannot invent
			// assistant text for a prompt that never ran).
			const state = await api(session.port, "/api/state");
			const rows = state.json.messagesBySession?.[record.id] ?? [];
			assert.ok(
				rows.some((row) => row.role === "error"),
				JSON.stringify(rows.map((row) => row.role)),
			);
		});

		test("ui ask and batch answers are routed by target and a duplicate answer is refused", async (t) => {
			const batchTitle = JSON.stringify({
				__piDeckBatchAsk: 1,
				review: false,
				questions: [{ id: "q1", type: "select", question: "Pick one", options: ["a", "b"] }],
			});
			const scenario = {
				turns: [
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 10, event: { type: "extension_ui_request", id: "ask-1", method: "input", title: "Name?", placeholder: "your name" } },
						],
					},
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 10, event: { type: "extension_ui_request", id: "ask-2", method: "select", title: batchTitle } },
						],
					},
				],
			};
			const session = await start(t, { scenario });
			const { record, target } = await activate(session, `ask-${Date.now()}`);

			const waitForPending = async (requestId, timeoutMs = 10_000) => {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					const state = await api(session.port, "/api/state");
					const pending = (state.json.pendingUiRequests ?? []).find((entry) => entry.requestId === requestId);
					if (pending) return pending;
					await sleep(50);
				}
				throw new Error(`pending UI request ${requestId} never appeared`);
			};

			await prompt(session, record.id, "ask me", "req-ask-1");
			const pending = await waitForPending("ask-1");
			assert.equal(pending.method, "input");
			assert.equal(pending.sessionId, record.id);
			assert.equal(pending.placeholder, "your name");

			// A stale target must never reach the runtime: the answer would go to a process
			// that is no longer asking.
			const stale = await api(session.port, "/api/ui-response", {
				method: "POST",
				body: { ...target, runtimeGeneration: target.runtimeGeneration + 5, requestId: "ask-1", response: { value: "x" } },
			});
			assert.equal(stale.status, 409, stale.body);
			assert.equal(stale.json.code, "webError.runtimeTargetRequired");

			const answered = await api(session.port, "/api/ui-response", {
				method: "POST",
				body: { ...target, requestId: "ask-1", response: { value: "Ada" } },
			});
			assert.equal(answered.status, 200, answered.body);
			assert.deepEqual(answered.json, { ok: true });
			// HTTP success acknowledges the queued stdio write. Observe its consumer
			// before asserting traffic, since the separate Pi process can still be scheduled later.
			await waitFor(() => session.fake.commands().some((entry) => entry.command === "extension_ui_response"
				&& entry.payload.id === "ask-1"), 10_000, "Pi receives the first UI response");
			const sentAnswers = session.fake.commands().filter((entry) => entry.command === "extension_ui_response");
			assert.equal(sentAnswers.length, 1, JSON.stringify(session.fake.commands()));
			assert.equal(sentAnswers[0].payload.id, "ask-1");
			assert.equal(sentAnswers[0].payload.value, "Ada");
			assert.equal(sentAnswers[0].payload.cancelled, undefined);

			// Re-submitting the same answer is not idempotent success: the request is gone,
			// and pi would silently ignore a second response.
			const duplicate = await api(session.port, "/api/ui-response", {
				method: "POST",
				body: { ...target, requestId: "ask-1", response: { value: "Ada" } },
			});
			assert.equal(duplicate.status, 409, duplicate.body);
			assert.equal(duplicate.json.code, "webError.runtimeTargetRequired");

			// The batch envelope is exposed with its questions and answered the same way.
			await prompt(session, record.id, "batch please", "req-ask-2");
			const batch = await waitForPending("ask-2");
			assert.equal(batch.method, "batch_ask");
			assert.equal(batch.batchQuestions.length, 1);
			assert.equal(batch.batchQuestions[0].id, "q1");
			const batchAnswer = { value: { answers: [{ id: "q1", value: "b" }] } };
			const answeredBatch = await api(session.port, "/api/ui-response", {
				method: "POST",
				body: { ...target, requestId: "ask-2", response: batchAnswer },
			});
			assert.equal(answeredBatch.status, 200, answeredBatch.body);
			await waitFor(() => session.fake.commands().some((entry) => entry.command === "extension_ui_response"
				&& entry.payload.id === "ask-2"), 10_000, "Pi receives the batch UI response");
			const sentBatch = session.fake
				.commands()
				.filter((entry) => entry.command === "extension_ui_response" && entry.payload.id === "ask-2");
			assert.equal(sentBatch.length, 1);
			assert.deepEqual(sentBatch[0].payload.value, batchAnswer.value);
		});

		test("the stream endpoint enforces auth, and stopping the service closes open streams", async (t) => {
			const scenario = {
				turns: [
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 10, event: messageStart("msg_slow") },
							{ delayMs: 20, event: textUpdate({ type: "text_delta", delta: "slow " }) },
							{ delayMs: 3_000, event: { type: "agent_end", messages: [] } },
							{ delayMs: 100, event: { type: "agent_settled" } },
						],
					},
					// Second turn: long enough that the service stop lands while it streams.
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 10, event: messageStart("msg_again") },
							{ delayMs: 20, event: textUpdate({ type: "text_delta", delta: "again " }) },
							{ delayMs: 5_000, event: { type: "agent_end", messages: [] } },
						],
					},
				],
			};
			const session = await start(t, { scenario, env: { PIDECK_WEB_STREAM_HEARTBEAT_MS: "200" } });
			const { record } = await activate(session, `lifecycle-${Date.now()}`);

			// 1. No token: JSON 401, not an open stream.
			const anonymous = openStream(session.port, "/api/chat", {
				method: "POST",
				token: null,
				body: { id: record.id, messages: [{ role: "user", content: "hi" }] },
			});
			t.after(() => anonymous.close());
			await anonymous.opened;
			assert.equal(anonymous.status, 401);
			await anonymous.ended;
			assert.equal(anonymous.json().length, 0);

			// 2. Cross-site POST is rejected before the prompt is dispatched.
			const csrf = await api(session.port, "/api/chat", {
				method: "POST",
				headers: { origin: "http://evil.example" },
				body: { id: record.id, messages: [{ role: "user", content: "hi" }] },
			});
			assert.equal(csrf.status, 403);
			assert.equal(csrf.json.code, "webError.forbiddenOrigin");

			// 3. A long-lived stream sends heartbeat comments and survives until settled.
			const stream = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: record.id, messages: [{ role: "user", content: "hi" }] },
			});
			t.after(() => stream.close());
			await stream.opened;
			assert.equal(stream.status, 200);
			await stream.waitFor("comment", 5_000);
			await stream.waitFor("done");
			await stream.ended;
			assert.equal(textOf(stream), "slow ");

			// 4. Disabling the service closes a stream that is still active instead of
			//    leaving a socket bound to a dead listener.
			const open = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: record.id, messages: [{ role: "user", content: "again" }] },
			});
			t.after(() => open.close());
			await open.opened;
			await open.waitFor((frame) => frame.kind === "frame" && frame.json?.type === "text-delta");
			const disabled = await session.invoke("settings:update", [{ webServiceEnabled: false }]);
			assert.equal(disabled.payload.ok, true, JSON.stringify(disabled.payload));
			await open.ended;
			await assert.rejects(httpRequest(`http://127.0.0.1:${session.port}/api/health`));
		});

		test("a client that stops reading is dropped instead of growing the backend", async (t) => {
			// 512 KiB per delta × 8 far exceeds the (test-seam) 64 KiB socket cap.
			const blob = "x".repeat(512 * 1024);
			const events = [
				{ delayMs: 0, event: { type: "agent_start" } },
				{ delayMs: 5, event: messageStart("msg_big") },
			];
			for (let index = 0; index < 8; index += 1) {
				events.push({ delayMs: 5, event: textUpdate({ type: "text_delta", delta: `${index}:${blob}` }) });
			}
			events.push({ delayMs: 5, event: { type: "agent_end", messages: [] } });
			events.push({ delayMs: 20, event: { type: "agent_settled" } });

			const session = await start(t, {
				scenario: { turns: [{ ack: true, events }] },
				env: { PIDECK_WEB_STREAM_MAX_BUFFER_BYTES: String(64 * 1024) },
			});
			const { record } = await activate(session, `backpressure-${Date.now()}`);

			// Deliberately stop reading: the server must not queue megabytes per phone.
			const stalled = openStream(session.port, "/api/chat", {
				method: "POST",
				body: { id: record.id, messages: [{ role: "user", content: "big" }] },
			});
			t.after(() => stalled.close());
			await stalled.opened;
			stalled.pause();
			await sleep(3_000);
			assert.equal((await api(session.port, "/api/health")).status, 200);

			// The backend survives and still serves a normal stream.
			const healthy = openStream(session.port, `/api/sessions/${record.id}/stream`);
			t.after(() => healthy.close());
			await healthy.opened;
			await healthy.waitFor("done", 10_000);
			await healthy.ended;
			assert.equal(healthy.hasDone(), true);

			const warn = await session.invoke("logs:list", [{ search: "not reading", level: "warn" }]);
			const entries = warn.payload.result ?? [];
			assert.ok(
				entries.some((entry) => entry.message === "Web stream client is not reading"),
				JSON.stringify(entries),
			);
		});

		test("restart-web-service truly restarts the endpoint and drops live streams", async (t) => {
			// A turn that never settles keeps the SSE stream open: the fake pi plays these events
			// and then waits for the next prompt, so no `agent_end`/`agent_settled` arrives.
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ delayMs: 0, event: { type: "agent_start" } },
						{ delayMs: 10, event: messageStart("msg_restart") },
						{ delayMs: 10, event: textUpdate({ type: "text_start" }) },
						{ delayMs: 20, event: textUpdate({ type: "text_delta", delta: "still running" }) },
					],
				}],
			};
			const session = await start(t, { scenario });
			const { record } = await activate(session, `restart-${Date.now()}`);
			const sent = await prompt(session, record.id, "keep the turn open", "req-restart");
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));

			const live = openStream(session.port, `/api/sessions/${record.id}/stream`);
			t.after(() => live.close());
			await live.opened;
			await live.waitFor(
				(frame) => frame.kind === "frame" && frame.json?.type === "text-delta",
				10_000,
			);
			assert.equal(live.closed, false, "a running turn must keep the browser stream open");

			// A real restart tears the listener down: the oracle's `restartNow` stops (closing SSE
			// and upgraded sockets) and starts again on the persisted endpoint. Reusing
			// `applySettings` would only hot-swap the token and leave this stream alive.
			const restarted = await session.invoke("settings:restart-web-service");
			assert.equal(restarted.payload.ok, true, JSON.stringify(restarted.payload));
			await Promise.race([
				live.ended,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("restart must drop the live stream")), 10_000),
				),
			]);

			// The same endpoint is back with the persisted token, and it is still token-gated.
			const health = await api(session.port, "/api/health");
			assert.equal(health.status, 200);
			assert.equal(health.json.port, session.port);
			assert.equal((await api(session.port, "/api/state")).status, 200);
			assert.equal((await api(session.port, "/api/state", { token: null })).status, 401);

			// A fresh stream on the restarted listener works: the restart left no half-dead state.
			const again = openStream(session.port, `/api/chat`, {
				method: "POST",
				body: { id: record.id, messages: [{ role: "user", content: "after restart" }] },
			});
			t.after(() => again.close());
			await again.opened;
			assert.equal(again.status, 200);
		});
	});
}
