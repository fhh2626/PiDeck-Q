import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { startBackendSession } from "./helpers/native2BackendHarness.mjs";

/**
 * Desktop proxy + `settings:test-pi-proxy` + non-OpenAI provider families.
 *
 * Two different policies exist in the oracle and both are exercised here:
 *  - `PiProxyTester` (the settings probe) opens its own socket and matches the bypass
 *    list with ports; a `socks5://` address is *not* supported there.
 *  - `NodeProxy`/`DesktopProxy` (the app's own traffic) always bypasses loopback and
 *    matches user rules without ports.
 *
 * The backend is the real `PiDeckBackend.exe`; every golden is executed production Node
 * code (`PiProxyTester`, `DesktopProxy`, `NodeProxy`, `ConfigManager`), never a copy of
 * a constant.
 */

const { mainProcessT } = loadTsCommonJs(resolve("src/shared/i18n/mainProcessCopy.ts"));
// `PiProxyTester` classifies failures with `error instanceof Error` and by message
// prefix. The vm realm has its own intrinsics, so the outer `Error` types are injected:
// otherwise every socket/URL error degrades to `unknownError` and the comparison would
// be meaningless.
const { testPiProxy } = loadTsCommonJs(resolve("src/main/pi/PiProxyTester.ts"), {
	globals: { Error: globalThis.Error, TypeError: globalThis.TypeError },
});
const { applyDesktopProxy } = loadTsCommonJs(resolve("src/main/settings/DesktopProxy.ts"));
const proxyFetchGlobals = {
	fetch: (...args) => globalThis.fetch(...args),
	Request: globalThis.Request,
	Response: globalThis.Response,
	Headers: globalThis.Headers,
	AbortSignal: globalThis.AbortSignal,
	AbortController: globalThis.AbortController,
};
const { NodeProxy } = loadTsCommonJs(resolve("src/native-node/platform/NodeProxy.ts"), {
	globals: proxyFetchGlobals,
});
const { ConfigManager } = loadTsCommonJs(resolve("src/main/config/ConfigManager.ts"), {
	globals: proxyFetchGlobals,
});

const copyFor = (locale) => (key, params) => mainProcessT(locale, key, params ?? {});
/** Timing fields are the only legitimate difference between two real network runs. */
const comparable = (value) => {
	const clone = JSON.parse(JSON.stringify(value ?? null));
	delete clone.elapsedMs;
	delete clone.latencyMs;
	// `requestBody` is a diagnostic echo of the JSON payload. Qt's QJsonObject always
	// sorts keys, so compare the payload, not the byte order of the serializer.
	if (typeof clone.requestBody === "string") {
		try {
			clone.requestBody = JSON.parse(clone.requestBody);
		} catch {
			// keep the raw string when it is not JSON
		}
	}
	return clone;
};

function writeSettings(session, patch) {
	const path = join(session.fixture.userData, "settings.json");
	const current = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...current, ...patch }));
}

/**
 * Minimal HTTP proxy that understands both client shapes the two implementations use:
 * an absolute-URI request (Qt) and `CONNECT` + tunnelled origin-form request (undici's
 * ProxyAgent, which tunnels even plain-HTTP targets).
 */
