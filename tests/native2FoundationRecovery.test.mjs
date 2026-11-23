import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
	SseClient,
	httpRequest,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";
// The oracle's own CSV parser and header, not a re-implementation: a C++ sampling run must be
// readable by the native memory-profile analyzer.
import { MEMORY_PROFILE_HEADER, parseMemoryCsv } from "../scripts/lib/memoryProfileCsv.ts";
import { appLogLines } from "./helpers/nativeAppLog.mjs";

/**
 * Foundation regression suite: the defects the independent foundation review found in the
 * transport / threading / security layer. Every case drives the real `PiDeckBackend.exe`
 * over the real wire protocols, so a pass is evidence about behaviour, not structure.
 *
 *  1. a second request on one connection must never replay the first (duplicate mutation);
 *  2. concurrent catalog reads/writes must be serialized (single-owner dispatch);
 *  3. `app:open-external` must apply the oracle's protocol allowlist exactly;
 *  4. a replay gap must re-push full renderer state, not only a signal;
 *  5. the heartbeat watchdog must reload only when heartbeats stop;
 *  6. quitting with a live child must ACK inside the host's 1500 ms force-kill budget;
 *  7. `PIDECK_MEMORY_PROFILE=1` must produce the oracle CSV contract.
 */

const executable = resolveBackendExecutable();
const requireBackend = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const PROJECT_ID = "p1";

let root;
let projectPath;

before(() => {
	root = mkdtempSync(join(tmpdir(), "pideck-native2-foundation-recovery-"));
	projectPath = join(root, "project");
	mkdirSync(projectPath, { recursive: true });
	writeFileSync(join(projectPath, "README.md"), "# project\n");
});

after(() => {
	if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function catalogEntries(fixture) {
	const path = join(fixture.userData, "session-catalog.json");
	if (!existsSync(path)) return [];
	return JSON.parse(readFileSync(path, "utf8")).sessions ?? [];
}

/** One TCP connection that writes each entry of `writes` as its own `write()` call. */
function writeSegments(port, writes) {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		let received = "";
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(received);
		};
		// The response carries `connection: close`, so the server closes the socket; a stuck
		// request must not hang the suite.
		const guard = setTimeout(finish, 5_000);
		guard.unref?.();
		socket.on("connect", () => {
			// Written back to back so the second request is in flight while the first is still
			// being served: that is the state in which the old parser replayed the first body.
			// Queue the pipeline together: separate uncorked writes can be held by
			// Nagle until after the first response closes the connection. Late-byte
			// delivery has its own explicit in-flight barrier regression.
			socket.cork();
			for (const chunk of writes) socket.write(chunk);
			socket.uncork();
		});
		socket.on("data", (chunk) => {
			received += chunk.toString("utf8");
		});
		socket.on("close", () => {
			clearTimeout(guard);
			finish();
		});
		socket.on("error", (error) => {
			if (received.length > 0) return finish();
			reject(error);
		});
	});
}

function rpcRequestText(token, channel, args) {
	const body = JSON.stringify({ channel, args });
	return (
		`POST /__pideck/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
		`x-pideck-token: ${token}\r\ncontent-type: application/json\r\n` +
		`content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
	);
}

function reloadRequests(host) {
	return host.requests.filter((request) => request.method === "window.reload");
}

/** Absolute project/session paths come back with forward slashes. */
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal real pi JSONL: a session header plus one user turn. */
function writeMinimalSession(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: `question ${name}` }], timestamp: 1_767_225_600_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

/** Read the newest sample file, tolerating a row that is being appended right now. */
function readProfileRows(directory) {
	const names = readdirSync(directory).filter((name) => name.endsWith(".csv"));
	if (names.length === 0) return { header: "", rows: [] };
	const text = readFileSync(join(directory, names.sort().at(-1)), "utf8");
	const lines = text.split("\n");
	const header = lines.shift() ?? "";
	// Drop a trailing partial line: the backend writes with a single append per sample.
	const complete = lines.filter((line) => line.trim() !== "" && line.split(",").length === 18);
	return { header, rows: parseMemoryCsv([header, ...complete].join("\n")) };
}

