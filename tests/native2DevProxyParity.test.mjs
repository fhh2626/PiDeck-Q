import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import {
	MockVite,
	RawWebSocketClient,
	TEST_MASK,
	decodeFrame,
	encodeFrame,
	waitFor,
} from "./helpers/native2MockVite.mjs";

/**
 * Dev renderer proxy parity (`WebServiceManager.ts` `proxyDevRenderer` /
 * `proxyDevWebSocket`, ported to `native/backend/domain/web/WebDev*`).
 *
 * The proxy only exists in dev (`PIDECK_DEV_RENDERER_URL`), but it is still a LAN surface:
 * an authenticated browser's request is relayed to a local Vite server, and the HMR
 * WebSocket carries both directions. These tests therefore drive the real
 * `PiDeckBackend.exe` against a real HTTP + WebSocket mock (`native2MockVite`) and assert
 * browser-visible bytes only:
 *
 *  - path mapping (client routes -> `/web.html`, `/@vite/*` passthrough, exact query),
 *  - the token/cookie never reaching the dev server, and the response header allowlist
 *    (`no-store`, no upstream `location`),
 *  - the three degrade paths (document fallback page, module 503, module 404 for Vite's
 *    SPA fallback) plus a bounded head deadline,
 *  - the HMR upgrade: real `101` with Vite's computed `Sec-WebSocket-Accept`, masked client
 *    frames forwarded byte-for-byte, unmasked server frames received byte-for-byte,
 *    disconnect closing both sides, and service stop aborting the relay.
 *
 * No real dev server, network or user data is involved.
 */

const SECRET = "lan-web-secret-token-0123456789ABCDEF";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const executable = resolveBackendExecutable();

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
			const response = await boundedRequest(port, "/api/health", { timeoutMs: 2_000 });
			if (response.status === 200) return JSON.parse(response.body.toString("utf8"));
		} catch (error) {
			lastError = error;
		}
		await sleep(50);
	}
	throw new Error(`web service did not start on ${port}: ${lastError?.message ?? "timeout"}`);
}

/**
 * Bounded HTTP request with a binary body.
 *
 * `httpRequest` in the shared harness has no timeout by design; every request in this
 * suite must be bounded, because the failure modes under test are "server never answers"
 * and "connection dies mid-body". A timeout destroys the request instead of leaking it.
 */
