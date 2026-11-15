import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { bootServedLegacyPage } from "./helpers/native2LegacyWebClient.mjs";
import { oracleLegacyPage, oracleWebClientCopy } from "./helpers/native2LegacyWebOracle.mjs";

/**
 * Embedded legacy web client parity (`WebServiceManager.renderPage()`).
 *
 * The C++ backend serves the oracle's vanilla page for `?view=legacy` and whenever a
 * document request finds no bundle. Two kinds of evidence are collected here:
 *
 *  1. bytes — the served document is the oracle template around the dictionaries, and
 *     the dictionary carries the whole `web.*` copy in both locales;
 *  2. behaviour — the inline script is parsed into a real DOM (linkedom), executed in a
 *     `vm` sandbox and given a `fetch` that talks to the real backend, so send, SSE
 *     rendering, `[DONE]` hand-off, abort and the rejected-prompt draft restore are all
 *     observed instead of grepped.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "legacy";
const SECRET = "lan-legacy-secret-token-0123456789ABCDEF";

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

/** Authenticated GET as the browser would send it (cookie, not a bearer header). */
async function get(port, path) {
	const response = await httpRequest(`http://127.0.0.1:${port}${path}`, {
		headers: { cookie: `pideck_web_token_${port}=${SECRET}` },
	});
	let json = null;
	try {
		json = JSON.parse(response.body);
	} catch {
		json = null;
	}
	return { status: response.status, headers: response.headers, body: response.body, json };
}

const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal pi session file; the text may contain markup on purpose. */
function writeSessionFile(sessionsDir, projectPath, name, { userText, assistantText }) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: userText }], timestamp: 1_767_225_601_000 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: assistantText }], timestamp: 1_767_225_602_000 },
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

const oracle = oracleLegacyPage();
const oracleCopy = oracleWebClientCopy();

/** Split a served page into `{ dictionaries, raw }` and assert the oracle framing. */
function splitServedPage(body) {
	assert.ok(body.startsWith(oracle.prefix), "served page must start with the oracle template");
	assert.ok(body.endsWith(oracle.suffix), "served page must end with the oracle template");
	const raw = body.slice(oracle.prefix.length, body.length - oracle.suffix.length);
	return { dictionaries: JSON.parse(raw), raw };
}

