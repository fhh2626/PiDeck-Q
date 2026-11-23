/** Exercise foreground execution without real tools, model requests, or wall-clock waits. */
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

/** A controllable child leaves one read call pending until the test completes or cancels it. */
function childFixture() {
	let listener;
	let aborts = 0;
	let disposed = false;
	let prompts = 0;
	const started = Promise.withResolvers();
	const pending = Promise.withResolvers();
	const child = {
		messages: [],
		modelId: "test/model",
		sessionId: "timeout-test-child",
		subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
		async prompt() {
			prompts += 1;
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
		get prompts() { return prompts; },
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

/** Launch the production foreground execution host with the same child fixture. */
function launch(t, host, fixture, toolTimeoutMs, creation, timeoutMs) {
	const cwd = mkdtempSync(join(tmpdir(), "pideck-tool-timeout-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const factory = {
		async create() {
			creation?.started.resolve();
			if (creation) await creation.pending.promise;
			return fixture.child;
		},
		async dispose() {},
	};
	{
		const owner = new AbortController();
		const interrupt = new AbortController();
		return {
			stop: () => owner.abort(),
			interrupt: () => interrupt.abort(),
			result: runSync(cwd, [{ name: "worker", description: "Offline timeout fixture", systemPrompt: "Read the file.", model: "test/model", tools: ["read"], completionGuard: false }], "worker", "Read input.txt.", {
				cwd,
				runId: "tool-timeout-foreground",
				acceptance: false,
				artifactConfig: { enabled: false },
				childSessionFactory: factory,
				signal: owner.signal,
				interruptSignal: interrupt.signal,
				toolTimeoutMs,
				timeoutMs,
				recoveryBrief: async () => ({ ok: false, reason: "Offline test." }),
			}),
		};
	}
}

for (const host of ["foreground"]) {
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

	for (const timeoutMs of [undefined, 5000]) {
		test(`${host} tools honor an explicit timeout ${timeoutMs === undefined ? "without a run deadline" : "before a longer run deadline"}`, async (t) => {
			t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
			const fixture = childFixture();
			const run = launch(t, host, fixture, 1000, undefined, timeoutMs);
			await fixture.started;
			t.mock.timers.tick(1001);
			const result = await run.result;
			assert.equal(fixture.aborts, 1);
			assert.equal(result.exitCode, 1);
			assert.equal(result.timedOut, true);
			assert.match(result.error, /Tool 'read' exceeded its timeout of 1000ms/);
			assert.match(result.finalOutput, /Tool 'read' exceeded its timeout of 1000ms/);
			assert.doesNotMatch(result.finalOutput, /timed out after (?:0|5000)ms/);
			assert.equal(fixture.disposed, true);
		});
	}

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

	test(`${host} stop during child startup prevents a late prompt from running`, async (t) => {
		const fixture = childFixture();
		const creation = { started: Promise.withResolvers(), pending: Promise.withResolvers() };
		const run = launch(t, host, fixture, undefined, creation);
		await creation.started.promise;
		run.stop();
		creation.pending.resolve();
		const result = await run.result;
		assert.equal(fixture.prompts, 0, "a stopped launch must not start model or tool work after startup completes");
		assert.equal(result.exitCode, 1);
		assert.equal(fixture.disposed, true);
	});

	test(`${host} interrupt during child startup preserves the paused outcome without starting a prompt`, async (t) => {
		const fixture = childFixture();
		const creation = { started: Promise.withResolvers(), pending: Promise.withResolvers() };
		const run = launch(t, host, fixture, undefined, creation);
		await creation.started.promise;
		run.interrupt();
		creation.pending.resolve();
		const result = await run.result;
		assert.equal(fixture.prompts, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(fixture.disposed, true);
	});

	test(`${host} explicit deadline during child startup prevents a late prompt from running`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const fixture = childFixture();
		const creation = { started: Promise.withResolvers(), pending: Promise.withResolvers() };
		const run = launch(t, host, fixture, undefined, creation, 1000);
		await creation.started.promise;
		t.mock.timers.tick(1001);
		// The background runner owns its run deadline and calls this registered boundary.

		creation.pending.resolve();
		const result = await run.result;
		assert.equal(fixture.prompts, 0);
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, 1);
		assert.match(result.error, /timed out/i);
		assert.equal(fixture.disposed, true);
	});

	test(`${host} an earlier startup interrupt remains paused when the deadline passes`, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
		const fixture = childFixture();
		const creation = { started: Promise.withResolvers(), pending: Promise.withResolvers() };
		const run = launch(t, host, fixture, undefined, creation, 1000);
		await creation.started.promise;
		run.interrupt();
		t.mock.timers.tick(1001);
		creation.pending.resolve();
		const result = await run.result;
		assert.equal(fixture.prompts, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(fixture.disposed, true);
	});

	test(`${host} elapsed startup deadline prevents a prompt before the timer callback runs`, async (t) => {
		const now = Date.now();
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
		const fixture = childFixture();
		const creation = { started: Promise.withResolvers(), pending: Promise.withResolvers() };
		const run = launch(t, host, fixture, undefined, creation, 1000);
		await creation.started.promise;
		// A busy startup may finish in a promise continuation before overdue timers run.
		t.mock.timers.setTime(now + 1001);
		creation.pending.resolve();
		await new Promise((resolve) => setImmediate(resolve));
		const promptsBeforeTimeoutCallback = fixture.prompts;
		t.mock.timers.tick(0);

		const result = await run.result;
		assert.equal(promptsBeforeTimeoutCallback, 0, "an expired launch must not start fresh work while its timer callback is pending");
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, 1);
		assert.equal(fixture.disposed, true);
	});
}