function boundedRequest(port, path, { method = "GET", headers = {}, timeoutMs = 10_000 } = {}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer = null;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			callback(value);
		};
		const request = nodeRequest({ host: "127.0.0.1", port, path, method, headers });
		timer = setTimeout(() => {
			request.destroy(new Error(`request to ${path} timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		request.on("response", (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () =>
				finish(resolve, {
					status: response.statusCode,
					headers: response.headers,
					body: Buffer.concat(chunks),
				}),
			);
			response.on("error", (error) => finish(reject, error));
			response.on("aborted", () => finish(reject, new Error(`${path} response was aborted`)));
		});
		request.on("error", (error) => finish(reject, error));
		request.end();
	});
}

/**
 * Exchange the LAN token for the HttpOnly cookie the browser would use and return that
 * exact `name=value` pair. The cookie is observed, not constructed: the auth module owns
 * the per-port name.
 */
async function login(port) {
	const response = await boundedRequest(port, `/?pideck_token=${SECRET}`);
	assert.equal(response.status, 302, "query token exchange must redirect");
	const setCookie = response.headers["set-cookie"]?.[0] ?? "";
	const cookie = setCookie.split(";")[0];
	assert.ok(
		cookie.startsWith(`pideck_web_token_${port}=${SECRET}`),
		`unexpected auth cookie: ${setCookie}`,
	);
	return cookie;
}

/** Start the mock dev server and register its cleanup. */
async function startVite(t, options = {}) {
	const vite = await new MockVite(options).start();
	t.after(() => vite.stop());
	return vite;
}

/** Assert the LAN listener stops accepting connections (bounded poll). */
async function expectListenerClosed(port, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			await boundedRequest(port, "/api/health", { timeoutMs: 1_000 });
		} catch (error) {
			lastError = error;
			break;
		}
		await sleep(50);
	}
	assert.ok(lastError, "the listener still answered after the web service stopped");
	assert.match(String(lastError.code ?? lastError.message), /ECONNREFUSED|ECONNRESET|EHOSTUNREACH/);
}

/** Read a whole response while the browser keeps the socket paused for a while. */
function slowReadRequest(port, path, { pauseMs = 400, headers = {}, timeoutMs = 20_000 } = {}) {
	return new Promise((resolve, reject) => {
		let timer = null;
		const request = nodeRequest({ host: "127.0.0.1", port, path, headers });
		timer = setTimeout(() => request.destroy(new Error(`slow read timed out: ${path}`)), timeoutMs);
		request.on("response", (response) => {
			const chunks = [];
			response.pause();
			setTimeout(() => {
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					clearTimeout(timer);
					resolve(Buffer.concat(chunks));
				});
				response.on("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				response.resume();
			}, pauseMs);
		});
		request.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		request.end();
	});
}

if (!executable) {
	describe("native2 dev renderer proxy parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 dev renderer proxy parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-devproxy-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * Boot a backend whose LAN service relays to `target`.
		 *
		 * `target` is the `PIDECK_DEV_RENDERER_URL` value; omit it for the bundle path.
		 */
		async function startProxy(t, { target, settings = {}, webRenderer = false } = {}) {
			const port = await freePort();
			const session = await startBackendSession(t, {
				projects: [{ id: "web", path: projectPath }],
				settings: {
					language: "en-US",
					webServiceEnabled: true,
					webServiceHost: "127.0.0.1",
					webServicePort: port,
					webServiceAccessToken: SECRET,
					...settings,
				},
				env: target === undefined ? {} : { PIDECK_DEV_RENDERER_URL: target },
				prepare: webRenderer
					? (fixture) => {
							writeFileSync(
								join(fixture.renderer, "web.html"),
								"<!doctype html><html><body>PiDeck web bundle</body></html>",
							);
							return null;
						}
					: null,
			});
			await waitForWeb(port);
			return { ...session, port };
		}

		test("documents map to /web.html, relay the body, and cannot smuggle upstream headers", async (t) => {
			const vite = await startVite(t, {
				routes: {
					"/web.html": {
						contentType: "text/html; charset=utf-8",
						body: "<html>vite dev shell</html>",
						// A dev server's own cache directive and arbitrary header must not be
						// relayed: the LAN client always gets `no-store` and the allowlist only.
						headers: { "cache-control": "max-age=600", "x-vite-only": "1" },
					},
					"/nested/page.html?theme=dark": {
						contentType: "text/html; charset=utf-8",
						body: "<html>nested document</html>",
					},
				},
			});
			const { port } = await startProxy(t, { target: vite.origin });
			const cookie = await login(port);

			const document = await boundedRequest(port, "/", { headers: { cookie } });
			assert.equal(document.status, 200);
			assert.equal(document.body.toString("utf8"), "<html>vite dev shell</html>");
			assert.equal(document.headers["content-type"], "text/html; charset=utf-8");
			assert.equal(document.headers["cache-control"], "no-store");
			assert.equal(document.headers["x-vite-only"], undefined);

			const seen = vite.requests.at(-1);
			assert.equal(seen.method, "GET");
			assert.equal(seen.url, "/web.html", "root must map to the web entry document");
			assert.equal(seen.headers.host, `127.0.0.1:${vite.port}`, "host must be rewritten");
			assert.equal(seen.headers.cookie, undefined, "the LAN cookie must not reach vite");
			assert.equal(seen.headers.authorization, undefined);

			// A client route (no extension) loads the same entry document; the query is
			// dropped exactly like the oracle's `"/web.html"` branch.
			const clientRoute = await boundedRequest(port, "/sessions/abc?tab=chat", { headers: { cookie } });
			assert.equal(clientRoute.status, 200);
			assert.equal(vite.requests.at(-1).url, "/web.html");

			// A `.html` document keeps its query.
			const nested = await boundedRequest(port, "/nested/page.html?theme=dark", { headers: { cookie } });
			assert.equal(nested.status, 200);
			assert.equal(vite.requests.at(-1).url, "/nested/page.html?theme=dark");

			// A `pideck_token` query parameter is consumed by the auth ladder (302 exchange),
			// so it can never be relayed to the dev server — not even when the request also
			// carries a valid cookie. This is why the relay's own strip is defense in depth.
			const proxiedBefore = vite.requests.length;
			const exchanged = await boundedRequest(port, `/?pideck_token=${SECRET}`, { headers: { cookie } });
			assert.equal(exchanged.status, 302);
			assert.equal(vite.requests.length, proxiedBefore, "a token exchange must not reach the dev server");
		});

		test("modules keep path and query; SPA HTML, non-200, redirects and malformed heads are bounded", async (t) => {
			const vite = await startVite(t, {
				routes: {
					"/src/main.tsx?v=42&import=1": {
						contentType: "text/javascript; charset=utf-8",
						body: "console.log('dev module');",
					},
					"/@vite/client?x=1": {
						contentType: "text/javascript; charset=utf-8",
						body: "export const client = 1;",
					},
					// Vite answers an outdated dependency with 504 and keeps its content type.
					"/stale.js": { status: 504, contentType: "text/javascript; charset=utf-8" },
					// Vite's SPA fallback: 200 + HTML for a path that is not a document.
					"/spa-fallback.js": { contentType: "text/html; charset=utf-8", body: "<html>index</html>" },
					// A redirect must never be followed and its `location` never forwarded.
					"/redirect.js": {
						status: 302,
						headers: { location: "http://127.0.0.1:1/elsewhere" },
						contentType: "text/plain",
					},
					// Invalid head: a header line without a colon. The relay must not pass it on.
					"/bad-head.js": { raw: "HTTP/1.1 200 OK\r\nnot-a-header\r\n\r\n" },
					// Head says 100 bytes, the dev server closes after 7: the browser must see a
					// failed module load, not a short body that looks complete.
					"/truncated.js": {
						raw: "HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\ncontent-length: 100\r\n\r\npartial",
					},
				},
			});
			const { port } = await startProxy(t, { target: vite.origin });
			const cookie = await login(port);

			const module = await boundedRequest(port, "/src/main.tsx?v=42&import=1", { headers: { cookie } });
			assert.equal(module.status, 200);
			assert.equal(module.body.toString("utf8"), "console.log('dev module');");
			assert.equal(module.headers["content-type"], "text/javascript; charset=utf-8");
			assert.equal(module.headers["cache-control"], "no-store");
			assert.equal(
				vite.requests.at(-1).url,
				"/src/main.tsx?v=42&import=1",
				"module URL must keep ?v=/?import exactly",
			);

			// Same rule on the module path: a query token is answered by auth (302) and never
			// reaches the dev server, even with a valid cookie present.
			const proxiedBefore = vite.requests.length;
			const exchange = await boundedRequest(port, `/src/main.tsx?v=42&pideck_token=${SECRET}`, {
				headers: { cookie },
			});
			assert.equal(exchange.status, 302);
			assert.equal(vite.requests.length, proxiedBefore);

			// `/@*` is a Vite internal module even without an extension.
			const internal = await boundedRequest(port, "/@vite/client?x=1", { headers: { cookie } });
			assert.equal(internal.status, 200);
			assert.equal(vite.requests.at(-1).url, "/@vite/client?x=1");

			const stale = await boundedRequest(port, "/stale.js", { headers: { cookie } });
			assert.equal(stale.status, 504, "module non-200 must pass the status through");
			assert.equal(stale.headers["content-type"], "text/javascript; charset=utf-8");
			assert.equal(stale.body.length, 0);
			assert.equal(stale.headers["cache-control"], "no-store");

			const spa = await boundedRequest(port, "/spa-fallback.js", { headers: { cookie } });
			assert.equal(spa.status, 404, "HTML for a module request is a 404, not a MIME error page");
			assert.deepEqual(JSON.parse(spa.body.toString("utf8")), {
				code: "webError.apiNotFound",
				error: "Not found: /spa-fallback.js",
			});

			const redirected = await boundedRequest(port, "/redirect.js", { headers: { cookie } });
			assert.equal(redirected.status, 302);
			assert.equal(redirected.headers.location, undefined, "location must never be forwarded");
			assert.equal(redirected.body.length, 0);

			const missing = await boundedRequest(port, "/missing.js", { headers: { cookie } });
			assert.equal(missing.status, 404, "the mock's own 404 is passed through");
			assert.equal(missing.body.length, 0);

			const malformed = await boundedRequest(port, "/bad-head.js", { headers: { cookie } });
			assert.equal(malformed.status, 503);
			assert.deepEqual(JSON.parse(malformed.body.toString("utf8")), {
				code: "webError.internal",
				error: "Renderer dev server not ready",
			});

			await assert.rejects(
				boundedRequest(port, "/truncated.js", { headers: { cookie } }),
				"a truncated module body must not resolve as a complete response",
			);
		});

		test("auth gate runs before the proxy: anonymous and wrong-token requests never reach vite", async (t) => {
			const vite = await startVite(t, {
				routes: { "/web.html": { contentType: "text/html; charset=utf-8", body: "<html>dev</html>" } },
			});
			const { port } = await startProxy(t, { target: vite.origin });

			const anonymous = await boundedRequest(port, "/");
			assert.equal(anonymous.status, 401);
			assert.equal(vite.requests.length, 0);

			const wrong = await boundedRequest(port, "/", {
				headers: { cookie: `pideck_web_token_${port}=wrong-token` },
			});
			assert.equal(wrong.status, 401);
			assert.equal(vite.requests.length, 0);

			// The HMR upgrade goes through the same ladder: an unauthenticated handshake is
			// refused and the dev server never sees an upgrade. (The oracle destroys the socket;
			// the port answers 401 first. Both are a refusal, so either ending is accepted.)
			const ws = new RawWebSocketClient(vite, { path: "/" });
			t.after(() => ws.destroy());
			let status = null;
			let refusal = "";
			try {
				await ws.connect(port);
				await ws.waitForHead();
				status = ws.status;
			} catch (error) {
				refusal = error.message;
			}
			if (status !== null) assert.equal(status, 401);
			else assert.match(refusal, /ECONNRESET|closed before/);
			assert.equal(vite.upgrades.length, 0, "an unauthenticated upgrade must not be proxied");
		});

		test("HMR upgrade relays vite's accept hash and both directions byte-for-byte", async (t) => {
			const vite = await startVite(t, {
				routes: { "/web.html": { contentType: "text/html; charset=utf-8", body: "<html>dev</html>" } },
			});
			const { port } = await startProxy(t, { target: vite.origin });
			const cookie = await login(port);

			const client = new RawWebSocketClient(vite, {
				path: "/?client=hmr",
				headers: { cookie, origin: `http://127.0.0.1:${port}` },
			});
			t.after(() => client.destroy());
			await client.connect(port);
			await client.waitForHead();

			assert.equal(client.status, 101);
			const expectedAccept = createHash("sha1").update(client.key + WS_GUID).digest("base64");
			assert.equal(
				client.head["sec-websocket-accept"],
				expectedAccept,
				"the accept hash must be vite's, computed from the browser's key",
			);

			assert.equal(vite.upgrades.length, 1);
			const upstream = vite.upgrades[0];
			assert.equal(upstream.url, "/?client=hmr", "the HMR target keeps the browser's own query");
			assert.equal(upstream.headers.host, `127.0.0.1:${vite.port}`);
			assert.equal(upstream.headers.origin, vite.origin, "origin must be rewritten for vite's HMR check");
			assert.equal(upstream.headers["sec-websocket-protocol"], "vite-hmr");
			assert.equal(upstream.headers.cookie, undefined, "the LAN cookie must not reach vite");
			assert.equal(upstream.headers.authorization, undefined);

			// Masked client frames: 15 bytes (7-bit length) and 70 000 bytes (64-bit length,
			// crossing the relay's 64 KiB read chunks) must arrive masked and unchanged.
			const smallFrame = encodeFrame("hmr-update", { mask: TEST_MASK });
			const bigPayload = Buffer.alloc(70_000, 0x61);
			const bigFrame = encodeFrame(bigPayload, { mask: TEST_MASK });
			client.write(smallFrame);
			client.write(bigFrame);
			await waitFor(
				() => upstream.received.length >= smallFrame.length + bigFrame.length,
				{ timeoutMs: 10_000, message: "masked frames at vite" },
			);
			assert.ok(
				upstream.received.equals(Buffer.concat([smallFrame, bigFrame])),
				"client frames must be forwarded without re-framing or unmasking",
			);
			const decoded = decodeFrame(upstream.received);
			assert.equal(decoded.frame.masked, true);
			assert.equal(decoded.frame.payload.toString("utf8"), "hmr-update");

			// Unmasked server frames come back untouched.
			const pushA = encodeFrame("server-push", { opcode: 0x1 });
			const pushB = encodeFrame("second-push");
			upstream.write(pushA);
			upstream.write(pushB);
			const body = await client.waitForBody(pushA.length + pushB.length);
			assert.ok(
				body.subarray(0, pushA.length + pushB.length).equals(Buffer.concat([pushA, pushB])),
				"server frames must be forwarded byte-for-byte",
			);

			// Browser leaves: the dev server socket must follow instead of hanging half-open.
			client.destroy();
			await waitFor(() => upstream.closed, { timeoutMs: 5_000, message: "vite HMR socket close" });

			// A query token on the upgrade is answered by the auth ladder (302) instead of being
			// forwarded, so the token cannot be captured by a dev-server access log.
			const tokenClient = new RawWebSocketClient(vite, {
				path: `/?pideck_token=${SECRET}`,
				headers: { cookie },
			});
			t.after(() => tokenClient.destroy());
			let tokenStatus = null;
			let tokenRefusal = "";
			try {
				await tokenClient.connect(port);
				await tokenClient.waitForHead();
				tokenStatus = tokenClient.status;
			} catch (error) {
				tokenRefusal = error.message;
			}
			if (tokenStatus !== null) assert.equal(tokenStatus, 302);
			else assert.match(tokenRefusal, /ECONNRESET|closed before/);
			assert.equal(vite.upgrades.length, 1, "a query-token upgrade must not reach the dev server");
		});

		test("a refused upgrade is relayed and the browser socket is closed", async (t) => {
			const vite = await startVite(t, {
				routes: { "/web.html": { contentType: "text/html; charset=utf-8", body: "<html>dev</html>" } },
				upgradeStatus: (request) => (request.url.startsWith("/__refused") ? 403 : 101),
			});
			const { port } = await startProxy(t, { target: vite.origin });
			const cookie = await login(port);

			const client = new RawWebSocketClient(vite, { path: "/__refused", headers: { cookie } });
			t.after(() => client.destroy());
			await client.connect(port);
			await client.waitForHead();
			assert.equal(client.status, 403);
			assert.equal(vite.upgrades[0].refused, 403);
			await client.waitForClose(5_000);
		});

		test("large module bodies survive a paused browser socket (backpressure, no truncation)", async (t) => {
			const payload = Buffer.alloc(2 * 1024 * 1024);
			for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31) & 0xff;
			const vite = await startVite(t, {
				routes: {
					"/big.js": { contentType: "text/javascript; charset=utf-8", body: payload },
				},
			});
			const { port } = await startProxy(t, { target: vite.origin });
			const cookie = await login(port);

			// 2 MiB is far beyond the 256 KiB high-water mark, so pausing the reader forces the
			// relay to throttle the dev server instead of buffering everything.
			const body = await slowReadRequest(port, "/big.js", { pauseMs: 400, headers: { cookie } });
			assert.equal(body.length, payload.length);
			assert.ok(body.equals(payload), "the relayed body was altered or truncated under backpressure");
		});

		test("a dev server that accepts but never answers is bounded by the head deadline", async (t) => {
			const vite = await startVite(t, {
				routes: { "/hang.js": { hang: true } },
			});
			const { port } = await startProxy(t, { target: vite.origin });
			const cookie = await login(port);

			const started = Date.now();
			const response = await boundedRequest(port, "/hang.js", { headers: { cookie }, timeoutMs: 50_000 });
			const elapsedMs = Date.now() - started;
			assert.equal(response.status, 503);
			assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
				code: "webError.internal",
				error: "Renderer dev server not ready",
			});
			// The deadline is 30 s: an immediate fallback would mean the relay never connected.
			assert.ok(elapsedMs >= 25_000, `answered before the deadline: ${elapsedMs} ms`);
			assert.ok(elapsedMs < 45_000, `deadline not enforced: ${elapsedMs} ms`);
			assert.equal(vite.requests.at(-1).hang, true);
		});

		test("an unreachable dev server: documents fall back to the embedded page, modules are 503", async (t) => {
			const closedPort = await freePort();
			const { port } = await startProxy(t, { target: `http://127.0.0.1:${closedPort}` });
			const cookie = await login(port);

			const document = await boundedRequest(port, "/", { headers: { cookie } });
			assert.equal(document.status, 200, "a blank page is never the fallback");
			assert.match(document.body.toString("utf8"), /<title>PiDeck-Q Web Service<\/title>/);
			assert.equal(document.headers["cache-control"], "no-store");

			const module = await boundedRequest(port, "/src/app.js", { headers: { cookie } });
			assert.equal(module.status, 503, "a module request must never receive the HTML page");
			assert.deepEqual(JSON.parse(module.body.toString("utf8")), {
				code: "webError.internal",
				error: "Renderer dev server not ready",
			});
		});

		test("a non-loopback dev target is refused, logged, and the bundle is served instead", async (t) => {
			// TEST-NET-1: valid syntax, not loopback, and unreachable. If the loopback guard
			// regressed, this test would attempt an outbound connection instead of failing fast.
			const { port, invoke } = await startProxy(t, {
				target: "http://192.0.2.10:5173",
				webRenderer: true,
			});
			const cookie = await login(port);

			const document = await boundedRequest(port, "/", { headers: { cookie } });
			assert.equal(document.status, 200);
			assert.match(document.body.toString("utf8"), /PiDeck web bundle/);

			// The refusal is observable in the app log, not silent.
			const deadline = Date.now() + 10_000;
			let entry = null;
			while (Date.now() < deadline && !entry) {
				const listed = await invoke("logs:list", [{ search: "Dev renderer proxy disabled", level: "warn" }]);
				entry = (listed.payload.result ?? []).find(
					(candidate) => candidate.message === "Dev renderer proxy disabled",
				);
				if (!entry) await sleep(100);
			}
			assert.ok(entry, "the rejected dev target was not logged");
			assert.match(String(entry.detail?.error ?? ""), /loopback/);
		});

		test("stopping the web service aborts in-flight HMR relays and closes the listener", async (t) => {
			const vite = await startVite(t, {
				routes: { "/web.html": { contentType: "text/html; charset=utf-8", body: "<html>dev</html>" } },
			});
			const { port, invoke } = await startProxy(t, { target: vite.origin });
			const cookie = await login(port);

			const client = new RawWebSocketClient(vite, { path: "/", headers: { cookie } });
			t.after(() => client.destroy());
			await client.connect(port);
			await client.waitForHead();
			assert.equal(client.status, 101);
			const upstream = vite.upgrades[0];

			await invoke("settings:update", [{ webServiceEnabled: false }]);
			await waitFor(() => client.closed, { timeoutMs: 5_000, message: "browser HMR socket close" });
			await waitFor(() => upstream.closed, { timeoutMs: 5_000, message: "vite HMR socket close" });
			await expectListenerClosed(port);
		});

		test("the backend exits cleanly after proxied traffic (finished relay and live HMR socket)", async (t) => {
			// Regression: the proxy used to track exchanges with `QPointer` and delete the relay
			// through a non-virtual destructor. A finished exchange then left a stale weak entry
			// whose destruction hung `abortAll()`, so the backend never exited after *any*
			// proxied request and the harness had to kill it (measured: +3 s per test, and an
			// unreachable dev target took 11 s). `prepareQuit` is the only exit path, so this
			// asserts it directly instead of relying on the fixture's bounded kill.
			const vite = await startVite(t, {
				routes: { "/web.html": { contentType: "text/html; charset=utf-8", body: "<html>dev</html>" } },
			});
			const session = await startProxy(t, { target: vite.origin });
			const cookie = await login(session.port);
			await boundedRequest(session.port, "/", { headers: { cookie } });

			const client = new RawWebSocketClient(vite, { path: "/", headers: { cookie } });
			t.after(() => client.destroy());
			await client.connect(session.port);
			await client.waitForHead();
			assert.equal(client.status, 101);

			session.host.emit("application.prepareQuit");
			const exited = await Promise.race([
				session.backend.exited,
				new Promise((resolve) => setTimeout(() => resolve(null), 8_000)),
			]);
			assert.ok(exited, "the backend did not exit after prepareQuit with proxy relays present");
			assert.equal(exited.code, 0, `the backend exited with ${exited.code}`);
		});
	});
}
