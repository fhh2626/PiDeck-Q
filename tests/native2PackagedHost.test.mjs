/**
 * Packaged-product acceptance gate for the native2 C++ backend.
 *
 * This is the only suite that starts the **real packaged product**: `PiDeck-Q.exe` from an
 * isolated stage, which loads the real renderer bundle in WebView2, spawns the C++ sidecar
 * it was packaged with, and serves that renderer over loopback HTTP + SSE. Every assertion
 * below runs against the shipped process tree and the shipped UI, not against
 * `PiDeckBackend.exe` driven by a fake host.
 *
 * The fake `pi` is a native executable (`native/tests/Native2FakePi.cpp`) on purpose: the
 * child PATH holds only the OS directories, the stage and the fake-pi directory, so a
 * package that still needed Node, or a DLL `windeployqt` failed to deploy, fails here
 * instead of on a user's machine.
 *
 * Each test launches its own host with its own user data, WebView2 profile and
 * `PIDECK_HOME`, so the real user profile, the installed app and `~/.pi` are never touched.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	connectPage,
	createHostFixture,
	descendants,
	findFreePort,
	launchHost,
	pageRpc,
	pathInside,
	readPiTraffic,
	requirePackagedHost,
	resolveFakePi,
	sleep,
	stageFacts,
	verifyPackagedStage,
	waitFor,
	waitForText,
} from "./helpers/native2PackagedHost.mjs";

const packaged = requirePackagedHost();
const fakePi = packaged.available ? resolveFakePi() : "";
const available = packaged.available && fakePi !== "" && process.platform === "win32";

/** Launch a host for one test and always tear it and the fixture down. */
async function withHost(t, { isolatedPath = true } = {}) {
	const fixture = createHostFixture({ fakePi });
	const port = findFreePort();
	const launch = launchHost({ stage: packaged.stage, fixture, port, isolatedPath });
	t.after(async () => {
		if (launch.child.exitCode === null) launch.killTree();
		await sleep(1500);
		fixture.cleanup();
	});
	const { cdp } = await connectPage(port);
	t.after(() => cdp.close());
	await waitForText(cdp, "PIDECK-Q", { timeoutMs: 120_000 });
	await waitForText(cdp, "Loading history sessions", { absent: true, timeoutMs: 120_000 });
	return { fixture, launch, cdp };
}

/** Create the fixture project's agent through the real sidebar. */
async function openAgent(cdp) {
	assert.ok((await cdp.clickByText("fixture-project")) || (await cdp.clickByText("project")), "project row missing");
	await sleep(1_200);
	assert.ok((await cdp.clickByLabel("New Agent")) || (await cdp.clickByText("New Agent")), "New Agent control missing");
	await waitFor(cdp, "Boolean(document.querySelector(\"[contenteditable='true']\"))", { label: "composer" });
}

/** Answer the pending ask card through the real card controls, exactly like a user would. */
async function answerAsk(cdp, { placeholder = "staging", value = "production" } = {}) {
	const answered = await cdp.evaluate(`(() => {
		const input = [...document.querySelectorAll("input")].find((element) => element.placeholder === ${JSON.stringify(placeholder)});
		if (!input) return "no-input";
		const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setValue.call(input, ${JSON.stringify(value)});
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const submit = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Submit");
		if (!submit) return "no-submit";
		submit.click();
		return "ok";
	})()`);
	assert.equal(answered, "ok", `the ask card could not be answered: ${answered}`);
}

/** Settled final-answer rows: one per completed assistant message, keyed by message id. */
async function finalAnswers(cdp) {
	return cdp.evaluate(`(() => [...document.querySelectorAll("[data-final-answer]")].map((row) => ({
		id: row.getAttribute("data-message-id") || "",
		text: row.innerText || "",
	})))()`);
}

/** Poll the fake-pi traffic log until a frame matches; fails with the observed kinds. */
async function waitForTraffic(fixture, predicate, { timeoutMs = 30_000, label = "pi frame" } = {}) {
	const deadline = Date.now() + timeoutMs;
	let traffic = [];
	while (Date.now() < deadline) {
		traffic = readPiTraffic(fixture.piTrafficLog);
		if (traffic.some(predicate)) return traffic;
		await sleep(200);
	}
	throw new Error(
		`timed out waiting for ${label}; pi traffic kinds: ${JSON.stringify(traffic.map((entry) => entry.kind))}`,
	);
}