function createProxyStub({ connectStatus = 200, targetStatus = 204, targetBody = "", hangTunnel = false, rawReply = "", endReply = true } = {}) {
	const records = [];
	const sockets = new Set();
	const server = createTcpServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.on("close", () => sockets.delete(socket));
		let mode = "outside";
		let buffer = Buffer.alloc(0);
		// One TLS hello per tunnel: the ClientHello can arrive in several TCP segments,
		// so only the record header of the first chunk is interesting.
		let helloSeen = false;
		const respond = (status, body) => {
			// `rawReply` writes a hand-built (malformed / oversized / truncated) head instead
			// of a valid one. `endReply` decides whether the peer then closes: an oversized
			// head must *not* be followed by a close, because a peer close while the client
			// has already stopped reading becomes RST, and the oracle's settled socket no
			// longer has an error listener (an update in the test process, not in the app).
			if (rawReply) {
				socket.write(rawReply);
				if (endReply) socket.end();
				return;
			}
			const payload = Buffer.from(body ?? "", "utf8");
			socket.write(
				`HTTP/1.1 ${status} Stub\r\ncontent-type: application/json\r\n`
				+ `content-length: ${payload.length}\r\nconnection: close\r\n\r\n`,
			);
			socket.write(payload);
		};
		const consume = () => {
			for (;;) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				const head = buffer.subarray(0, end).toString("latin1");
				const [requestLine, ...headerLines] = head.split("\r\n");
				const [method, target, version] = requestLine.split(" ");
				const headers = {};
				for (const line of headerLines) {
					const colon = line.indexOf(":");
					if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
				}
				const length = Number(headers["content-length"] ?? 0);
				if (buffer.length < end + 4 + length) return;
				const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
				buffer = buffer.subarray(end + 4 + length);
				const kind = mode === "outside" ? (method === "CONNECT" ? "connect" : "absolute") : "tunnel";
				records.push({ kind, method, target, version, headers, body });
				if (method === "CONNECT") {
					socket.write(`HTTP/1.1 ${connectStatus} Stub\r\n\r\n`);
					if (connectStatus === 200) mode = hangTunnel ? "hang" : "tunnel";
					continue;
				}
				respond(targetStatus, targetBody);
			}
		};
		socket.on("data", (chunk) => {
			if (mode === "hang") {
				// A real TLS client speaks first; the proxy stays silent so both sides hit
				// their own handshake timeout.
				if (!helloSeen) {
					helloSeen = true;
					records.push({ kind: "tls-hello", firstByte: chunk[0] });
				}
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);
			consume();
		});
	});
	return {
		records,
		start: () => new Promise((done) => server.listen(0, "127.0.0.1", done)),
		get port() {
			return server.address().port;
		},
		url: (credentials = "") => `http://${credentials}127.0.0.1:${server.address().port}`,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((done) => server.close(done));
		},
	};
}

/** Plain HTTP endpoint for provider fixtures; records every request verbatim. */
function createHttpStub(routes) {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: request.method, url: request.url, headers: request.headers, body });
			const pathname = new URL(request.url, "http://stub.local").pathname;
			const fixture = routes[pathname];
			if (!fixture) {
				response.writeHead(404, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "no stub route" }));
				return;
			}
			response.writeHead(fixture.status ?? 200, { "content-type": "application/json" });
			response.end(JSON.stringify(fixture.body));
		});
	});
	return {
		requests,
		start: () => new Promise((done) => server.listen(0, "127.0.0.1", done)),
		get baseUrl() {
			return `http://127.0.0.1:${server.address().port}`;
		},
		async close() {
			await new Promise((done) => server.close(done));
		},
	};
}

async function withProxyStub(t, options, body) {
	const stub = createProxyStub(options);
	await stub.start();
	t.after(() => stub.close());
	return body(stub);
}

async function withHttpStub(t, routes, body) {
	const stub = createHttpStub(routes);
	await stub.start();
	t.after(() => stub.close());
	return body(stub);
}

/** Oracle `testPiProxy` vs the real `settings:test-pi-proxy` channel. */
async function compareProxyProbe(session, settings, testUrl, locale = "zh-CN") {
	writeSettings(session, settings);
	const [oracle, reply] = await Promise.all([
		testPiProxy(settings, testUrl, copyFor(locale)),
		session.invoke("settings:test-pi-proxy"),
	]);
	assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
	const result = comparable(reply.payload.result);
	assert.deepEqual(result, comparable(oracle));
	assert.equal(reply.payload.result.url, testUrl);
	return { oracle: comparable(oracle), backend: result };
}

const HTTP_TARGET = "http://provider.example.test/v1/models";
const HTTPS_TARGET = "https://provider.example.test/v1/models";

