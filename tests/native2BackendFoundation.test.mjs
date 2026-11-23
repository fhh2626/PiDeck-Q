import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	backendFixtureSettings,
	backendEnvFor,
	stopBackendProcess,
	FakeHost,
	SseClient,
	httpRequest,
	resolveBackendExecutable,
	rpc,
	rawHttp,
	spawnBackend,
	waitForRendererReady,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const requireBackend = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = "foundation-test-token";

function createFixture(settings = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-native2-foundation-"));
	const userData = join(root, "user-data");
	const renderer = join(root, "renderer");
	const backgrounds = join(root, "backgrounds");
	const sessions = join(root, "sessions");
	const prompts = join(root, "prompts");
	const skills = join(root, "skills");
	for (const directory of [userData, join(renderer, "assets"), backgrounds, sessions, prompts, skills]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(join(renderer, "index.html"), "<!doctype html><html><body><div id=\"root\">PiDeck shell</div></body></html>");
	writeFileSync(join(renderer, "assets/app.js"), "export const marker = 'pideck-app';\n");
	writeFileSync(join(renderer, "assets/app.css"), "body{color:#111}\n");
	writeFileSync(join(backgrounds, "bg-test.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(backgrounds, "bg-test.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
	writeFileSync(
		join(userData, "settings.json"),
		JSON.stringify(backendFixtureSettings({
			theme: "dark",
			closeToTray: false,
			startupWindowMode: "last",
			zoomFactor: 1.25,
			customFlag: "kept",
			...settings,
		})),
	);
	writeFileSync(join(userData, "last-window-bounds.json"), JSON.stringify({ width: 1280, height: 720, x: 40, y: 60 }));
	writeFileSync(join(root, "secret.txt"), "outside the renderer root");
	return { root, userData, renderer, backgrounds, sessions, prompts, skills };
}

function backendEnv(fixture) {
	// Foundation tests must not read or migrate the runner's real Pi profile.
	return backendEnvFor(fixture);
}

function defaultHandlers() {
	return {
		"clipboard.metadataSnapshot": () => ({
			result: { text: "clip", html: "", filePaths: [], hasImage: false, sequence: 7 },
		}),
		"window.minimize": () => ({ result: null }),
		"window.close": () => ({ result: null }),
		"window.beginSystemMove": () => ({ result: null }),
		"window.toggleDevTools": () => ({ result: null }),
		"shell.openExternal": () => ({ result: null }),
		"application.restart": () => ({ result: null }),
		"window.beginSystemResize": () => ({ result: true }),
	};
}

async function startBackend(t, handlers = defaultHandlers(), settings) {
	const fixture = createFixture(settings);
	const host = new FakeHost({ token: TOKEN, handlers });
	const hostPort = await host.start();
	const process_ = spawnBackend({ executable, hostPort, token: TOKEN, env: backendEnv(fixture) });
	t.after(async () => {
		await stopBackendProcess(process_, host);
		rmSync(fixture.root, { recursive: true, force: true });
	});
	const ready = await waitForRendererReady(host);
	return { fixture, host, backend: process_, ready, baseUrl: ready.url, token: ready.token };
}

if (executable) {
	test("C++ backend announces a real renderer page and serves the renderer bundle", async (t) => {
		const { backend, ready, baseUrl, token } = await startBackend(t);

		assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
		assert.equal(ready.token, TOKEN);
		assert.equal(ready.startup.theme, "dark");
		assert.equal(ready.startup.useNativeTitleBar, true);
		assert.equal((await rpc(baseUrl, token, "settings:get")).payload.result.useNativeTitleBar, true);
		assert.equal(ready.startup.closeToTray, false);
		assert.equal(ready.startup.startupWindowMode, "last");
		assert.deepEqual(ready.startup.lastWindowBounds, { width: 1280, height: 720, x: 40, y: 60 });
		// The prototype printed ports on stdout; the host never reads stdout, so the
		// real contract must not depend on it.
		assert.equal(backend.output.stdout.trim(), "");

		const index = await httpRequest(baseUrl);
		assert.equal(index.status, 200);
		assert.match(index.headers["content-type"], /text\/html/);
		assert.match(index.body, /PiDeck shell/);

		const script = await httpRequest(`${baseUrl}assets/app.js`);
		assert.equal(script.status, 200);
		assert.match(script.headers["content-type"], /text\/javascript/);
		assert.match(script.body, /pideck-app/);

		const stylesheet = await httpRequest(`${baseUrl}assets/app.css`);
		assert.equal(stylesheet.status, 200);
		assert.match(stylesheet.headers["content-type"], /text\/css/);

		// Client-side routes fall back to the shell so the SPA can boot.
		const spaRoute = await httpRequest(`${baseUrl}workspace/session/abc`);
		assert.equal(spaRoute.status, 200);
		assert.match(spaRoute.body, /PiDeck shell/);

		// A missing asset with an extension must not be answered with HTML.
		const missingAsset = await httpRequest(`${baseUrl}assets/missing.js`);
		assert.equal(missingAsset.status, 404);

		const escape = await httpRequest(`${baseUrl}../secret.txt`, { headers: { "x-pideck-token": token } });
		assert.ok(escape.status === 403 || escape.status === 404, `escape status ${escape.status}`);
		assert.doesNotMatch(escape.body, /outside the renderer root/);
	});

	test("C++ backend bootstrap reports real clipboard, settings and event generation", async (t) => {
		const { baseUrl, token } = await startBackend(t);
		const response = await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } });
		assert.equal(response.status, 200);
		const payload = JSON.parse(response.body);
		assert.equal(payload.clipboard.text, "clip");
		assert.equal(payload.clipboard.sequence, 7);
		assert.deepEqual(payload.clipboard.filePaths, []);
		assert.equal(payload.settings.zoomFactor, 1.25);
		assert.equal(payload.settings.memoryProfileEnabled, false);
		assert.equal(typeof payload.eventSeq, "number");
		assert.match(payload.eventSourceGeneration, UUID_PATTERN);
	});

	test("a saved custom title bar overrides the system-title-bar default", async (t) => {
		const { ready, baseUrl, token } = await startBackend(t, undefined, { useNativeTitleBar: false });
		assert.equal(ready.startup.useNativeTitleBar, false);
		const response = await rpc(baseUrl, token, "settings:get");
		assert.equal(response.payload.result.useNativeTitleBar, false);
	});

	test("an invalid saved title bar preference uses the same default at startup and on update", async (t) => {
		const { ready, baseUrl, token, host } = await startBackend(t, undefined, { useNativeTitleBar: null });
		assert.equal(ready.startup.useNativeTitleBar, true);
		assert.equal((await rpc(baseUrl, token, "settings:get")).payload.result.useNativeTitleBar, true);
		const changed = await rpc(baseUrl, token, "settings:update", [{ closeToTray: true }]);
		assert.equal(changed.payload.result.useNativeTitleBar, true);
		assert.equal((await host.waitForRequest("window.applySettings")).params.useNativeTitleBar, true);
	});

	test("C++ backend enforces token auth and a hardened HTTP parser", async (t) => {
		const { baseUrl, token } = await startBackend(t);

		const unauthorized = await httpRequest(`${baseUrl}__pideck/bootstrap`);
		assert.equal(unauthorized.status, 401);
		assert.equal(JSON.parse(unauthorized.body).ok, false);

		const wrongToken = await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": "nope" } });
		assert.equal(wrongToken.status, 401);

		const queryToken = await httpRequest(`${baseUrl}__pideck/bootstrap?token=${token}`);
		assert.equal(queryToken.status, 200);

		const malformed = await httpRequest(`${baseUrl}__pideck/rpc`, {
			method: "POST",
			headers: { "x-pideck-token": token, "content-type": "application/json" },
			body: "{not json",
		});
		assert.equal(malformed.status, 400);

		const duplicateLength = await rawHttp(
			new URL(baseUrl).port,
			`POST /__pideck/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nx-pideck-token: ${token}\r\ncontent-length: 2\r\ncontent-length: 3\r\n\r\n{}`,
		);
		assert.match(duplicateLength, /^HTTP\/1\.1 400/);

		const chunked = await rawHttp(
			new URL(baseUrl).port,
			`POST /__pideck/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nx-pideck-token: ${token}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
		);
		assert.match(chunked, /^HTTP\/1\.1 400/);

		const missingHost = await rawHttp(
			new URL(baseUrl).port,
			`GET /__pideck/bootstrap HTTP/1.1\r\nx-pideck-token: ${token}\r\n\r\n`,
		);
		assert.match(missingHost, /^HTTP\/1\.1 400/);

		const oversized = await rawHttp(
			new URL(baseUrl).port,
			`POST /__pideck/rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nx-pideck-token: ${token}\r\ncontent-length: ${33 * 1024 * 1024}\r\n\r\n`,
		);
		assert.match(oversized, /^HTTP\/1\.1 413/);

		const unknownChannel = await rpc(baseUrl, token, "prototype.echo", [1]);
		assert.equal(unknownChannel.status, 200);
		assert.equal(unknownChannel.payload.ok, false);
		assert.match(unknownChannel.payload.error.message, /Unknown channel/);

		const appInfo = await rpc(baseUrl, token, "app:info", []);
		assert.equal(appInfo.payload.ok, true);
		assert.equal(appInfo.payload.result.version, "0.4.3");
		assert.equal(typeof appInfo.payload.result.platform, "string");
	});

	test("C++ backend correlates host requests by id and answers with host results", async (t) => {
		const handlers = defaultHandlers();
		// Answer out of order to prove correlation is by id, not by arrival order.
		handlers["window.toggleMaximize"] = () => undefined;
		handlers["window.isMaximized"] = () => undefined;
		const { baseUrl, token, host } = await startBackend(t, handlers);

		const toggle = rpc(baseUrl, token, "app:window-toggle-maximize", []);
		const isMaximized = rpc(baseUrl, token, "app:window-is-maximized", []);
		const toggleRequest = await host.waitForRequest("window.toggleMaximize");
		const isMaximizedRequest = await host.waitForRequest("window.isMaximized");
		assert.notEqual(toggleRequest.id, isMaximizedRequest.id);

		host.respond(isMaximizedRequest.id, false);
		host.respond(toggleRequest.id, true);

		const [toggleResult, maximizedResult] = await Promise.all([toggle, isMaximized]);
		assert.equal(toggleResult.payload.ok, true);
		assert.equal(toggleResult.payload.result, true);
		assert.equal(maximizedResult.payload.ok, true);
		assert.equal(maximizedResult.payload.result, false);
	});

	test("C++ backend streams replayable SSE with sequence, generation and heartbeat truth", async (t) => {
		const { baseUrl, token, host } = await startBackend(t);
		const bootstrap = JSON.parse((await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } })).body);

		const client = new SseClient(`${baseUrl}__pideck/events?token=${token}`);
		await client.connect();
		t.after(() => client.close());
		const readyFrame = await client.waitFor("native.eventChannelReady");
		assert.equal(readyFrame.payload.args[0].eventSourceGeneration, bootstrap.eventSourceGeneration);
		assert.equal(readyFrame.payload.args[0].eventSeq, bootstrap.eventSeq);

		host.emit("native.clipboard", { text: "live", html: "", filePaths: [], hasImage: false, sequence: 9 });
		const clipboardFrame = await client.waitFor("native.clipboard");
		assert.equal(clipboardFrame.id, bootstrap.eventSeq + 1);
		assert.equal(clipboardFrame.payload.args[0].text, "live");

		// A reconnecting renderer replays everything after its cursor.
		const replay = new SseClient(`${baseUrl}__pideck/events?token=${token}&lastEventId=${bootstrap.eventSeq}`);
		await replay.connect();
		t.after(() => replay.close());
		const replayed = await replay.waitFor("native.clipboard");
		assert.equal(replayed.payload.args[0].text, "live");

		const healthy = await httpRequest(`${baseUrl}__pideck/heartbeat`, {
			method: "POST",
			headers: { "x-pideck-token": token, "content-type": "application/json" },
			body: JSON.stringify({
				lastEventSeq: clipboardFrame.id,
				eventSourceGeneration: bootstrap.eventSourceGeneration,
			}),
		});
		assert.equal(healthy.status, 200);
		const healthyState = JSON.parse(healthy.body);
		assert.equal(healthyState.eventChannelHealthy, true);
		assert.equal(healthyState.eventSourceGeneration, bootstrap.eventSourceGeneration);
		assert.equal(healthyState.eventSeq, clipboardFrame.id);

		const stale = await httpRequest(`${baseUrl}__pideck/heartbeat`, {
			method: "POST",
			headers: { "x-pideck-token": token, "content-type": "application/json" },
			body: JSON.stringify({ lastEventSeq: 0, eventSourceGeneration: "stale-generation" }),
		});
		assert.equal(JSON.parse(stale.body).eventChannelHealthy, false);

		const diagnostics = await httpRequest(`${baseUrl}__pideck/diagnostics/memory`, {
			method: "POST",
			headers: { "x-pideck-token": token, "content-type": "application/json" },
			body: JSON.stringify({ heap: 1 }),
		});
		assert.equal(diagnostics.status, 204);
	});

	test("C++ backend reports a replay gap instead of silently skipping history", async (t) => {
		const { baseUrl, token, host } = await startBackend(t);
		// 4096 frames is the retained history bound; exceeding it must produce an
		// explicit resync signal for a cursor that can no longer be replayed.
		for (let index = 0; index < 4_200; index += 1) {
			host.emit("native.clipboard", { text: `e${index}`, html: "", filePaths: [], hasImage: false, sequence: index });
		}
		// Wait until the backend really appended every frame: connecting while the host
		// socket is still draining would make the cursor replayable (no gap yet), which
		// is correct behaviour but a racy premise for this case.
		let eventSeq = 0;
		for (let attempt = 0; attempt < 400; attempt += 1) {
			const bootstrap = JSON.parse(
				(await httpRequest(`${baseUrl}__pideck/bootstrap`, { headers: { "x-pideck-token": token } })).body,
			);
			eventSeq = bootstrap.eventSeq;
			if (eventSeq >= 4_200) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(eventSeq >= 4_200, `backend only appended ${eventSeq} frames`);
		const client = new SseClient(`${baseUrl}__pideck/events?token=${token}&lastEventId=0`);
		await client.connect();
		t.after(() => client.close());
		const gap = await client.waitFor("native.resyncRequired", 20_000);
		assert.equal(gap.payload.args[0].reason, "event-history-truncated");
	});

	test("C++ backend serves background images with strict names and MIME types", async (t) => {
		const { baseUrl, token } = await startBackend(t);
		const png = await httpRequest(`${baseUrl}__pideck/background/bg-test.png`, { headers: { "x-pideck-token": token } });
		assert.equal(png.status, 200);
		assert.equal(png.headers["content-type"], "image/png");
		assert.match(png.headers["cache-control"], /max-age=86400/);

		const svg = await httpRequest(`${baseUrl}__pideck/background/bg-test.svg`, { headers: { "x-pideck-token": token } });
		assert.equal(svg.status, 200);
		assert.equal(svg.headers["content-type"], "image/svg+xml");

		const badName = await httpRequest(`${baseUrl}__pideck/background/not-a-background.png`, { headers: { "x-pideck-token": token } });
		assert.equal(badName.status, 403);

		const traversal = await httpRequest(`${baseUrl}__pideck/background/bg-%2e%2e%2fsecret.txt`, { headers: { "x-pideck-token": token } });
		assert.equal(traversal.status, 403);
	});

	test("C++ backend spawns children with a sanitized environment", async (t) => {
		const { baseUrl, token, fixture } = await startBackend(t);
		const dumpPath = join(fixture.root, "child-env.txt");
		assert.doesNotMatch(dumpPath, /\s/, "the env dump path must not contain spaces");
		// The child writes its own environment to disk, so the assertion is about what
		// the process actually received rather than about backend internals. The terminal
		// channel takes a target, never an executable: the shell comes from discovery.
		const created = await rpc(baseUrl, token, "terminal:create", [
			{ kind: "project", projectId: "", cwd: fixture.root },
			"cmd",
		]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const tabId = created.payload.result.id;
		// Input typed before cmd.exe has drawn its prompt is consumed by the console and
		// lost, so the command is retried until the child actually wrote the dump.
		let dumped = "";
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const dump = await rpc(baseUrl, token, "terminal:input", [tabId, `set > ${dumpPath}\r\n`]);
			assert.equal(dump.payload.ok, true, JSON.stringify(dump.payload));
			for (let wait = 0; wait < 8; wait += 1) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				if (!existsSync(dumpPath)) continue;
				dumped = readFileSync(dumpPath, "utf8");
				if (dumped.includes("PATH=")) break;
			}
			if (dumped.includes("PATH=")) break;
		}
		assert.match(dumped, /PATH=/i);
		assert.doesNotMatch(dumped, /PIDECK_HOST_TOKEN/);
		assert.doesNotMatch(dumped, /PIDECK_HOST_PORT/);
		assert.doesNotMatch(dumped, /PIDECK_NATIVE_HOST/);
		assert.doesNotMatch(dumped, /NODE_OPTIONS/);
		await rpc(baseUrl, token, "terminal:close", [tabId]);
	});

	test("C++ backend acknowledges quit only after cleanup and persists window bounds", async (t) => {
		const fixture = createFixture();
		const host = new FakeHost({ token: TOKEN, handlers: defaultHandlers() });
		const hostPort = await host.start();
		const process_ = spawnBackend({ executable, hostPort, token: TOKEN, env: backendEnv(fixture) });
		t.after(async () => {
			await stopBackendProcess(process_, host);
			rmSync(fixture.root, { recursive: true, force: true });
		});
		await waitForRendererReady(host);

		host.emit("window.normalBoundsChanged", { width: 1200, height: 800, x: 12, y: 24 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		host.emit("application.prepareQuit", {});
		await host.waitForEvent("application.readyToExit", 10_000);
		const exit = await process_.exited;
		assert.equal(exit.code, 0, `stderr: ${exit.stderr}`);
		assert.equal(exit.stdout.trim(), "");

		const bounds = JSON.parse(readFileSync(join(fixture.userData, "last-window-bounds.json"), "utf8"));
		assert.equal(bounds.width, 1200);
		assert.equal(bounds.height, 800);
		assert.equal(bounds.x, 12);
		assert.equal(bounds.y, 24);
	});

	test("C++ backend exits when the host connection disappears", async (t) => {
		const fixture = createFixture();
		const host = new FakeHost({ token: TOKEN, handlers: defaultHandlers() });
		const hostPort = await host.start();
		const process_ = spawnBackend({ executable, hostPort, token: TOKEN, env: backendEnv(fixture) });
		t.after(async () => {
			await stopBackendProcess(process_, host);
			rmSync(fixture.root, { recursive: true, force: true });
		});
		await waitForRendererReady(host);
		await host.stop();
		const exit = await Promise.race([
			process_.exited,
			new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), 5_000)),
		]);
		assert.notEqual(exit.code, "timeout", "backend kept running without the host");
	});
} else if (requireBackend) {
	test("native2 backend foundation requires a built PiDeckBackend", () => {
		assert.fail("PiDeckBackend executable not found. Build it with: xmake build PiDeckBackend");
	});
} else {
	test("native2 backend foundation", { skip: "PiDeckBackend.exe is not built (run: xmake build PiDeckBackend)" }, () => {});
}
