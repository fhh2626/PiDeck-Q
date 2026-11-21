import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
	createFakePi,
	httpRequest,
	rawHttp,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * LAN web service parity (src/main/web/*).
 *
 * The browser surface is the third protocol in the project and the only one reachable
 * from the local network, so these tests drive the real backend over real HTTP:
 * the auth ladder, the route table (including unknown/method-mismatched paths), the
 * shared catalog/coordinator, the bundle server and the settings lifecycle.
 *
 * Nothing here re-implements a route: the assertions are about observable HTTP.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "web";
const SECRET = "lan-web-secret-token-0123456789ABCDEF";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Reserve a port by binding 0 and releasing it; the backend binds it right afterwards. */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `/api/health` until the listener answers (startup applies settings asynchronously). */
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
async function api(port, path, { method = "GET", token = SECRET, headers = {}, body = null, cookie = null } = {}) {
	const resolvedHeaders = { ...headers };
	if (token) resolvedHeaders.authorization = `Bearer ${token}`;
	if (cookie) resolvedHeaders.cookie = cookie;
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

/** Parse an AI SDK v1 SSE body into the JSON payload of every `data:` frame. */
function sseFrames(body) {
	const frames = [];
	for (const block of body.split("\n\n")) {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.join("");
		if (!data || data === "[DONE]") continue;
		frames.push(JSON.parse(data));
	}
	return frames;
}

/** Minimal pi session file so a real runtime can be activated in the fixture. */
function writeSessionFile(sessionsDir, projectPath, name, { olderTurn = false } = {}) {
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
	if (olderTurn) {
		entries[2].parentId = "older-user";
		entries.splice(2, 0, {
			type: "message", id: "older-user", parentId: "m1", timestamp: "2026-01-01T00:00:00.500Z",
			message: { role: "user", content: [{ type: "text", text: "older question" }], timestamp: 1_767_225_600_500 },
		});
	}
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

/**
 * Minimal pi session file that carries a Codex *subagent* import marker.
 *
 * `src/main/web/WebServiceManager.ts getState()` filters
 * `codexThreadSource === "subagent"` alongside internal/parent-marked records, because a
 * Codex subagent rollout is child work rather than a session a browser can open.
 */
function writeCodexSubagentSessionFile(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{
			type: "codex_import",
			codexSessionId: `codex-${name}`,
			threadSource: "subagent",
			parentThreadId: `codex-parent-${name}`,
			agentRole: "worker",
		},
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "subagent only work" }], timestamp: 1_767_225_601_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

if (!executable) {
	describe("native2 LAN web parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 LAN web parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-web-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * Boot a backend with the LAN service enabled on `port`.
		 *
		 * `webRenderer` adds a `web.html` entry document so the bundle path is exercised
		 * instead of the fallback page.
		 */
		const start = async (t, { port, settings = {}, scenario = {}, webRenderer = true } = {}) => {
			const resolvedPort = port ?? (await freePort());
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: {
					language: "en-US",
					webServiceEnabled: true,
					webServiceHost: "127.0.0.1",
					webServicePort: resolvedPort,
					webServiceAccessToken: SECRET,
					...settings,
				},
				prepare: (fixture) => {
					if (webRenderer) {
						writeFileSync(
							join(fixture.renderer, "web.html"),
							"<!doctype html><html><body>PiDeck web bundle</body></html>",
						);
					}
					if (!scenario || Object.keys(scenario).length === 0) return {};
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const health = await waitForWeb(resolvedPort);
			return { ...session, fake, port: resolvedPort, health };
		};

		test("auth ladder matches webServiceAuth: health, query exchange, bearer, cookie, CSRF, OPTIONS", async (t) => {
			const { port } = await start(t);

			// 1. /api/health is public and reports the bound endpoint.
			const health = await httpRequest(`http://127.0.0.1:${port}/api/health`);
			assert.equal(health.status, 200);
			assert.deepEqual(JSON.parse(health.body), {
				ok: true,
				service: "PiDeck-Q",
				host: "127.0.0.1",
				port,
			});

			// 2. Everything else without a token is 401 — JSON for /api/*, a page for the UI.
			const unauthenticated = await api(port, "/api/state", { token: null });
			assert.equal(unauthenticated.status, 401);
			assert.deepEqual(unauthenticated.json, {
				code: "webError.unauthorized",
				error: "Unauthorized: open the Web service from PiDeck settings (QR code or Open button).",
			});
			const page = await api(port, "/", { token: null });
			assert.equal(page.status, 401);
			assert.match(page.headers["content-type"], /text\/html/);
			assert.match(page.body, /未授权/);
			assert.match(page.body, /Unauthorized: open the Web service/);

			// 3. A GET query token exchanges for an HttpOnly cookie and a clean redirect.
			const exchanged = await api(port, "/?pideck_token=" + SECRET, { token: null });
			assert.equal(exchanged.status, 302);
			assert.equal(exchanged.headers.location, "/");
			assert.equal(
				exchanged.headers["set-cookie"][0],
				`pideck_web_token_${port}=${SECRET}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
			);
			assert.equal(exchanged.headers["cache-control"], "no-store");

			// The redirect target keeps the other query parameters.
			const kept = await api(port, `/some/route?view=legacy&pideck_token=${SECRET}`, { token: null });
			assert.equal(kept.status, 302);
			assert.equal(kept.headers.location, "/some/route?view=legacy");

			// A wrong query token and a non-GET exchange attempt are both unauthorized.
			assert.equal((await api(port, "/?pideck_token=wrong", { token: null })).status, 401);
			assert.equal((await api(port, `/api/state?pideck_token=${SECRET}`, { method: "POST", token: null })).status, 401);

			// 4. Bearer and cookie both authorize; a cookie for another port does not.
			assert.equal((await api(port, "/api/state")).status, 200);
			const cookieAuth = await api(port, "/api/state", {
				token: null,
				cookie: `other=1; pideck_web_token_${port}=${SECRET}`,
			});
			assert.equal(cookieAuth.status, 200);
			const wrongPortCookie = await api(port, "/api/state", {
				token: null,
				cookie: `pideck_web_token_1=${SECRET}`,
			});
			assert.equal(wrongPortCookie.status, 401);

			// 5. A cross-site Origin on an unsafe method is 403, not 401: DNS rebinding and
			//    CSRF must be distinguishable from "you forgot the token".
			const csrf = await api(port, "/api/state", {
				method: "POST",
				headers: { origin: "http://evil.example" },
			});
			assert.equal(csrf.status, 403);
			assert.deepEqual(csrf.json, {
				code: "webError.forbiddenOrigin",
				error: "Cross-site request rejected.",
			});
			const sameOrigin = await api(port, "/api/state", {
				method: "POST",
				headers: { origin: `http://127.0.0.1:${port}` },
			});
			assert.equal(sameOrigin.status, 200);

			// 6. OPTIONS preflight is 204 (no body) once authorized.
			const preflight = await api(port, "/api/state", { method: "OPTIONS" });
			assert.equal(preflight.status, 204);
			assert.equal(preflight.body, "");
		});

		test("the route table answers every oracle path and 404s unknown ones", async (t) => {
			const { port } = await start(t);

			const state = await api(port, "/api/state");
			assert.equal(state.status, 200);
			assert.deepEqual(Object.keys(state.json).sort(), [
				"activatingSessionIds",
				"messageWindowsBySession",
				"messagesBySession",
				"pendingUiRequests",
				"projects",
				"runtimes",
				"sessions",
			]);
			assert.equal(state.json.projects.some((entry) => entry.id === PROJECT_ID), true);

			const models = await api(port, "/api/models");
			assert.equal(models.status, 200);
			assert.ok(Array.isArray(models.json.models));

			const runtimes = await api(port, "/api/sessions/runtimes");
			assert.deepEqual(runtimes.json, { runtimes: [] });

			// Project-scoped reads.
			const sessions = await api(port, `/api/projects/${PROJECT_ID}/sessions`);
			assert.equal(sessions.status, 200);
			assert.ok(Array.isArray(sessions.json.sessions));
			const catalog = await api(port, `/api/projects/${PROJECT_ID}/sessions/catalog`);
			assert.equal(catalog.status, 200);
			assert.ok(Array.isArray(catalog.json.sessions));

			// A draft session is catalog metadata only; every history route answers for it.
			const created = await api(port, "/api/sessions", { method: "POST", body: { projectId: PROJECT_ID } });
			assert.equal(created.status, 200);
			assert.ok(created.json.session.id, JSON.stringify(created.json));
			const sessionId = created.json.session.id;
			assert.equal(
				(await api(port, `/api/sessions/${sessionId}/messages`)).json.messages.length,
				0,
			);
			assert.equal((await api(port, `/api/sessions/${sessionId}/reference-messages`)).status, 200);
			const page = await api(port, `/api/sessions/${sessionId}/messages/page?pageSize=2`);
			assert.equal(page.status, 200);
			assert.ok(Array.isArray(page.json.messages), JSON.stringify(page.json));
			const turnPage = await api(port, `/api/sessions/${sessionId}/messages/turn-page?turnCount=3`);
			assert.equal(turnPage.status, 200);
			assert.ok(Array.isArray(turnPage.json.messages));

			// Unknown routes and method mismatches are 404 — never a generic 200.
			for (const path of [
				"/api/nope",
				"/api/sessions/does-not-exist/unknown-action",
				`/api/projects/${PROJECT_ID}/delete`, // POST-only
				"/api/sessions/x/runtime/bogus", // not in the action alternation
			]) {
				const response = await api(port, path);
				assert.equal(response.status, 404, `${path} must be 404`);
				assert.equal(response.json.code, "webError.apiNotFound", path);
			}

			// Validation failures are 400 with the oracle's code, not 500.
			const missingProjectId = await api(port, "/api/sessions", { method: "POST", body: {} });
			assert.equal(missingProjectId.status, 400);
			assert.equal(missingProjectId.json.code, "webError.projectIdRequired");

			const missingPath = await api(port, "/api/projects", { method: "POST", body: { path: "  " } });
			assert.equal(missingPath.status, 400);
			assert.equal(missingPath.json.code, "webError.projectPathRequired");

			const badTurnPage = await api(port, `/api/sessions/${sessionId}/messages/turn-page?turnCount=0`);
			assert.equal(badTurnPage.status, 400);
			assert.equal(badTurnPage.json.code, "webError.invalidMessagePage");

			const promptWithoutRequestId = await api(port, `/api/sessions/${sessionId}/prompt`, {
				method: "POST",
				body: { message: "hi" },
			});
			assert.equal(promptWithoutRequestId.status, 400);
			assert.equal(promptWithoutRequestId.json.code, "webError.requestIdRequired");

			const emptyPrompt = await api(port, `/api/sessions/${sessionId}/prompt`, {
				method: "POST",
				body: { requestId: "r1", message: "   " },
			});
			assert.equal(emptyPrompt.status, 400);
			assert.equal(emptyPrompt.json.code, "webError.messageRequired");

			// ui-response needs a complete runtime target; an incomplete one is a 400.
			const uiResponse = await api(port, "/api/ui-response", {
				method: "POST",
				body: { sessionId, requestId: "q1" },
			});
			assert.equal(uiResponse.status, 400);
			assert.equal(uiResponse.json.code, "webError.requestIdRequired");

			// A stale-but-complete target reaches the coordinator and comes back as 409.
			const stale = await api(port, "/api/ui-response", {
				method: "POST",
				body: { sessionId, requestId: "q1", agentId: "11111111-1111-1111-1111-111111111111", runtimeGeneration: 99, response: { answer: "x" } },
			});
			assert.equal(stale.status, 409);
			assert.equal(stale.json.code, "webError.runtimeTargetRequired");

			// The stream endpoint is real now (§28): never a 501 placeholder, and never a body
			// that pretends to be a stream without the AI SDK v1 framing. GET only observes, so
			// this stays hermetic (no pi is spawned); the dispatch frames themselves are covered
			// by native2LanStreamParity against a scripted fake pi.
			const stream = await api(port, `/api/sessions/${sessionId}/stream`);
			assert.equal(stream.status, 200);
			assert.equal(stream.headers["x-vercel-ai-ui-message-stream"], "v1");
			assert.match(stream.headers["content-type"], /text\/event-stream/);
			const streamFrames = sseFrames(stream.body);
			assert.ok(streamFrames.length > 0, stream.body);
			for (const frame of streamFrames) assert.equal(typeof frame.type, "string");
			assert.equal(stream.body.endsWith("data: [DONE]\n\n"), true, stream.body);
		});

		test("project create/delete goes through the same project store as the desktop", async (t) => {
			const { port, invoke, fixture } = await start(t);
			const extra = join(root, `web-extra-${Date.now()}`);
			mkdirSync(extra, { recursive: true });

			const created = await api(port, "/api/projects", { method: "POST", body: { path: extra } });
			assert.equal(created.status, 200);
			const project = created.json.project;
			assert.equal(slash(project.path), slash(extra));

			// The desktop renderer sees it too: one project store, no second catalog.
			const desktop = await invoke("projects:list");
			assert.ok(desktop.payload.result.some((entry) => entry.id === project.id));

			const chatProject = (await invoke("projects:list")).payload.result.find((entry) => entry.kind === "chat");
			const chatDelete = await api(port, `/api/projects/${chatProject.id}/delete`, { method: "POST" });
			assert.equal(chatDelete.status, 400);
			assert.equal(chatDelete.json.code, "webError.chatProjectProtected");

			const unknownDelete = await api(port, "/api/projects/nope/delete", { method: "POST" });
			assert.equal(unknownDelete.status, 404);
			assert.equal(unknownDelete.json.code, "webError.projectNotFound");

			const deleted = await api(port, `/api/projects/${project.id}/delete`, { method: "POST" });
			assert.deepEqual(deleted.json, { deleted: true });
			const afterDelete = await invoke("projects:list");
			assert.equal(afterDelete.payload.result.some((entry) => entry.id === project.id), false);
			assert.ok(fixture.userData);
		});

		test("browser bundle: web.html entry, hashed asset cache, missing resource 404, path escape refused", async (t) => {
			const { port } = await start(t);

			const entry = await api(port, "/", { token: null, cookie: `pideck_web_token_${port}=${SECRET}` });
			assert.equal(entry.status, 200);
			assert.match(entry.body, /PiDeck web bundle/);
			assert.equal(entry.headers["cache-control"], "no-store");

			const clientRoute = await api(port, "/sessions/abc", {
				token: null,
				cookie: `pideck_web_token_${port}=${SECRET}`,
			});
			assert.equal(clientRoute.status, 200);
			assert.match(clientRoute.body, /PiDeck web bundle/);

			const asset = await api(port, "/assets/app.js", { token: null, cookie: `pideck_web_token_${port}=${SECRET}` });
			assert.equal(asset.status, 200);
			assert.match(asset.headers["content-type"], /text\/javascript/);
			assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
			assert.match(asset.body, /pideck-app/);

			// A missing asset must stay a 404: returning HTML would be parsed as a module
			// script and white-screen the page with a MIME error.
			const missing = await api(port, "/assets/missing.js", { token: null, cookie: `pideck_web_token_${port}=${SECRET}` });
			assert.equal(missing.status, 404);
			assert.equal(missing.json.code, "webError.apiNotFound");

			// `..%2f` escapes are refused before the filesystem is touched. Sent raw because
			// a normalised URL client would collapse the segments client-side.
			const escaped = await rawHttp(
				port,
				`GET /..%2f..%2fpackage.json HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: pideck_web_token_${port}=${SECRET}\r\nConnection: close\r\n\r\n`,
			);
			assert.match(escaped, /^HTTP\/1\.1 404/, escaped.split("\r\n")[0]);
			assert.equal(escaped.includes("PiDeck-Q"), false);

			// `?view=legacy` is the explicit fallback switch, not a silent substitution: it
			// serves the embedded vanilla client (the same document the no-bundle path uses),
			// so it must not be the React bundle it replaced. Byte fidelity is covered by
			// native2LegacyWebClient; here only the routing contract.
			const legacy = await api(port, "/?view=legacy", { token: null, cookie: `pideck_web_token_${port}=${SECRET}` });
			assert.equal(legacy.status, 200);
			assert.match(legacy.body, /<title>PiDeck-Q Web Service<\/title>/);
			assert.match(legacy.body, /const dictionaries = \{/);
			assert.match(legacy.body, /"zh-CN":\{/);
			assert.match(legacy.body, /"en-US":\{/);
			assert.equal(legacy.body.includes("PiDeck web bundle"), false);
		});

		test("settings:update drives the listener: invalid port fails closed, restart rebinds, token hot-swaps", async (t) => {
			const { port, invoke, fixture } = await start(t);
			assert.equal((await api(port, "/api/state")).status, 200);

			// 1. An invalid port is rejected with the localized copy and disables the feature
			//    so the next launch does not retry a configuration that cannot work.
			const invalid = await invoke("settings:update", [{ webServicePort: 0 }]);
			assert.equal(invalid.payload.ok, false, JSON.stringify(invalid.payload));
			assert.equal(
				invalid.payload.error.message,
				"The web service port must be an integer from 1 to 65535.",
			);
			const afterFailure = JSON.parse(readFileSync(join(fixture.userData, "settings.json"), "utf8"));
			assert.equal(afterFailure.webServiceEnabled, false);

			// 2. Re-enabling on a fresh port starts a real listener there.
			const nextPort = await freePort();
			const enabled = await invoke("settings:update", [
				{
					webServiceEnabled: true,
					webServiceHost: "127.0.0.1",
					webServicePort: nextPort,
					webServiceAccessToken: SECRET,
				},
			]);
			assert.equal(enabled.payload.ok, true, JSON.stringify(enabled.payload));
			await waitForWeb(nextPort);
			assert.equal((await api(nextPort, "/api/state")).status, 200);

			// 3. The old endpoint is closed: a moved service must not keep answering.
			await assert.rejects(httpRequest(`http://127.0.0.1:${port}/api/state`));

			// 4. `settings:restart-web-service` resolves and keeps the same endpoint.
			const restarted = await invoke("settings:restart-web-service");
			assert.equal(restarted.payload.ok, true, JSON.stringify(restarted.payload));
			await waitForWeb(nextPort);

			// 5. A token-only change hot-swaps without rebinding: the port keeps answering
			//    immediately and the previous token is dead.
			const rotated = "rotated-lan-web-token-ABCDEF0123456789";
			const swap = await invoke("settings:update", [{ webServiceAccessToken: rotated }]);
			assert.equal(swap.payload.ok, true, JSON.stringify(swap.payload));
			assert.equal((await api(nextPort, "/api/state")).status, 401);
			assert.equal((await api(nextPort, "/api/state", { token: rotated })).status, 200);
			const health = await httpRequest(`http://127.0.0.1:${nextPort}/api/health`);
			assert.equal(JSON.parse(health.body).port, nextPort);

			// 6. Disabling stops the listener; restart must not bring it back.
			const disabled = await invoke("settings:update", [{ webServiceEnabled: false }]);
			assert.equal(disabled.payload.ok, true, JSON.stringify(disabled.payload));
			await assert.rejects(httpRequest(`http://127.0.0.1:${nextPort}/api/health`));
			const noopRestart = await invoke("settings:restart-web-service");
			assert.equal(noopRestart.payload.ok, true, JSON.stringify(noopRestart.payload));
			await assert.rejects(httpRequest(`http://127.0.0.1:${nextPort}/api/health`));
		});

		test("a live runtime is served through the same coordinator, and diagnostics never leak", async (t) => {
			const scenario = {
				state: { sessionName: "web runtime", model: { provider: "anthropic", modelId: "claude-sonnet-4" } },
				messages: [
					{ role: "user", content: [{ type: "text", text: "hello from the web" }], timestamp: 1_767_225_601_000 },
					{ role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 1_767_225_602_000 },
				],
				entries: { entries: [], leafId: null },
				models: [{ provider: "anthropic", modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }],
				commands: [],
			};
			const { port, invoke, fixture, fake } = await start(t, { scenario });
			const filePath = writeSessionFile(fixture.sessions, projectPath, `web-${Date.now()}`, { olderTurn: true });

			const listed = await invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "the session file must be imported into the catalog");

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;
			assert.ok(fake, "the fake pi must have been spawned");

			// `/api/state` carries the runtime, its messages and the activating set — all
			// from the coordinator the desktop tab uses, not a second process.
			const state = await api(port, "/api/state");
			assert.equal(state.json.runtimes.length, 1);
			assert.equal(state.json.runtimes[0].sessionId, record.id);
			assert.equal(state.json.runtimes[0].agentId, target.agentId);
			assert.equal(state.json.runtimes[0].runtimeGeneration, target.runtimeGeneration);
			assert.ok(Array.isArray(state.json.messagesBySession[record.id]), "live messages must be exposed");
			assert.deepEqual(state.json.activatingSessionIds, []);

			// The runtime action routes accept the echoed target and answer the command result.
			const runtimeState = await api(port, `/api/sessions/${record.id}/runtime/state`, {
				method: "POST",
				body: { target },
			});
			assert.equal(runtimeState.status, 200);
			assert.equal(runtimeState.json.result.ok, true, JSON.stringify(runtimeState.json));

			const commands = await api(port, `/api/sessions/${record.id}/runtime/commands`, {
				method: "POST",
				body: { target },
			});
			assert.equal(commands.json.result.ok, true);

			const models = await api(port, `/api/sessions/${record.id}/runtime/models`, {
				method: "POST",
				body: { target },
			});
			assert.equal(models.json.result.ok, true);

			// A target whose sessionId does not match the path is rejected before any
			// command reaches the runtime.
			const mismatched = await api(port, `/api/sessions/${record.id}/runtime/state`, {
				method: "POST",
				body: { target: { ...target, sessionId: "someone-else" } },
			});
			assert.equal(mismatched.status, 400);
			assert.equal(mismatched.json.code, "webError.runtimeTargetRequired");

			// A stale generation fails inside the coordinator; the browser must not receive
			// the debugDetails the desktop error envelope carries.
			const stale = await api(port, `/api/sessions/${record.id}/runtime/state`, {
				method: "POST",
				body: { target: { ...target, runtimeGeneration: target.runtimeGeneration + 9 } },
			});
			assert.equal(stale.status, 200);
			assert.equal(stale.json.result.ok, false, JSON.stringify(stale.json));
			assert.equal(stale.body.includes("debugDetails"), false, stale.body);

			// Messages come from the file-backed pager for the same record.
			const messages = await api(port, `/api/sessions/${record.id}/messages`);
			assert.equal(messages.status, 200);
			assert.ok(messages.json.messages.length >= 2, JSON.stringify(messages.json));
			const original = messages.json.messages.find((row) => row.text === "older question");
			const edit = await api(port, `/api/sessions/${record.id}/runtime/edit-message`, {
				method: "POST", body: { target, messageId: original.id, newText: "edited older question" },
			});
			assert.equal(edit.json.result.ok, true, JSON.stringify(edit.json));
			const revision = edit.json.result.value.value.historyMutationRevision;
			assert.ok(revision > 0);
			const afterEdit = (await api(port, "/api/state")).json;
			assert.equal(afterEdit.messageWindowsBySession[record.id].historyMutationRevision, revision);
			assert.equal(afterEdit.messageWindowsBySession[record.id].totalLength, state.json.messagesBySession[record.id].length);
			const seam = afterEdit.messageWindowsBySession[record.id].windowStartFilePos;
			assert.equal(seam, 1);
			assert.deepEqual(afterEdit.messagesBySession[record.id], state.json.messagesBySession[record.id]);
			for (const cursor of [`before=${seam}`, "beforeEntryId=u1"]) {
				const older = await api(port, `/api/sessions/${record.id}/messages/turn-page?turnCount=1&${cursor}`);
				assert.equal(older.status, 200);
				assert.deepEqual(older.json.messages.map((row) => row.text), ["edited older question"]);
			}

			// Deleting a running session is a business rejection (400), not a broken service.
			const blocked = await api(port, `/api/sessions/${record.id}/delete`, { method: "POST" });
			assert.equal(blocked.status, 400);
			assert.equal(blocked.json.code, "webError.deleteSessionBlocked");
			assert.match(blocked.json.error, /stop/i);
		});

		test("an imported Codex subagent rollout is catalogued but never published on /api/state", async (t) => {
			const scenario = {
				state: { sessionName: "web subagent", model: { provider: "anthropic", modelId: "claude-sonnet-4" } },
				messages: [],
				entries: { entries: [], leafId: null },
				models: [],
				commands: [],
			};
			const { port, invoke, fixture } = await start(t, { scenario });

			const visiblePath = writeSessionFile(fixture.sessions, projectPath, `web-visible-${Date.now()}`);
			const subagentPath = writeCodexSubagentSessionFile(
				fixture.sessions,
				projectPath,
				`web-subagent-${Date.now()}`,
			);

			const listed = await invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const records = listed.payload.result;
			const visible = records.find((entry) => slash(entry.filePath) === slash(visiblePath));
			const subagent = records.find((entry) => slash(entry.filePath) === slash(subagentPath));
			assert.ok(visible, "the user session must be catalogued");
			// The catalog keeps the rollout (the desktop lists it under its parent); only the
			// browser surface hides it. Hiding it from the catalog itself would be a different,
			// data-losing change.
			assert.ok(subagent, "the imported subagent rollout must still be catalogued");
			assert.equal(subagent.codexThreadSource, "subagent");

			// The desktop can activate the subagent session: the row really exists with its own
			// runtime, so the web assertions below are about filtering, not about a missing runtime.
			const activated = await invoke("sessions:runtime-activate", [subagent.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const desktopRuntimes = await invoke("sessions:runtime-list");
			assert.equal(desktopRuntimes.payload.ok, true, JSON.stringify(desktopRuntimes.payload));
			assert.ok(
				desktopRuntimes.payload.result.some((runtime) => runtime.sessionId === subagent.id),
				JSON.stringify(desktopRuntimes.payload.result),
			);

			const state = await api(port, "/api/state");
			assert.equal(state.status, 200);
			const ids = state.json.sessions.map((entry) => entry.id);
			assert.ok(ids.includes(visible.id), JSON.stringify(ids));
			assert.equal(ids.includes(subagent.id), false, "a Codex subagent rollout is not a web session");
			// The derived maps follow the same visibility rule: a hidden row must not leak its
			// runtime, messages or pending questions into the browser payload.
			assert.deepEqual(state.json.runtimes, []);
			assert.equal(Object.hasOwn(state.json.messagesBySession, subagent.id), false);
			assert.deepEqual(state.json.pendingUiRequests, []);
			assert.deepEqual(state.json.activatingSessionIds, []);
		});
	});
}