describe("settings:test-pi-proxy speaks the real proxy protocol", () => {
	test("the probe short-circuits exactly like the oracle", async (t) => {
		await withProxyStub(t, {}, async (proxy) => {
			const settings = {
				language: "zh-CN",
				piProxyEnabled: false,
				piProxyUrl: proxy.url(),
				piProxyBypass: "",
			};
			const session = await startBackendSession(t, {
				settings,
				env: { PIDECK_PROXY_TEST_URL: HTTP_TARGET },
			});

			// 1. disabled wins over everything else.
			let pair = await compareProxyProbe(session, settings, HTTP_TARGET);
			assert.equal(pair.backend.error, mainProcessT("zh-CN", "mainProxy.enableFirst"));

			// 2. an enabled but empty address is its own copy.
			pair = await compareProxyProbe(
				session,
				{ ...settings, piProxyEnabled: true, piProxyUrl: "   " },
				HTTP_TARGET,
			);
			assert.equal(pair.backend.error, mainProcessT("zh-CN", "mainProxy.addressRequired"));

			// 3. a non-http proxy protocol is refused, never downgraded to a direct call.
			pair = await compareProxyProbe(
				session,
				{ ...settings, piProxyEnabled: true, piProxyUrl: "socks5://127.0.0.1:1080" },
				HTTP_TARGET,
			);
			assert.equal(pair.backend.error, mainProcessT("zh-CN", "mainProxy.proxyProtocolUnsupported"));

			// 4. an unparsable address cannot silently become the default host.
			pair = await compareProxyProbe(
				session,
				{ ...settings, piProxyEnabled: true, piProxyUrl: "http://" },
				HTTP_TARGET,
			);
			assert.equal(pair.backend.error, mainProcessT("zh-CN", "mainProxy.invalidUrl"));

			// 5. a closed proxy port is reported as such, not as a timeout.
			pair = await compareProxyProbe(
				session,
				{ ...settings, piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:1" },
				HTTP_TARGET,
			);
			assert.equal(pair.backend.error, mainProcessT("zh-CN", "mainProxy.connectionRefused"));

			// Nothing above may have reached the proxy: every case stopped before connect.
			assert.deepEqual(proxy.records, []);
		});
	});

	test("the port-aware bypass list matches the oracle for every entry form", async (t) => {
		await withProxyStub(t, {}, async (proxy) => {
			const settings = {
				language: "zh-CN",
				piProxyEnabled: true,
				piProxyUrl: proxy.url(),
				piProxyBypass: "",
			};
			const session = await startBackendSession(t, {
				settings,
				env: { PIDECK_PROXY_TEST_URL: HTTP_TARGET },
			});

			const cases = [
				// exact host, whole-host wildcard
				{ bypass: "provider.example.test", expected: true },
				{ bypass: "*", expected: true },
				// suffix forms work in *this* matcher (unlike the desktop-proxy matcher)
				{ bypass: "*.example.test", expected: true },
				{ bypass: ".example.test", expected: true },
				{ bypass: "example.test", expected: true },
				// a port that does not match the target keeps the request proxied
				{ bypass: "provider.example.test:1", expected: false },
				// a matching port still needs the host to match
				{ bypass: "other.test:80", expected: false },
				// unrelated entry
				{ bypass: "localhost,127.0.0.1", expected: false },
			];
			for (const entry of cases) {
				const pair = await compareProxyProbe(
					session,
					{ ...settings, piProxyBypass: entry.bypass },
					HTTP_TARGET,
				);
				assert.equal(
					pair.backend.bypassed === true,
					entry.expected,
					`bypass ${JSON.stringify(entry.bypass)} -> ${JSON.stringify(pair.backend)}`,
				);
			}
			// Only the non-bypassed cases reached the proxy (the stub answers 204), and each
			// of them ran once for the oracle and once for the backend.
			assert.equal(proxy.records.filter((record) => record.kind === "absolute").length, 6);
		});
	});

	test("an http target is fetched through the proxy with basic auth and no leak", async (t) => {
		await withProxyStub(t, { targetStatus: 204 }, async (proxy) => {
			const settings = {
				language: "zh-CN",
				piProxyEnabled: true,
				piProxyUrl: proxy.url("user:sup3rsecret@"),
				piProxyBypass: "",
			};
			const session = await startBackendSession(t, {
				settings,
				env: { PIDECK_PROXY_TEST_URL: HTTP_TARGET },
			});
			const pair = await compareProxyProbe(session, settings, HTTP_TARGET);
			assert.equal(pair.backend.success, true);
			assert.equal(pair.backend.statusCode, 204);
			assert.equal(pair.backend.message, mainProcessT("zh-CN", "mainProxy.success", { status: 204 }));
			assert.ok(!JSON.stringify(pair.backend).includes("sup3rsecret"), "the proxy password must not leak");

			// Both implementations send the same absolute-URI request line and the basic
			// credentials, only the ephemeral socket differs.
			const absolute = proxy.records.filter((record) => record.kind === "absolute");
			assert.equal(absolute.length, 2);
			for (const record of absolute) {
				assert.equal(record.method, "GET");
				assert.equal(record.target, HTTP_TARGET);
				assert.equal(record.version, "HTTP/1.1");
				assert.equal(record.headers.host, "provider.example.test");
				assert.equal(record.headers["user-agent"], "pi-desktop-proxy-test");
				assert.equal(record.headers.connection, "close");
				assert.equal(
					record.headers["proxy-authorization"],
					`Basic ${Buffer.from("user:sup3rsecret").toString("base64")}`,
				);
			}
		});
	});

	test("a non-2xx answer from the target is still a reachable proxy", async (t) => {
		// The oracle reports `success: true` with the status code: the probe proves the
		// hop, not the endpoint. Mirroring that is the contract.
		await withProxyStub(t, { targetStatus: 500, targetBody: "boom" }, async (proxy) => {
			const settings = {
				language: "zh-CN",
				piProxyEnabled: true,
				piProxyUrl: proxy.url(),
				piProxyBypass: "",
			};
			const session = await startBackendSession(t, {
				settings,
				env: { PIDECK_PROXY_TEST_URL: HTTP_TARGET },
			});
			const pair = await compareProxyProbe(session, settings, HTTP_TARGET);
			assert.equal(pair.backend.success, true);
			assert.equal(pair.backend.statusCode, 500);
		});
	});

	test("an https target opens CONNECT and reports the tunnel status verbatim", async (t) => {
		await withProxyStub(t, { connectStatus: 403 }, async (proxy) => {
			const settings = {
				language: "zh-CN",
				piProxyEnabled: true,
				piProxyUrl: proxy.url(),
				piProxyBypass: "",
			};
			const session = await startBackendSession(t, {
				settings,
				env: { PIDECK_PROXY_TEST_URL: HTTPS_TARGET },
			});
			const pair = await compareProxyProbe(session, settings, HTTPS_TARGET);
			assert.equal(pair.backend.success, false);
			assert.equal(
				pair.backend.error,
				mainProcessT("zh-CN", "mainProxy.connectStatus", { status: 403 }),
			);

			const connects = proxy.records.filter((record) => record.kind === "connect");
			assert.equal(connects.length, 2);
			for (const record of connects) {
				assert.equal(record.method, "CONNECT");
				assert.equal(record.target, "provider.example.test:443");
				assert.equal(record.headers.host, "provider.example.test:443");
				assert.equal(record.headers["proxy-connection"], "Keep-Alive");
			}
		});
	});

	test("a 200 CONNECT is followed by a real TLS handshake through the tunnel", async (t) => {
		// The proxy accepts the tunnel and then stays silent, so the only way to report
		// `tlsTimeout` is to actually start the handshake on the tunnelled socket.
		await withProxyStub(t, { connectStatus: 200, hangTunnel: true }, async (proxy) => {
			const settings = {
				language: "zh-CN",
				piProxyEnabled: true,
				piProxyUrl: proxy.url(),
				piProxyBypass: "",
			};
			const session = await startBackendSession(t, {
				settings,
				env: { PIDECK_PROXY_TEST_URL: HTTPS_TARGET },
			});
			const pair = await compareProxyProbe(session, settings, HTTPS_TARGET);
			assert.equal(pair.backend.success, false);
			assert.equal(pair.backend.error, mainProcessT("zh-CN", "mainProxy.tlsTimeout"));
			const hellos = proxy.records.filter((record) => record.kind === "tls-hello");
			assert.equal(hellos.length, 2, JSON.stringify(proxy.records));
			// 0x16 is the TLS handshake record: both implementations really start TLS.
			assert.deepEqual(hellos.map((record) => record.firstByte), [0x16, 0x16]);
		});
	});

	test("malformed, oversized and truncated proxy heads are classified like the oracle", async (t) => {
		// Each case is a real head the proxy can send; the oracle parses it with its own
		// 64 KiB budget, so the copy key is the only thing a test can assert.
		const cases = [
			{ name: "invalidResponse", options: { rawReply: "HTTP/1.1 OK\r\n\r\n" } },
			{
				name: "headerTooLarge",
				// No CRLFCRLF inside the 64 KiB budget; the socket stays open so the peer
				// close cannot turn into a reset while the client is not reading.
				options: { rawReply: `HTTP/1.1 200 OK\r\nx-pad: ${"a".repeat(70 * 1024)}`, endReply: false },
			},
			{ name: "closedEarly", options: { rawReply: "HTTP/1.1 200 OK\r\n" } },
		];
		for (const entry of cases) {
			await withProxyStub(t, entry.options, async (proxy) => {
				const settings = {
					language: "zh-CN",
					piProxyEnabled: true,
					piProxyUrl: proxy.url(),
					piProxyBypass: "",
				};
				const session = await startBackendSession(t, {
					settings,
					env: { PIDECK_PROXY_TEST_URL: HTTP_TARGET },
				});
				const pair = await compareProxyProbe(session, settings, HTTP_TARGET);
				assert.equal(pair.backend.success, false, JSON.stringify(pair.backend));
				assert.equal(pair.backend.error, mainProcessT("zh-CN", `mainProxy.${entry.name}`));
			});
		}
	});

	test("an unsupported target protocol is refused before the socket is opened", async (t) => {
		await withProxyStub(t, {}, async (proxy) => {
			const settings = {
				language: "zh-CN",
				piProxyEnabled: true,
				piProxyUrl: proxy.url(),
				piProxyBypass: "",
			};
			const target = "ftp://provider.example.test/v1/models";
			const session = await startBackendSession(t, {
				settings,
				env: { PIDECK_PROXY_TEST_URL: target },
			});
			const pair = await compareProxyProbe(session, settings, target);
			assert.equal(pair.backend.success, false);
			assert.equal(pair.backend.error, mainProcessT("zh-CN", "mainProxy.targetProtocolUnsupported"));
			// Refused on the protocol check, so the proxy never saw a connection.
			assert.deepEqual(proxy.records, []);
		});
	});

	test("the probe is localized from the persisted language", async (t) => {
		const settings = { language: "en-US", piProxyEnabled: false, piProxyUrl: "", piProxyBypass: "" };
		const session = await startBackendSession(t, {
			settings,
			env: { PIDECK_PROXY_TEST_URL: HTTP_TARGET },
		});
		const pair = await compareProxyProbe(session, settings, HTTP_TARGET, "en-US");
		assert.equal(pair.backend.error, "Enable the pi agent proxy first.");
	});
});

describe("desktop proxy policy for outbound HTTP", () => {
	test("loopback is never proxied, even with the proxy enabled at boot", async (t) => {
		await withHttpStub(
			t,
			{ "/v1/models": { body: { data: [{ id: "loop-1" }, { id: "loop-2" }] } } },
			async (target) => {
				await withProxyStub(t, {}, async (proxy) => {
					const settings = {
						language: "zh-CN",
						desktopProxyEnabled: true,
						desktopProxyUrl: proxy.url(),
						desktopProxyBypass: "",
					};
					const session = await startBackendSession(t, { settings });
					const payload = { baseUrl: target.baseUrl, apiKey: "key-1", apiType: "openai-completions" };
					const reply = await session.invoke("config:fetch-models", [payload]);
					assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));

					// Oracle: DesktopProxy + NodeProxy applied to a ConfigManager.
					const nodeProxy = new NodeProxy();
					await applyDesktopProxy(settings, nodeProxy);
					const manager = new ConfigManager(join(session.fixture.userData, ".pi", "agent"), copyFor("zh-CN"), nodeProxy.fetch);
					const oracle = await manager.fetchProviderModels(payload.baseUrl, payload.apiKey, payload.apiType);
					await nodeProxy.apply({ mode: "direct" });
					assert.deepEqual(comparable(reply.payload.result), comparable(oracle));

					assert.equal(reply.payload.result.success, true);
					assert.deepEqual(proxy.records, [], "a loopback target must never reach the proxy");
					assert.equal(target.requests.length, 2);
					assert.equal(target.requests[0].url, "/v1/models");
				});
			},
		);
	});

	test("enabling the proxy through settings:update routes a remote target through it", async (t) => {
		const modelsBody = { data: [{ id: "remote-1" }, { id: "remote-2" }] };
		await withProxyStub(t, { targetStatus: 200, targetBody: JSON.stringify(modelsBody) }, async (proxy) => {
			const session = await startBackendSession(t, { settings: { language: "zh-CN" } });
			const updated = await session.invoke("settings:update", [
				{
					desktopProxyEnabled: true,
					desktopProxyUrl: proxy.url(),
					desktopProxyBypass: "",
				},
			]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));

			const payload = { baseUrl: "http://provider.example.test", apiKey: "key-2", apiType: "openai-completions" };
			const reply = await session.invoke("config:fetch-models", [payload]);
			assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));

			const nodeProxy = new NodeProxy();
			await applyDesktopProxy(updated.payload.result, nodeProxy);
			const manager = new ConfigManager(join(session.fixture.userData, ".pi", "agent"), copyFor("zh-CN"), nodeProxy.fetch);
			const oracle = await manager.fetchProviderModels(payload.baseUrl, payload.apiKey, payload.apiType);
			await nodeProxy.apply({ mode: "direct" });

			assert.deepEqual(comparable(reply.payload.result), comparable(oracle));
			assert.equal(reply.payload.result.success, true);
			assert.deepEqual(reply.payload.result.models, [
				{ id: "remote-1", name: "remote-1" },
				{ id: "remote-2", name: "remote-2" },
			]);

			// Qt sends the absolute URI; undici's ProxyAgent tunnels even plain HTTP, so the
			// stub must see one of each. Both then reach the same fixture.
			const absolute = proxy.records.filter((record) => record.kind === "absolute");
			const tunnelled = proxy.records.filter((record) => record.kind === "tunnel");
			assert.equal(absolute.length, 1, JSON.stringify(proxy.records));
			assert.equal(absolute[0].target, "http://provider.example.test/v1/models");
			assert.equal(absolute[0].headers.host, "provider.example.test");
			assert.equal(tunnelled.length, 1, JSON.stringify(proxy.records));
			assert.equal(tunnelled[0].target, "/v1/models");
			assert.equal(proxy.records.find((record) => record.kind === "connect").target, "provider.example.test:80");
		});
	});

	test("a user bypass entry keeps the target direct on both sides", async (t) => {
		await withProxyStub(t, {}, async (proxy) => {
			const session = await startBackendSession(t, {
				settings: {
					language: "zh-CN",
					desktopProxyEnabled: true,
					desktopProxyUrl: proxy.url(),
					desktopProxyBypass: "bypass.test",
				},
			});
			const payload = { baseUrl: "http://sub.bypass.test", apiKey: "key-3", apiType: "openai-completions" };
			const reply = await session.invoke("config:fetch-models", [payload]);
			assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));

			const nodeProxy = new NodeProxy();
			await applyDesktopProxy(
				{
					desktopProxyEnabled: true,
					desktopProxyUrl: proxy.url(),
					desktopProxyBypass: "bypass.test",
				},
				nodeProxy,
			);
			const manager = new ConfigManager(join(session.fixture.userData, ".pi", "agent"), copyFor("zh-CN"), nodeProxy.fetch);
			const oracle = await manager.fetchProviderModels(payload.baseUrl, payload.apiKey, payload.apiType);
			await nodeProxy.apply({ mode: "direct" });

			assert.deepEqual(comparable(reply.payload.result), comparable(oracle));
			assert.equal(reply.payload.result.success, false);
			assert.equal(reply.payload.result.error, mainProcessT("zh-CN", "mainConfig.fetchModelsFailed"));
			assert.deepEqual(proxy.records, [], "a bypassed target must not reach the proxy");
		});
	});

	test("market catalogue requests follow the same policy", async (t) => {
		// Deliberate superset: the oracle's store handlers use bare `fetch` and stay
		// direct. The backend routes them through the same desktop-proxy policy as every
		// other outbound call, so a user behind a proxy can actually search the store.
		const body = { total: 1, prompts: [{ id: "p-1", title: "Stub", content: "hi" }] };
		await withProxyStub(t, { targetStatus: 200, targetBody: JSON.stringify(body) }, async (proxy) => {
			const session = await startBackendSession(t, {
				settings: {
					language: "zh-CN",
					desktopProxyEnabled: true,
					desktopProxyUrl: proxy.url(),
					desktopProxyBypass: "",
				},
				env: { PIDECK_PROMPT_STORE_BASE: "http://prompts.example.test/api" },
			});
			const reply = await session.invoke("prompt-store:search", ["review"]);
			assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
			assert.equal(reply.payload.result.count, 1);
			assert.equal(reply.payload.result.prompts[0].title, "Stub");
			const absolute = proxy.records.filter((record) => record.kind === "absolute");
			assert.equal(absolute.length, 1, JSON.stringify(proxy.records));
			assert.equal(
				new URL(absolute[0].target).pathname,
				"/api/prompts",
			);
			assert.equal(absolute[0].headers.host, "prompts.example.test");
		});
	});
});

