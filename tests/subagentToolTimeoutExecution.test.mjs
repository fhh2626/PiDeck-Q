/** Exercise both execution hosts without real tools, model requests, or wall-clock waits. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { installSubagentGraphLoader } from "./helpers/subagentGraphLoader.mjs";

// Keep persisted provider failures from unrelated fixtures out of this execution suite.
const modelCacheDir = mkdtempSync(join(tmpdir(), "pideck-tool-timeout-models-"));
const previousExclusionsPath = process.env.PI_MODEL_EXCLUSIONS_PATH;
process.env.PI_MODEL_EXCLUSIONS_PATH = join(modelCacheDir, "model-exclusions.json");
after(() => {
	if (previousExclusionsPath === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
	else process.env.PI_MODEL_EXCLUSIONS_PATH = previousExclusionsPath;
	rmSync(modelCacheDir, { recursive: true, force: true });
});

installSubagentGraphLoader();
const { runSync } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/execution.ts");
const { runChildSession } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/run-child-session.ts");
const { buildInProcessChildLaunch } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts");

/** A controllable child leaves one read call pending until the test completes or cancels it. */
function childFixture() {
	let listener;
	let aborts = 0;
	let disposed = false;
	const started = Promise.withResolvers();
	const pending = Promise.withResolvers();
	const child = {
		messages: [],
		modelId: "test/model",
		sessionId: "timeout-test-child",
		subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
		async prompt() {
			listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "input.txt" } });
			started.resolve();
			await pending.promise;
		},
		async abort() { aborts += 1; pending.resolve(); },
		async dispose() { disposed = true; },
		async steer() {},
		async followUp() {},
	};
	return {
		child,
		started: started.promise,
		get aborts() { return aborts; },
		get disposed() { return disposed; },
		emit(event) { listener(event); },
		complete() {
			listener({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" });
			const message = { role: "assistant", content: [{ type: "text", text: "Read completed." }], stopReason: "stop", timestamp: Date.now() };
			child.messages.push(message);
			listener({ type: "message_end", message });
			pending.resolve();
		},
	};
}

/** Launch the production foreground or background execution host with the same child fixture. */
function launch(t, host, fixture, toolTimeoutMs) {
	const cwd = mkdtempSync(join(tmpdir(), "pideck-tool-timeout-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const factory = { async create() { return fixture.child; }, async dispose() {} };
	if (host === "foreground") {
		const owner = new AbortController();
		return {
			stop: () => owner.abort(),
			result: runSync(cwd, [{ name: "worker", description: "Offline timeout fixture", systemPrompt: "Read the file.", model: "test/model", tools: ["read"], completionGuard: false }], "worker", "Read input.txt.", {
				cwd,
				runId: "tool-timeout-foreground",
				acceptance: false,
				artifactConfig: { enabled: false },
				childSessionFactory: factory,
				signal: owner.signal,
				toolTimeoutMs,
				recoveryBrief: async () => ({ ok: false, reason: "Offline test." }),
			}),
		};
	}
	let stop;
	const result = runChildSession({
		factory,
		launch: buildInProcessChildLaunch({ cwd, host: "runner", childAgentName: "worker", childIndex: 0, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: ["read"], model: "test/model" }),
		prompt: "Read input.txt.",
		appendChildEvent() {},
		writeOutputLine() {},
		registerStop(callback) { stop = callback; },
		toolTimeoutMs,
	});
	return { result, stop: () => stop?.() };
}

for (const host of ["foreground", "background"]) {
	test(`${host} tools remain live beyond five minutes by default`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const fixture = childFixture();
		const run = launch(t, host, fixture);
		await fixture.started;
		t.mock.timers.tick(300_001);
		assert.equal(fixture.aborts, 0);
		fixture.complete();
		const result = await run.result;
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.finalOutput, "Read completed.");
		assert.equal(fixture.disposed, true);
	});

	test(`${host} tools still honor an explicit timeout`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const fixture = childFixture();
		const run = launch(t, host, fixture, 1000);
		await fixture.started;
		t.mock.timers.tick(1001);
		const result = await run.result;
		assert.equal(fixture.aborts, 1);
		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, true);
		assert.match(result.error, /Tool 'read' exceeded its timeout of 1000ms/);
		assert.equal(fixture.disposed, true);
	});

	test(`${host} tool result messages clear only the matching concurrent deadline`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const fixture = childFixture();
		const run = launch(t, host, fixture, 1000);
		await fixture.started;
		t.mock.timers.tick(500);
		fixture.emit({ type: "tool_execution_start", toolCallId: "read-2", toolName: "read", args: { path: "other.txt" } });
		fixture.emit({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "First read finished." }], isError: false, timestamp: Date.now() } });
		t.mock.timers.tick(501);
		assert.equal(fixture.aborts, 0, "the completed first read must not time out the still-live second read");
		fixture.emit({ type: "tool_execution_end", toolCallId: "read-2", toolName: "read" });
		fixture.complete();
		const result = await run.result;
		assert.equal(result.exitCode, 0);
		assert.equal(result.timedOut, undefined);
	});

	test(`${host} tools without a deadline can still be stopped manually`, async (t) => {
		const fixture = childFixture();
		const run = launch(t, host, fixture);
		await fixture.started;
		run.stop();
		const result = await run.result;
		assert.equal(fixture.aborts, 1);
		assert.equal(result.exitCode, 1);
		assert.equal(result.timedOut, undefined);
		assert.equal(fixture.disposed, true);
	});
}