if (!executable) {
	describe("native2 legacy web client parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 legacy web client parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-legacy-web-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * Boot a backend with the LAN service enabled.
		 *
		 * `webRenderer` writes the A2 bundle (`web.html`) so the `?view=legacy` switch is
		 * distinguishable from the missing-bundle fallback; `dropDocuments` removes every
		 * entry document to exercise that fallback.
		 */
		const start = async (t, { scenario = {}, webRenderer = true, dropDocuments = false } = {}) => {
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
				},
				prepare: (fixture) => {
					if (dropDocuments) rmSync(join(fixture.renderer, "index.html"), { force: true });
					if (webRenderer && !dropDocuments) {
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
			await waitForWeb(port);
			return { ...session, fake, port };
		};

		/** Import one session file into the catalog (no runtime). */
		const importSession = async (session, name, texts) => {
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, name, texts);
			const listed = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const record = listed.payload.result.find(
				(entry) => slash(entry.filePath) === slash(filePath),
			);
			assert.ok(record, "the session file must be imported into the catalog");
			return record;
		};

		/** Import one session file and activate it through the desktop channel. */
		const activate = async (session, name, texts) => {
			const record = await importSession(session, name, texts);
			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			return { record, target: activated.payload.result.value };
		};

		/** Boot the served page against the live backend. */
		const boot = async (session, path = "/?view=legacy", locale = "en-US") => {
			const page = await get(session.port, path);
			assert.equal(page.status, 200);
			const client = bootServedLegacyPage(page.body, {
				baseUrl: `http://127.0.0.1:${session.port}`,
				authorization: SECRET,
				locale,
			});
			await client.settle();
			return { client, page };
		};

		test("served page is the oracle template around the dictionaries, for both entry points", async (t) => {
			const withBundle = await start(t, { webRenderer: true });

			// With a bundle present `/` is still the React client; `?view=legacy` is the switch.
			const bundle = await get(withBundle.port, "/");
			assert.equal(bundle.status, 200);
			assert.match(bundle.body, /PiDeck web bundle/);
			const switched = await get(withBundle.port, "/?view=legacy");
			assert.equal(switched.status, 200);
			assert.match(switched.headers["content-type"], /text\/html/);
			assert.equal(switched.headers["cache-control"], "no-store");
			splitServedPage(switched.body);

			// Without any entry document the same page is the fallback: `/`, a client-side
			// route and a missing `.html` request all land on it, exactly like the oracle.
			const noBundle = await start(t, { dropDocuments: true });
			const rootFallback = await get(noBundle.port, "/");
			assert.equal(rootFallback.status, 200);
			splitServedPage(rootFallback.body);
			const clientRoute = await get(noBundle.port, "/sessions/abc");
			assert.equal(clientRoute.status, 200);
			assert.equal(clientRoute.body, rootFallback.body);
			const missingHtml = await get(noBundle.port, "/missing.html");
			assert.equal(missingHtml.status, 200);
			assert.equal(missingHtml.body, rootFallback.body);

			// The switch itself does not depend on the bundle: same bytes either way.
			const switchedWithoutBundle = await get(noBundle.port, "/?view=legacy");
			assert.equal(switchedWithoutBundle.body, rootFallback.body);

			// A missing *resource* must stay a 404 instead of HTML, or the browser parses
			// the page as a module script and white-screens with a MIME error.
			const missingAsset = await get(noBundle.port, "/assets/missing.js");
			assert.equal(missingAsset.status, 404);
			assert.equal(missingAsset.json.code, "webError.apiNotFound");
			// The oracle passes the requested path through as the human message.
			assert.equal(missingAsset.json.error, "Not found: /assets/missing.js");
		});

		test("client dictionaries carry every web copy key in both locales and escape markup", async (t) => {
			const session = await start(t, { dropDocuments: true });
			const { body } = await get(session.port, "/?view=legacy");
			const { dictionaries, raw } = splitServedPage(body);
			assert.deepEqual(Object.keys(dictionaries).sort(), ["en-US", "zh-CN"]);

			// Same key set in both locales, otherwise one language silently falls back.
			assert.deepEqual(
				Object.keys(dictionaries["zh-CN"]).sort(),
				Object.keys(dictionaries["en-US"]).sort(),
			);

			// Every `web.*` / `webError.*` string the oracle ships, verbatim.
			for (const locale of ["zh-CN", "en-US"]) {
				const served = dictionaries[locale];
				for (const [key, value] of Object.entries(oracleCopy[locale])) {
					assert.equal(served[key], value, `${locale} ${key}`);
				}
			}

			// Timeline rows carry `meta.i18nKey`; the page localizes them from this table,
			// so the main-process keys that can appear in a message must be present too.
			for (const locale of ["zh-CN", "en-US"]) {
				for (const key of ["diagnostic.promptRejected", "diagnostic.promptDeliveryUnknown"]) {
					assert.equal(typeof dictionaries[locale][key], "string", `${locale} ${key}`);
					assert.notEqual(dictionaries[locale][key], key, `${locale} ${key} must be translated`);
				}
			}

			// No raw `<` in the inline JSON: a copy string containing `</script>` would end
			// the element and the rest of the page would be parsed as HTML.
			assert.equal(raw.includes("<"), false, raw.slice(0, 120));
		});

		test("the page executes against the real backend: state, history and escaping", async (t) => {
			const session = await start(t, { dropDocuments: true });
			const markup = '<img src=x onerror="alert(1)"> & <b>not bold</b>';
			// No runtime: `/api/state` carries no snapshot, so selecting the session takes the
			// `messages/page` path a phone takes for any closed session.
			const record = await importSession(session, `escaping-${Date.now()}`, {
				userText: `hello ${markup}`,
				assistantText: "hi there",
			});

			const { client } = await boot(session);

			// Static copy applied, project + session list rendered from `/api/state`.
			assert.equal(client.text("projects-title"), "Projects");
			assert.equal(client.text("sessions-title"), "Sessions");
			assert.equal(client.text("submit"), "Send");
			assert.match(client.text("status"), /^(Connected|Idle|Running|Starting|Closed|Saved|Draft)$/);
			assert.match(client.document.getElementById("projects").textContent, /project-0/);
			const sessionButton = client.document.querySelector("[data-session]");
			assert.ok(sessionButton, client.document.getElementById("sessions").innerHTML);
			assert.equal(sessionButton.dataset.session, record.id);
			assert.match(sessionButton.textContent, /Draft|Saved|Idle|Closed/);
			// A session without a runtime cannot be closed; the row button is disabled.
			assert.equal(client.document.querySelector("[data-close-session]").disabled, true);

			// Selecting a session loads its history; the 600 ms poll renders it.
			await client.click("[data-session]");
			assert.ok(
				client.requests.some((entry) => entry.path === `/api/sessions/${record.id}/messages/page`),
				JSON.stringify(client.requests.map((entry) => entry.path)),
			);
			await client.runPoll();
			assert.match(client.messagesText(), /hello <img src=x onerror="alert\(1\)"> & <b>not bold<\/b>/);
			assert.match(client.messagesText(), /hi there/);
			assert.match(client.messagesText(), /User/);
			assert.match(client.messagesText(), /Assistant/);
			// Markup is escaped, not injected: the innerHTML carries entities, no element.
			assert.match(client.messagesHtml(), /&lt;img src=x onerror="alert\(1\)"&gt;/);
			assert.match(client.messagesHtml(), /&amp; &lt;b&gt;not bold&lt;\/b&gt;/);
			assert.equal(client.document.getElementById("messages").querySelector("img"), null);
			assert.equal(client.document.getElementById("messages").querySelector("b"), null);
			// The header shows the selected session (its title is the first user message).
			const state = await get(session.port, "/api/state");
			const listed = state.json.sessions.find((entry) => entry.id === record.id);
			assert.ok(listed, JSON.stringify(state.json.sessions));
			assert.equal(client.text("title"), listed.title);
		});

		test("clicking a project creates a draft session through the same catalog channel", async (t) => {
			const session = await start(t, { dropDocuments: true });
			const { client } = await boot(session);

			const projectButton = client.document.querySelector(`[data-project="${PROJECT_ID}"]`);
			assert.ok(projectButton, client.document.getElementById("projects").innerHTML);
			assert.equal(projectButton.dataset.project, PROJECT_ID);

			await client.click(`[data-project="${PROJECT_ID}"]`);
			const createRequest = await client.waitFor(
				() => client.requests.find((entry) => entry.path === "/api/sessions" && entry.method === "POST"),
				{ label: "create-session request" },
			);
			assert.deepEqual(createRequest.body, { projectId: PROJECT_ID });

			await client.runPoll();
			const state = await get(session.port, "/api/state");
			assert.equal(state.json.sessions.length, 1);
			assert.equal(state.json.sessions[0].projectId, PROJECT_ID);
			const created = state.json.sessions[0];
			// The page activates the new draft (`activeSessionId = result.session.id`).
			assert.equal(client.document.querySelector("[data-session]").dataset.session, created.id);
			assert.equal(client.text("title"), created.title);
			// A draft has no runtime yet, so the composer is enabled and close is disabled.
			assert.equal(client.document.getElementById("prompt").disabled, false);
			assert.equal(client.document.getElementById("stop").disabled, true);
		});

		test("prompt submit streams reasoning/text/tool frames, then swaps to history on [DONE]", async (t) => {
			const scenario = {
				turns: [
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 10, event: messageStart("msg_1") },
							{ delayMs: 10, event: textUpdate({ type: "thinking_delta", delta: "thinking about it" }) },
							{ delayMs: 10, event: textUpdate({ type: "thinking_end" }) },
							{ delayMs: 20, event: textUpdate({ type: "text_delta", delta: "Hello " }) },
							{ delayMs: 40, event: { type: "tool_execution_start", toolName: "bash", toolCallId: "tool-1", args: { command: "echo hi" } } },
							{ delayMs: 60, event: { type: "tool_execution_end", toolName: "bash", toolCallId: "tool-1", isError: false } },
							{ delayMs: 40, event: textUpdate({ type: "text_delta", delta: "from the LAN" }) },
							{ delayMs: 40, event: textUpdate({ type: "text_end" }) },
							{ delayMs: 30, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello from the LAN" }], stopReason: "stop" } } },
							{ delayMs: 30, event: { type: "agent_end", messages: [] } },
							{ delayMs: 150, event: { type: "agent_settled" } },
						],
					},
				],
			};
			const session = await start(t, { scenario, dropDocuments: true });
			const { record } = await activate(session, `stream-${Date.now()}`, {
				userText: "seed message",
				assistantText: "seed reply",
			});

			const { client } = await boot(session);
			assert.ok(
				client.document.querySelector("[data-session]"),
				client.document.getElementById("sessions").innerHTML,
			);

			await client.submitPrompt("hello from the phone");

			const promptRequest = client.requests.find((entry) => entry.path.endsWith("/prompt"));
			assert.ok(promptRequest, JSON.stringify(client.requests));
			assert.equal(promptRequest.method, "POST");
			assert.equal(promptRequest.body.message, "hello from the phone");
			assert.match(promptRequest.body.requestId, /^[0-9a-f-]{36}$/);
			assert.equal(client.document.getElementById("prompt").value, "");

			// Interim streaming blocks appear while the turn is still running: the history
			// fetch that `finishStream` performs has not happened yet.
			const thinking = await client.waitFor(() => client.document.querySelector(".streaming-thinking"), {
				label: "reasoning block",
			});
			assert.equal(thinking.textContent, "thinking about it");
			const toolCard = await client.waitFor(() => client.document.querySelector(".streaming-tool"), {
				label: "tool card",
			});
			assert.match(toolCard.textContent, /bash/);
			const textBlock = await client.waitFor(() => client.document.querySelector(".streaming-text"), {
				label: "text block",
			});
			assert.match(textBlock.textContent, /^Hello /);
			assert.equal(
				client.requests.some((entry) => entry.path.includes("/messages/page")),
				false,
				"history is fetched only after [DONE]",
			);

			// The tool result rewrites the card once the call completes.
			await client.waitFor(
				() => client.document.querySelector(".streaming-tool")?.textContent.includes("完成"),
				{ label: "tool completion" },
			);

			// `[DONE]` → fetch the authoritative history and replace the streaming blocks.
			await client.waitFor(
				() => client.requests.some((entry) => entry.path === `/api/sessions/${record.id}/messages/page`),
				{ label: "history fetch after DONE" },
			);
			await client.waitFor(() => client.document.querySelectorAll(".streaming").length === 0, {
				label: "streaming blocks removed",
			});
			assert.equal(client.messagesHtml().includes("streaming"), false);
			// History comes from the session file (the fake pi does not persist the streamed
			// reply), so the page shows exactly what the backend reports as authoritative.
			const history = await get(session.port, `/api/sessions/${record.id}/messages/page`);
			const expectedTexts = (history.json.messages ?? [])
				.map((message) => message.text)
				.filter(Boolean);
			assert.ok(expectedTexts.length > 0, JSON.stringify(history.json));
			for (const text of expectedTexts) assert.ok(client.messagesText().includes(text), text);

			// The frame stream really was the SSE endpoint, not a JSON stub.
			assert.ok(
				client.requests.some((entry) => entry.path === `/api/sessions/${record.id}/stream`),
				JSON.stringify(client.requests.map((entry) => entry.path)),
			);
			assert.equal(session.fake.commands().filter((entry) => entry.command === "prompt").length, 1);
		});

		test("abort posts the live runtime target and the stop button follows the runtime", async (t) => {
			const scenario = {
				turns: [
					{
						ack: true,
						events: [
							{ delayMs: 0, event: { type: "agent_start" } },
							{ delayMs: 10, event: messageStart("msg_1") },
							{ delayMs: 40, event: textUpdate({ type: "text_delta", delta: "long running " }) },
							// The turn stays open long enough for the click to land mid-run.
							{ delayMs: 4000, event: textUpdate({ type: "text_end" }) },
						],
					},
				],
			};
			const session = await start(t, { scenario, dropDocuments: true });
			const { record, target } = await activate(session, `abort-${Date.now()}`, {
				userText: "seed",
				assistantText: "seed reply",
			});

			const { client } = await boot(session);
			await client.runPoll();

			// Idle runtime: the header button closes the runtime instance.
			assert.equal(client.text("stop"), "Close session runtime");
			assert.equal(client.document.getElementById("stop").disabled, false);

			await client.submitPrompt("keep going");
			await client.waitFor(
				() => client.document.querySelector(".streaming-text")?.textContent.includes("long running"),
				{ label: "first delta" },
			);
			// A running turn flips the button into "stop response" (state poll).
			await client.runPoll();
			assert.equal(client.text("stop"), "Stop response");

			await client.click("#stop");
			const abortCall = await client.waitFor(
				() =>
					client.requests.find(
						(entry) => entry.path === `/api/sessions/${record.id}/runtime/abort`,
					),
				{ label: "abort request" },
			);
			assert.deepEqual(abortCall.body, {
				target: {
					sessionId: record.id,
					agentId: target.agentId,
					runtimeGeneration: target.runtimeGeneration,
				},
			});
			assert.ok(
				session.fake.commands().some((entry) => entry.command === "abort"),
				JSON.stringify(session.fake.commands().map((entry) => entry.command)),
			);

			// After the abort the backend reports the runtime as idle again, and the button
			// returns to "close runtime" once the page polls.
			await client.waitFor(
				async () => (await get(session.port, "/api/state")).json.runtimes[0]?.status === "idle",
				{ label: "runtime idle" },
			);
			await client.runPoll();
			assert.equal(client.text("stop"), "Close session runtime");
		});

		test("a rejected prompt restores the draft and shows the localized failure", async (t) => {
			const scenario = { turns: [{ ack: false, error: "prompt rejected by the fake pi" }] };
			const session = await start(t, { scenario, dropDocuments: true });
			await activate(session, `reject-${Date.now()}`, {
				userText: "seed",
				assistantText: "seed reply",
			});

			const { client, page } = await boot(session, "/?view=legacy", "zh-CN");
			const { dictionaries } = splitServedPage(page.body);

			// The dictionary the page carries is what localizes the outcome; assert the page
			// shows that exact text, not the backend's English fallback.
			await client.submitPrompt("please reject me");
			await client.waitFor(() => client.requests.some((entry) => entry.path.endsWith("/prompt")), {
				label: "prompt request",
			});
			await client.waitFor(
				() => client.text("status") === dictionaries["zh-CN"]["diagnostic.promptRejected"],
				{ label: "localized rejection", timeoutMs: 10_000 },
			);
			const promptRequest = client.requests.find((entry) => entry.path.endsWith("/prompt"));
			assert.equal(promptRequest.body.message, "please reject me");
			// The draft is restored so the user can retry (delivery is provably unavailable).
			assert.equal(client.document.getElementById("prompt").value, "please reject me");
			// zh-CN chrome copy confirms the page picked the browser locale.
			assert.equal(client.text("submit"), dictionaries["zh-CN"]["web.send"]);
			assert.equal(client.text("projects-title"), dictionaries["zh-CN"]["web.projects"]);
		});

		test("the parity assertion rejects the pre-port diagnostic placeholder page", () => {
			// The placeholder this port replaced was a static sentence with no client. If the
			// framing assertion above accepted it, the byte comparison would be vacuous, so
			// prove here that it does not.
			const placeholder =
				'<!doctype html><html lang="en-US"><head><meta charset="utf-8">' +
				"<title>PiDeck</title></head><body style=\"font-family:system-ui;padding:24px\">" +
				"<h1>PiDeck</h1>" +
				"<p>The web bundle is missing from this build, so the browser UI cannot load.</p>" +
				"</body></html>";
			assert.throws(() => splitServedPage(placeholder), /must start with the oracle template/);
		});
	});
}