if (executable) {
	test("a second request on one connection never replays the first (no duplicate mutation)", async (t) => {
		const session = await startBackendSession(t, { projects: [{ id: PROJECT_ID, path: projectPath }] });
		const port = new URL(session.baseUrl).port;
		// Two drafts pipelined on one connection. Before the fix the parser stopped at the first
		// complete request and left the second in its buffer; the next readyRead re-dispatched
		// the *first* request instead of parsing the second, so the draft was created twice.
		const response = await writeSegments(port, [
			rpcRequestText(session.token, "sessions:catalog-create-draft", [{ projectId: PROJECT_ID }]),
			rpcRequestText(session.token, "sessions:catalog-create-draft", [{ projectId: PROJECT_ID }]),
		]);
		assert.match(response, /"ok":true/);

		// Give the serial executor time to settle any queued continuation.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const entries = catalogEntries(session.fixture);
		assert.equal(entries.length, 1, `expected exactly one draft, got ${entries.length}`);

		// The dropped pipelined bytes must be observable, not silent.
		const diagnostics = appLogLines(session.fixture).filter(
			(line) => line.message === "Native event channel diagnostic",
		);
		assert.ok(
			diagnostics.some((line) => line.detail?.kind === "pipelined-request-dropped"),
			`expected a pipelined-request-dropped diagnostic, got ${JSON.stringify(diagnostics)}`,
		);
	});

	test("concurrent catalog mutations are serialized and none is lost", async (t) => {
		const session = await startBackendSession(t, { projects: [{ id: PROJECT_ID, path: projectPath }] });

		// 12 drafts plus interleaved cached scans: with a multi-threaded pool this mutated the
		// catalog's QVector from several threads at once (lost entries, torn JSON file).
		const drafts = Array.from({ length: 12 }, () =>
			session.invoke("sessions:catalog-create-draft", [{ projectId: PROJECT_ID }]),
		);
		const scans = Array.from({ length: 4 }, () =>
			session.invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]),
		);
		const results = await Promise.all([...drafts, ...scans]);
		for (const result of results) {
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		}

		const entries = catalogEntries(session.fixture);
		assert.equal(entries.length, 12);
		assert.equal(new Set(entries.map((entry) => entry.id)).size, 12);
		for (const entry of entries) {
			assert.match(entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		}
		// The catalog file must still be valid JSON after concurrent writes.
		assert.doesNotThrow(() =>
			JSON.parse(readFileSync(join(session.fixture.userData, "session-catalog.json"), "utf8")),
		);
	});

	test("concurrent scans and history reads share the catalog and JSONL index safely", async (t) => {
		const session = await startBackendSession(t, { projects: [{ id: PROJECT_ID, path: projectPath }] });
		// Real session files so the scan + index cache (the other shared structure the old
		// QThreadPool mutated unsynchronised) are exercised, not only the catalog vector.
		const files = Array.from({ length: 6 }, (_, index) =>
			writeMinimalSession(session.fixture.sessions, projectPath, `scan${index}`),
		);
		const first = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
		assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
		const ids = new Map(
			first.payload.result
				.filter((entry) => entry.filePath)
				.map((entry) => [slash(entry.filePath), entry.id]),
		);
		for (const file of files) assert.ok(ids.has(slash(file)), `${file} missing from the scan`);

		// Concurrent rescans (each rewrites the catalog) plus history reads through the shared
		// JSONL index: the identity and the cached index must survive all of them.
		const rescans = Array.from({ length: 6 }, () => session.invoke("sessions:catalog-list", [PROJECT_ID]));
		const reads = files.flatMap((file) => {
			const sessionId = ids.get(slash(file));
			return [
				session.invoke("sessions:catalog-read-messages", [sessionId]),
				session.invoke("sessions:catalog-read-message-page", [sessionId, { page: 0, pageSize: 2 }]),
			];
		});
		const results = await Promise.all([...rescans, ...reads]);
		for (const result of results) {
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		}

		const stable = await session.invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
		assert.equal(stable.payload.ok, true, JSON.stringify(stable.payload));
		for (const file of files) {
			const matches = stable.payload.result.filter((entry) => slash(entry.filePath) === slash(file));
			assert.equal(matches.length, 1, `${file} must appear exactly once`);
			assert.equal(matches[0].id, ids.get(slash(file)), `${file} identity changed under concurrency`);
		}
		// Nothing was lost from the six concurrent rewrites either.
		assert.equal(catalogEntries(session.fixture).filter((entry) => entry.filePath).length >= files.length, true);
	});

	test("memory profiling writes the oracle CSV contract", async (t) => {
		const session = await startBackendSession(t, {
			env: { PIDECK_MEMORY_PROFILE: "1", PIDECK_MEMORY_PROFILE_INTERVAL_MS: "50" },
		});

		// The renderer only starts posting its counters when the bootstrap flag is on.
		const bootstrap = JSON.parse(
			(await httpRequest(`${session.baseUrl}__pideck/bootstrap`, {
				headers: { "x-pideck-token": session.token },
			})).body,
		);
		assert.equal(bootstrap.settings.memoryProfileEnabled, true);

		// Exactly what initializeNativeDesktop.ts posts on the heartbeat timer.
		const posted = await httpRequest(`${session.baseUrl}__pideck/diagnostics/memory`, {
			method: "POST",
			headers: { "x-pideck-token": session.token, "content-type": "application/json" },
			body: JSON.stringify({
				jsHeapKB: 12345,
				totalJSHeapKB: 20000,
				domNodes: 4321,
				imgCount: 7,
				imgPixels: 9000,
				canvasPixels: 0,
				workerCount: null,
				workerJSHeapKB: null,
			}),
		});
		assert.equal(posted.status, 204);

		const directory = join(session.fixture.userData, "memory-profile");
		let sample = { header: "", rows: [] };
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (existsSync(directory)) {
				sample = readProfileRows(directory);
				if (sample.rows.some((row) => row.domNodes === 4321)) break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		// Header must be the oracle's constant, and the oracle's parser must read the rows.
		assert.equal(sample.header, MEMORY_PROFILE_HEADER);
		assert.ok(sample.rows.length >= 2, `expected repeated samples, got ${sample.rows.length}`);
		for (const row of sample.rows) {
			// A C++ backend is its own process: type/label identify it honestly instead of
			// claiming to be the Node sidecar.
			assert.equal(row.type, "CppBackend");
			assert.equal(row.label, "pideck-backend");
			assert.equal(row.pid, session.backend.child.pid);
			assert.ok(row.rssKB > 0, "RSS must be measured, not fabricated");
			assert.equal(row.streaming, 0);
			assert.equal(row.sharedKB, null);
			assert.equal(row.heapUsedKB, null);
		}
		// Samples are ordered epoch ms.
		for (let index = 1; index < sample.rows.length; index += 1) {
			assert.ok(sample.rows[index].ts >= sample.rows[index - 1].ts);
		}

		// The merged renderer diagnostics persist across samples; null stays "not probed".
		const latest = sample.rows.at(-1);
		assert.equal(latest.jsHeapKB, 12345);
		assert.equal(latest.totalJSHeapKB, 20000);
		assert.equal(latest.domNodes, 4321);
		assert.equal(latest.imgCount, 7);
		assert.equal(latest.imgPixels, 9000);
		assert.equal(latest.canvasPixels, 0);
		assert.equal(latest.workerCount, null);
	});

	test("memory profiling is off unless PIDECK_MEMORY_PROFILE=1", async (t) => {
		const session = await startBackendSession(t);
		const bootstrap = JSON.parse(
			(await httpRequest(`${session.baseUrl}__pideck/bootstrap`, {
				headers: { "x-pideck-token": session.token },
			})).body,
		);
		assert.equal(bootstrap.settings.memoryProfileEnabled, false);

		// The endpoint still answers 204 (it is part of the route contract) but nothing samples.
		const posted = await httpRequest(`${session.baseUrl}__pideck/diagnostics/memory`, {
			method: "POST",
			headers: { "x-pideck-token": session.token, "content-type": "application/json" },
			body: JSON.stringify({ domNodes: 1 }),
		});
		assert.equal(posted.status, 204);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(existsSync(join(session.fixture.userData, "memory-profile")), false);
	});

	test("app:open-external applies the oracle protocol allowlist exactly", async (t) => {
		const opened = [];
		const session = await startBackendSession(t, {
			hostHandlers: {
				"shell.openExternal": (params) => {
					opened.push(params.url);
					return { result: null };
				},
			},
		});

		// Rejected schemes: the RPC resolves (the oracle only warns) and the host is never
		// asked, so a model-emitted `file:` / `search-ms:` link cannot launch a local handler.
		for (const url of [
			"file:///C:/Windows/System32/calc.exe",
			"search-ms:query=secret",
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"ms-settings:privacy",
			"not a url",
			"",
		]) {
			const result = await session.invoke("app:open-external", [url]);
			assert.equal(result.payload.ok, true, `${url} -> ${JSON.stringify(result.payload)}`);
			assert.equal(result.payload.result, null);
		}
		assert.deepEqual(opened, [], "no rejected scheme may reach the host");

		// A non-string is a malformed request, not an empty URL.
		const malformed = await session.invoke("app:open-external", [42]);
		assert.equal(malformed.payload.ok, false);
		assert.match(malformed.payload.error.message, /Invalid external URL/);

		// Allowlisted schemes reach the host unchanged.
		const allowed = ["https://example.com/docs", "http://example.com/", "mailto:dev@example.com", "vscode://file/tmp/x"];
		for (const url of allowed) {
			const result = await session.invoke("app:open-external", [url]);
			assert.equal(result.payload.ok, true, `${url} -> ${JSON.stringify(result.payload)}`);
		}
		assert.deepEqual(opened, allowed);

		const rejected = appLogLines(session.fixture).filter(
			(line) => line.message === "Rejected external link with non-allowlisted protocol",
		);
		assert.equal(rejected.length, 7);
	});

	test("app:open-external propagates web failures but degrades non-web failures", async (t) => {
		const session = await startBackendSession(t, {
			hostHandlers: {
				"shell.openExternal": (params) =>
					params.url.startsWith("mailto:")
						? { ok: false, error: "no mail handler" }
						: { ok: false, error: "browser launch failed" },
			},
		});

		const web = await session.invoke("app:open-external", ["https://example.com/x"]);
		assert.equal(web.payload.ok, false);
		assert.match(web.payload.error.message, /browser launch failed/);

		// A missing mail handler is a normal environment state: warn, do not fail the caller.
		const mail = await session.invoke("app:open-external", ["mailto:dev@example.com"]);
		assert.equal(mail.payload.ok, true, JSON.stringify(mail.payload));
		assert.equal(mail.payload.result, null);
		const warned = appLogLines(session.fixture).filter(
			(line) => line.message === "Failed to open non-http external link",
		);
		assert.equal(warned.length, 1);
	});

	test("a replay gap re-pushes full renderer state instead of only a signal", async (t) => {
		const session = await startBackendSession(t, { env: { PIDECK_LIVE_RESYNC_WINDOW_MS: "250" } });
		const { host, baseUrl, token } = session;

		// 4096 frames is the retained history bound; overflow it so any older cursor is a gap.
		for (let index = 0; index < 4_200; index += 1) {
			host.emit("native.clipboard", { text: `e${index}`, html: "", filePaths: [], hasImage: false, sequence: index });
		}
		// Wait until the backend has actually appended every frame, otherwise the gap is a
		// race between the host socket and the HTTP socket.
		for (let attempt = 0; attempt < 400; attempt += 1) {
			const bootstrap = JSON.parse(
				(await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } })).body,
			);
			if (bootstrap.eventSeq >= 4_200) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		const first = new SseClient(`${baseUrl}__pideck/events?token=${token}&lastEventId=0`);
		await first.connect();
		t.after(() => first.close());
		const gap = await first.waitFor("native.resyncRequired", 20_000);
		assert.equal(gap.payload.args[0].reason, "event-history-truncated");

		// The renderer ignores `native.resyncRequired` object payloads by design, so the
		// backend must re-send state itself: the tab table (empty here) plus each bound
		// agent's message window.
		const resync = await first.waitFor("agents:state", 5_000);
		assert.deepEqual(resync.payload.args[0], []);

		// Two more gaps inside the same window must coalesce: one immediate re-push plus one
		// trailing re-push, never three.
		const second = new SseClient(`${baseUrl}__pideck/events?token=${token}&lastEventId=0`);
		await second.connect();
		t.after(() => second.close());
		const third = new SseClient(`${baseUrl}__pideck/events?token=${token}&lastEventId=0`);
		await third.connect();
		t.after(() => third.close());
		await new Promise((resolve) => setTimeout(resolve, 800));
		const stateFrames = first.frames.filter((frame) => frame.payload.channel === "agents:state");
		assert.equal(stateFrames.length, 2, `expected 2 coalesced re-pushes, got ${stateFrames.length}`);
	});

	test("the heartbeat watchdog reloads a page whose heartbeats stopped", async (t) => {
		const session = await startBackendSession(t, {
			env: {
				PIDECK_RENDERER_HEARTBEAT_WINDOW_MS: "150",
				PIDECK_RENDERER_HEARTBEAT_TICK_MS: "50",
			},
			hostHandlers: { "window.reload": () => ({ result: null }) },
		});
		// A page exists and is visible; only then is a heartbeat expected.
		session.host.emit("window.ready", {});
		session.host.emit("window.visibleChanged", true);

		// 3 complete windows (450 ms) of silence must produce a reload.
		await session.host.waitForRequest("window.reload", 5_000);
		assert.ok(reloadRequests(session.host).length >= 1);
	});

	test("a visible page that keeps its heartbeat is never reloaded", async (t) => {
		const session = await startBackendSession(t, {
			env: {
				PIDECK_RENDERER_HEARTBEAT_WINDOW_MS: "150",
				PIDECK_RENDERER_HEARTBEAT_TICK_MS: "50",
			},
			hostHandlers: { "window.reload": () => ({ result: null }) },
		});
		session.host.emit("window.ready", {});
		session.host.emit("window.visibleChanged", true);

		for (let tick = 0; tick < 12; tick += 1) {
			await httpRequest(`${session.baseUrl}__pideck/heartbeat`, {
				method: "POST",
				headers: { "x-pideck-token": session.token, "content-type": "application/json" },
				body: JSON.stringify({ lastEventSeq: 0, eventSourceGeneration: "" }),
			});
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
		assert.equal(reloadRequests(session.host).length, 0, "a page that keeps beating must not be reloaded");
	});

	test("a hidden window is not watched for heartbeats", async (t) => {
		const session = await startBackendSession(t, {
			env: {
				PIDECK_RENDERER_HEARTBEAT_WINDOW_MS: "150",
				PIDECK_RENDERER_HEARTBEAT_TICK_MS: "50",
			},
			hostHandlers: { "window.reload": () => ({ result: null }) },
		});
		session.host.emit("window.ready", {});
		// Hidden to tray: Chromium throttles page timers for minutes, so silence is expected.
		session.host.emit("window.visibleChanged", false);
		await new Promise((resolve) => setTimeout(resolve, 900));
		assert.equal(reloadRequests(session.host).length, 0, "a hidden window must not be reloaded");
	});

	test("quitting after a bootstrap request exits on its own (no force-kill)", async (t) => {
		const session = await startBackendSession(t);
		// Every real page bootstraps. A bootstrap timer left pending at teardown used to keep
		// the process alive after main() returned, so the host force-killed *every* quit.
		const bootstrap = await httpRequest(`${session.baseUrl}__pideck/bootstrap`, {
			headers: { "x-pideck-token": session.token },
		});
		assert.equal(bootstrap.status, 200);

		const started = Date.now();
		session.host.emit("application.prepareQuit", {});
		await session.host.waitForEvent("application.readyToExit", 5_000);
		const exit = await Promise.race([
			session.backend.exited,
			new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 4_000)),
		]);
		assert.equal(exit.code, 0, `backend did not exit on its own: ${JSON.stringify(exit)}`);
		assert.ok(Date.now() - started < 1_500, `quit took ${Date.now() - started} ms`);
	});

	test("quitting with a live child ACKs inside the host force-kill budget", async (t) => {
		const session = await startBackendSession(t, {
			hostHandlers: { "window.reload": () => ({ result: null }) },
		});
		const { host, fixture, invoke, backend } = session;

		const created = await invoke("terminal:create", [
			{ kind: "project", projectId: "", cwd: fixture.root },
			"cmd",
		]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const tabId = created.payload.result.id;
		await invoke("terminal:input", [tabId, "ping -n 60 127.0.0.1\r\n"]);
		await new Promise((resolve) => setTimeout(resolve, 200));

		host.emit("window.normalBoundsChanged", { width: 1400, height: 900, x: 5, y: 6 });
		await new Promise((resolve) => setTimeout(resolve, 100));

		const started = Date.now();
		host.emit("application.prepareQuit", {});
		await host.waitForEvent("application.readyToExit", 10_000);
		const elapsed = Date.now() - started;
		// The Qt host force-kills the job object 1500 ms after prepareQuit; the ACK must
		// arrive first or the persisted window bounds are lost on every quit with a child.
		assert.ok(elapsed < 1_500, `shutdown took ${elapsed} ms, host budget is 1500 ms`);

		const exit = await backend.exited;
		assert.equal(exit.code, 0, `stderr: ${exit.stderr}`);
		const bounds = JSON.parse(readFileSync(join(fixture.userData, "last-window-bounds.json"), "utf8"));
		assert.equal(bounds.width, 1400);
		assert.equal(bounds.height, 900);
		assert.equal(bounds.x, 5);
		assert.equal(bounds.y, 6);
	});
} else if (requireBackend) {
	test("PiDeckBackend.exe must be built for the foundation recovery suite", () => {
		assert.fail("build PiDeckBackend (xmake build -y PiDeckBackend) before running native2 tests");
	});
} else {
	test("foundation recovery suite (skipped: PiDeckBackend.exe not built)", { skip: true }, () => {});
}