if (!available) {
	describe("native2 packaged host", () => {
		test("the packaged C++ host is required for this gate", () => {
			if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") {
				assert.fail(
					"PIDECK_REQUIRE_BACKEND_TESTS=1 but the packaged host or the native fake pi is missing; build with " +
						"PIDECK_SIDECAR_KIND=cpp PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake -r and " +
						"xmake build -y PiDeck-FakePi2",
				);
			}
		});
	});
} else {
	describe("native2 packaged host", () => {
		test("the package ships no business Node and the real Qt host boots the real renderer", async (t) => {
			const stage = packaged.stage;
			// 1. The shared artifact definition must accept the stage for the cpp kind.
			assert.match(verifyPackagedStage(stage), /verified/i);
			const facts = stageFacts(stage);
			assert.ok(facts.files > 1_000, `the stage must ship a full application tree, saw ${facts.files} files`);
			for (const relative of ["node.exe", "node", "app/native-node", "app/node_modules"]) {
				assert.equal(existsSync(join(stage, relative)), false, `${relative} must not exist in a C++ package`);
			}
			// 2. The TS extensions keep their own dependencies: pi loads them, they are product
			//    content, not the business Node runtime.
			for (const dependency of ["acorn", "jiti", "undici", "yaml"]) {
				assert.ok(
					existsSync(join(stage, "resources", "extensions", "node_modules", dependency)),
					`extension dependency ${dependency} must stay in the package`,
				);
			}
			assert.ok(existsSync(join(stage, "sqldrivers", "qsqlite.dll")), "the QSQLITE driver must be staged");

			const { cdp, launch } = await withHost(t);
			const bootMs = Date.now() - launch.startedAt;

			// 3. Static bundle + bootstrap + token handling on the real WebView page. The
			//    visible href is read from the page itself: the host navigates away from the
			//    initial `about:blank` target once the sidecar answers `renderer.ready`.
			const href = await cdp.evaluate("location.href");
			assert.match(href, /^http:\/\/127\.0\.0\.1:\d+\//, href);
			assert.match(href, /runtime=native/);
			assert.ok(!href.includes("token="), `the bootstrap token must be stripped, saw ${href}`);
			assert.ok((await cdp.evaluate("document.styleSheets.length")) > 0, "the packaged renderer CSS must load");
			// The sidebar renders the seeded project (its display name is the directory name)
			// and the history scan finished, so bootstrap RPC + SSE really round-tripped.
			assert.ok(
				await cdp.evaluate("Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'project'))"),
				`bootstrap data must render the seeded project: ${(await cdp.text()).slice(0, 400)}`,
			);

			// 4. Real process tree: both shipped binaries run from the stage and nothing below
			//    the host is Node.js.
			const tree = descendants(launch.child.pid);
			const backend = tree.find((entry) => /^PiDeckBackend(\.exe)?$/i.test(entry.Name));
			assert.ok(backend, `no C++ sidecar in the process tree: ${JSON.stringify(tree.map((entry) => entry.Name))}`);
			assert.ok(pathInside(stage, backend.ExecutablePath), `the sidecar must run from the stage: ${backend.ExecutablePath}`);
			assert.deepEqual(
				tree.filter((entry) => /^node(\.exe)?$/i.test(entry.Name)),
				[],
				"a C++ package must not start any Node.js process",
			);
			const memoryBytes = tree.reduce((sum, entry) => sum + Number(entry.WorkingSetSize ?? 0), 0);
			assert.ok(bootMs < 120_000, `cold start took ${bootMs} ms`);
			assert.ok(memoryBytes > 0, "process-tree memory must be measurable");
			console.log(
				`METRICS stage=cpp bootMs=${bootMs} treeMemoryBytes=${memoryBytes} stageFiles=${facts.files} stageBytes=${facts.bytes}`,
			);
		});

		test("an unsupported PIDECK_SIDECAR_KIND is refused instead of falling back", async (t) => {
			// A typo in the sidecar selection must fail the launch, not silently start the other
			// backend: the packaged host exits before any window or child process exists.
			const fixture = createHostFixture({ fakePi });
			const port = findFreePort();
			const launch = launchHost({ stage: packaged.stage, fixture, port, extraEnv: { PIDECK_SIDECAR_KIND: "bogus" } });
			t.after(async () => {
				if (launch.child.exitCode === null) launch.killTree();
				await sleep(500);
				fixture.cleanup();
			});
			const exit = await Promise.race([launch.exited, sleep(30_000).then(() => null)]);
			assert.ok(exit, "the host must refuse an unsupported sidecar kind instead of running");
			assert.equal(exit.code, 1, `expected exit code 1, got ${exit.code} (stderr: ${exit.stderr.slice(0, 400)})`);
			assert.match(`${exit.stdout}${exit.stderr}`, /Unsupported PIDECK_SIDECAR_KIND/);
			assert.ok(
				exit.at - launch.startedAt < 15_000,
				`a rejected kind must fail fast, took ${exit.at - launch.startedAt} ms`,
			);
		});

		test("a packaged turn renders thinking, text, a tool card and an interactive ask, then quits cleanly", async (t) => {
			const { cdp, fixture, launch } = await withHost(t);
			await openAgent(cdp);
			await cdp.sendPrompt("hello from the gate");

			// The ask is the stable anchor: pi closes the announcing message with
			// `stopReason=toolUse` before the tool call, so that text is folded into the
			// execution summary instead of staying on screen. Expand the summary and read the
			// phases it really contains (deterministic, instead of sampling a streaming window).
			await waitForText(cdp, "Deploy target?", { timeoutMs: 120_000 });
			assert.equal(
				await cdp.evaluate(`(() => {
					const toggle = [...document.querySelectorAll("button")].find((button) => /Execution:/.test(button.textContent));
					if (!toggle) return false;
					toggle.click();
					return true;
				})()`),
				true,
				"the execution summary toggle was not found",
			);
			const text = await waitForText(cdp, "Hello from the packaged host.", { timeoutMs: 30_000 });
			const phases = [
				["text", /Hello from the packaged host\./],
				["thinking", /Thought|Thinking|Drafting/],
				["tool", /Execution: 1 tools/],
				["ask", /Deploy target\?/],
			];
			for (const [phase, pattern] of phases) {
				assert.match(text, pattern, `the packaged turn must render its ${phase} phase: ${text.slice(0, 700)}`);
			}

			// Answer the ask through the real card: the turn may only finish afterwards.
			await answerAsk(cdp);
			// The answer travels renderer → sidecar → pi; wait for the protocol frame itself
			// rather than assuming it landed by the time the card closed.
			const traffic = await waitForTraffic(fixture, (entry) => entry.kind === "ui-response", {
				label: "the ask answer reaching pi",
			});
			assert.ok(
				traffic.some((entry) => entry.kind === "prompt" && entry.text === "hello from the gate"),
				"the prompt must reach pi verbatim",
			);
			await waitForText(cdp, "Agent is working", { absent: true, timeoutMs: 60_000 });

			// Clean quit through the window control the page owns (closeToTray=false).
			assert.equal(await cdp.clickByLabel("Close window"), true, "the window close control was not found");
			const quitStarted = Date.now();
			const exit = await Promise.race([launch.exited, sleep(20_000).then(() => null)]);
			assert.ok(exit, "the packaged host did not exit after the window close request");
			assert.equal(exit.code, 0, `the packaged host exited with ${exit.code}`);
			const quitMs = Date.now() - quitStarted;
			assert.ok(quitMs < 15_000, `quit took ${quitMs} ms`);
			console.log(`METRICS quit quitMs=${quitMs}`);
		});

		test("a second turn in one session renders its own answer row and a fresh ask", async (t) => {
			// The old fake reused `assistant-1` for every prompt, latched its ask answer after
			// the first reply and ran each turn on a detached thread, so "the reply after an
			// answered ask does not render" was never product evidence. This is the permanent
			// multi-turn regression: two prompts, two answers, one session.
			const { cdp, fixture } = await withHost(t);
			await openAgent(cdp);

			// Turn 1: the established scripted turn, answered through the real ask card.
			await cdp.sendPrompt("first turn please marker:alpha");
			await waitForText(cdp, "Deploy target? (marker:alpha)", { timeoutMs: 120_000 });
			await answerAsk(cdp);
			await waitForText(cdp, "Agent is working", { absent: true, timeoutMs: 60_000 });
			// The post-tool reply is a separate assistant message and becomes the run's final
			// answer; wait for the row itself instead of racing the status patch.
			await waitFor(cdp, "document.querySelectorAll('[data-final-answer]').length === 1", {
				timeoutMs: 30_000,
				label: "the turn-1 final answer row",
			});
			const firstRows = await finalAnswers(cdp);
			assert.equal(firstRows.length, 1, `one settled assistant answer after turn 1: ${JSON.stringify(firstRows)}`);
			assert.match(firstRows[0].text, /Done with marker:alpha\./);

			// Turn 2: same session and agent, second prompt. A new message identity must reach
			// the transcript as its own row instead of updating turn 1's row.
			await cdp.sendPrompt("second turn please marker:beta");
			await waitForText(cdp, "Deploy target? (marker:beta)", { timeoutMs: 120_000 });
			// The ask must still gate the turn: a latched answer would have completed turn 2
			// already, so the second answer may not exist before the card is answered.
			const pendingRows = await finalAnswers(cdp);
			assert.equal(pendingRows.length, 1, `turn 2 must still be running while ask 2 is pending: ${JSON.stringify(pendingRows)}`);
			assert.equal(
				await cdp.evaluate(`Boolean(document.querySelector('[aria-label="Stop"]'))`),
				true,
				"turn 2 must still be streaming while ask 2 is pending",
			);

			await answerAsk(cdp);
			await waitForText(cdp, "Agent is working", { absent: true, timeoutMs: 60_000 });
			await waitFor(cdp, "document.querySelectorAll('[data-final-answer]').length === 2", {
				timeoutMs: 30_000,
				label: "the turn-2 final answer row",
			});

			// Both answers stay in the transcript, each with its own identity and body.
			const rows = await finalAnswers(cdp);
			assert.equal(rows.length, 2, `two settled assistant answers expected: ${JSON.stringify(rows)}`);
			assert.equal(new Set(rows.map((row) => row.id)).size, 2, `the answers must be distinct rows: ${JSON.stringify(rows)}`);
			assert.match(rows[0].text, /Done with marker:alpha\./);
			assert.match(rows[1].text, /Done with marker:beta\./);

			// Protocol truth: two prompts, two unique assistant messages per turn, two correlated
			// answers. Ids are unique per process (a runtime replacement between prompts must not
			// produce two messages with the same id).
			const traffic = readPiTraffic(fixture.piTrafficLog);
			assert.deepEqual(
				traffic.filter((entry) => entry.kind === "prompt").map((entry) => entry.text),
				["first turn please marker:alpha", "second turn please marker:beta"],
			);
			const messageStarts = traffic
				.filter((entry) => entry.kind === "event" && entry.event?.type === "message_start")
				.map((entry) => entry.event.message?.id);
			assert.equal(messageStarts.length, 4, `two messages per prompt (announce + reply): ${JSON.stringify(messageStarts)}`);
			assert.equal(new Set(messageStarts).size, messageStarts.length, `message ids must never repeat: ${JSON.stringify(messageStarts)}`);
			// The announcing text is folded into the execution summary once the tool starts, so
			// read it from the protocol (it is the per-prompt identity the UI rows echo).
			const bodies = traffic
				.filter((entry) => entry.kind === "event" && entry.event?.type === "message_end")
				.map((entry) => entry.event.message?.content?.[0]?.text ?? "");
			assert.equal(bodies.length, 4, `announce + reply per prompt: ${JSON.stringify(bodies)}`);
			assert.ok(bodies.some((text) => text.includes("marker:alpha")), `turn 1 body marker: ${JSON.stringify(bodies)}`);
			assert.ok(bodies.some((text) => text.includes("marker:beta")), `turn 2 body marker: ${JSON.stringify(bodies)}`);
			const answers = traffic.filter((entry) => entry.kind === "ui-response");
			// The fake logs the received frame as parsed JSON, so `line` is an object here.
			const answerIds = answers.map((entry) => (typeof entry.line === "string" ? JSON.parse(entry.line).id : entry.line?.id));
			assert.equal(answerIds.length, 2, `both asks must be answered: ${JSON.stringify(answerIds)}`);
			assert.equal(new Set(answerIds).size, 2, `each ask is answered by its own id: ${JSON.stringify(answerIds)}`);
			assert.deepEqual(answers.map((entry) => entry.matched), [true, true], `every answer must match the pending ask: ${JSON.stringify(answers.map((entry) => entry.matched))}`);
			const toolCalls = traffic
				.filter((entry) => entry.kind === "event" && entry.event?.type === "tool_execution_start")
				.map((entry) => entry.event.toolCallId);
			assert.equal(toolCalls.length, 2, `one tool call per prompt: ${JSON.stringify(toolCalls)}`);
			assert.equal(new Set(toolCalls).size, 2, `tool call ids must differ per turn: ${JSON.stringify(toolCalls)}`);
		});

		test("a user stop aborts the packaged turn and pi really receives the abort", async (t) => {
			const { cdp, fixture } = await withHost(t);
			await openAgent(cdp);
			// First turn of a fresh session: the stream renders as a live assistant row.
			await cdp.sendPrompt("please abort-me now");
			await waitForText(cdp, "streaming chunk", { timeoutMs: 90_000 });
			await waitFor(cdp, "Boolean([...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === 'Stop'))", {
				label: "the composer stop control",
			});
			assert.equal(await cdp.clickByLabel("Stop"), true, "the stop control could not be clicked");
			await waitForText(cdp, "Stop requested", { timeoutMs: 30_000 });
			await waitForText(cdp, "Agent is working", { absent: true, timeoutMs: 60_000 });
			assert.ok(
				readPiTraffic(fixture.piTrafficLog).some((entry) => entry.kind === "aborted"),
				"pi must receive the abort command",
			);

			// An abort stops one run, not the session: the next prompt must start a fresh turn
			// with a fresh ask (the fake resets its abort latch per turn) and render a new row.
			await cdp.sendPrompt("turn after the stop marker:after-stop");
			await waitForText(cdp, "Deploy target? (marker:after-stop)", { timeoutMs: 120_000 });
			await answerAsk(cdp);
			await waitForText(cdp, "Agent is working", { absent: true, timeoutMs: 60_000 });
			await waitFor(cdp, "document.querySelectorAll('[data-final-answer]').length === 1", {
				timeoutMs: 30_000,
				label: "the post-abort final answer row",
			});
			const rows = await finalAnswers(cdp);
			assert.equal(rows.length, 1, `the post-abort turn must settle as one answer row: ${JSON.stringify(rows)}`);
			assert.match(rows[0].text, /Done with marker:after-stop\./);
		});

		test("the packaged sidecar runs a real PTY for the renderer that owns the session", async (t) => {
			const { cdp, fixture } = await withHost(t);
			const shells = await pageRpc(cdp, "terminal:shells");
			assert.equal(shells.payload.ok, true, JSON.stringify(shells.payload));
			const candidates = shells.payload.result ?? [];
			assert.ok(candidates.length > 0, "the packaged host must discover at least one shell candidate");

			const target = { kind: "project", projectId: "fixture-project", cwd: fixture.project };
			const created = await pageRpc(cdp, "terminal:create", [target, candidates[0].shell]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const tab = created.payload.result;
			assert.match(tab.id, /^[0-9a-f-]{36}$/i);

			const marker = join(fixture.project, "pty-marker.txt");
			if (existsSync(marker)) unlinkSync(marker);
			const command = `echo pideck-pty> "${marker}"\r\n`;
			const written = await pageRpc(cdp, "terminal:input", [tab.id, command]);
			assert.equal(written.payload.ok, true, JSON.stringify(written.payload));

			const deadline = Date.now() + 30_000;
			let content = "";
			while (Date.now() < deadline) {
				if (existsSync(marker)) {
					content = readFileSync(marker, "utf8").trim();
					if (content.includes("pideck-pty")) break;
				}
				await sleep(200);
			}
			assert.equal(content.includes("pideck-pty"), true, `the PTY never executed the command (marker=${content})`);
			const closed = await pageRpc(cdp, "terminal:close", [tab.id]);
			assert.equal(closed.payload.ok, true, JSON.stringify(closed.payload));
		});
	});
}