describe("non-OpenAI provider families match the oracle", () => {
	/**
	 * Each family gets its own request/response fixture: the request side (path, headers,
	 * body) is asserted from the recorded stub traffic, the response side from the parsed
	 * result, and the whole result object is compared with the executed oracle.
	 */
	const families = [
		{
			name: "anthropic-messages",
			apiType: "anthropic-messages",
			apiKey: "sk-anthropic",
			modelId: "claude-a",
			routes: {
				"/v1/models": { body: { data: [{ id: "claude-a" }, { id: "claude-b" }] } },
				"/v1/messages": {
					body: {
						model: "claude-a",
						content: [{ type: "text", text: "Hello from Claude" }],
						usage: { input_tokens: 5, output_tokens: 2 },
					},
				},
			},
			modelsUrl: "/v1/models",
			chatUrl: "/v1/messages",
			models: [
				{ id: "claude-a", name: "claude-a" },
				{ id: "claude-b", name: "claude-b" },
			],
			chatBody: { model: "claude-a", messages: [{ role: "user", content: "Hi" }], max_tokens: 10 },
			expected: { model: "claude-a", snippet: "Hello from Claude", tokens: { input: 5, output: 2 } },
			assertModelsHeaders: (headers) => {
				assert.equal(headers["x-api-key"], "sk-anthropic");
			},
			assertChatHeaders: (headers) => {
				assert.equal(headers["x-api-key"], "sk-anthropic");
				assert.equal(headers["anthropic-version"], "2023-06-01");
				assert.match(headers["user-agent"], /^anthropic-sdk-typescript\//);
				assert.equal(headers.authorization, undefined);
			},
		},
		{
			name: "google-generative-ai",
			apiType: "google-generative-ai",
			apiKey: "sk-google",
			modelId: "gemini-1",
			routes: {
				"/v1beta/models": { body: { models: [{ name: "models/gemini-1", displayName: "Gemini One" }] } },
				"/v1beta/models/gemini-1:generateContent": {
					body: {
						modelVersion: "gemini-1",
						candidates: [{ content: { role: "model", parts: [{ text: "Hello from Gemini" }] } }],
						usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
					},
				},
			},
			// Gemini authenticates through the query string only.
			modelsUrl: "/v1beta/models?key=sk-google",
			chatUrl: "/v1beta/models/gemini-1:generateContent?key=sk-google",
			models: [{ id: "gemini-1", name: "Gemini One" }],
			chatBody: {
				contents: [{ role: "user", parts: [{ text: "Hi" }] }],
				generationConfig: { maxOutputTokens: 1 },
			},
			expected: { model: "gemini-1", snippet: "Hello from Gemini", tokens: { input: 7, output: 3 } },
			assertModelsHeaders: (headers) => {
				assert.equal(headers.authorization, undefined);
				assert.equal(headers["x-api-key"], undefined);
			},
			assertChatHeaders: (headers) => {
				assert.equal(headers.authorization, undefined);
				assert.equal(headers["x-api-key"], undefined);
			},
		},
		{
			name: "mistral-conversations",
			apiType: "mistral-conversations",
			apiKey: "sk-mistral",
			modelId: "mistral-large",
			routes: {
				"/v1/models": { body: { data: [{ id: "mistral-large" }] } },
				"/conversations": {
					body: {
						model: "mistral-large",
						outputs: [{ content: [{ type: "text", text: "Hello from Mistral" }] }],
						usage: { prompt_tokens: 4, completion_tokens: 1 },
					},
				},
			},
			modelsUrl: "/v1/models",
			chatUrl: "/conversations",
			models: [{ id: "mistral-large", name: "mistral-large" }],
			chatBody: { model: "mistral-large", inputs: "Hi", store: false },
			expected: { model: "mistral-large", snippet: "Hello from Mistral", tokens: { input: 4, output: 1 } },
			assertModelsHeaders: (headers) => {
				assert.equal(headers.authorization, "Bearer sk-mistral");
			},
			assertChatHeaders: (headers) => {
				assert.equal(headers.authorization, "Bearer sk-mistral");
			},
		},
		{
			name: "openai-responses",
			apiType: "openai-responses",
			apiKey: "sk-responses",
			modelId: "gpt-5",
			routes: {
				"/v1/models": { body: { data: [{ id: "gpt-5" }] } },
				"/v1/responses": {
					body: {
						model: "gpt-5",
						output: [
							{ type: "message", content: [{ type: "output_text", text: "Hello from Responses" }] },
						],
						usage: { input_tokens: 9, output_tokens: 4 },
					},
				},
			},
			modelsUrl: "/v1/models",
			chatUrl: "/v1/responses",
			models: [{ id: "gpt-5", name: "gpt-5" }],
			chatBody: { model: "gpt-5", input: "Hi", max_output_tokens: 1 },
			expected: { model: "gpt-5", snippet: "Hello from Responses", tokens: { input: 9, output: 4 } },
			assertModelsHeaders: (headers) => {
				assert.equal(headers.authorization, "Bearer sk-responses");
			},
			assertChatHeaders: (headers) => {
				assert.equal(headers.authorization, "Bearer sk-responses");
				assert.match(headers["user-agent"], /^OpenAI\/JS/);
			},
		},
	];

	for (const family of families) {
		test(`${family.name} request/response parity`, async (t) => {
			await withHttpStub(t, family.routes, async (stub) => {
				const session = await startBackendSession(t, { settings: { language: "zh-CN" } });
				const oracle = new ConfigManager(
					join(session.fixture.userData, ".pi", "agent"),
					copyFor("zh-CN"),
					(...args) => globalThis.fetch(...args),
				);

				const fetchPayload = { baseUrl: stub.baseUrl, apiKey: family.apiKey, apiType: family.apiType };
				const fetched = await session.invoke("config:fetch-models", [fetchPayload]);
				assert.equal(fetched.payload.ok, true, JSON.stringify(fetched.payload));
				const backendModelsRequest = stub.requests.at(-1);
				const oracleModels = await oracle.fetchProviderModels(
					stub.baseUrl,
					family.apiKey,
					family.apiType,
				);
				assert.deepEqual(comparable(fetched.payload.result), comparable(oracleModels));
				assert.equal(fetched.payload.result.success, true);
				assert.deepEqual(fetched.payload.result.models, family.models);
				assert.equal(backendModelsRequest.method, "GET");
				assert.equal(backendModelsRequest.url, family.modelsUrl);
				family.assertModelsHeaders(backendModelsRequest.headers);

				const tested = await session.invoke("config:test-provider", [
					{
						baseUrl: stub.baseUrl,
						apiKey: family.apiKey,
						modelId: family.modelId,
						apiType: family.apiType,
					},
				]);
				assert.equal(tested.payload.ok, true, JSON.stringify(tested.payload));
				const backendChatRequest = stub.requests.at(-1);
				const oracleTest = await oracle.testProviderConnection(
					stub.baseUrl,
					family.apiKey,
					family.modelId,
					family.apiType,
				);
				assert.deepEqual(comparable(tested.payload.result), comparable(oracleTest));

				assert.equal(backendChatRequest.method, "POST");
				assert.equal(backendChatRequest.url, family.chatUrl);
				assert.deepEqual(JSON.parse(backendChatRequest.body), family.chatBody);
				family.assertChatHeaders(backendChatRequest.headers);
				assert.equal(tested.payload.result.success, true);
				assert.equal(tested.payload.result.model, family.expected.model);
				assert.equal(tested.payload.result.snippet, family.expected.snippet);
				assert.deepEqual(tested.payload.result.tokens, family.expected.tokens);
				// The API key never reaches a returned URL or body.
				assert.ok(!JSON.stringify(tested.payload.result).includes(family.apiKey));
			});
		});
	}
});
