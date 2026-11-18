/** Exercise timed reviews through both production execution hosts and the native parent tools. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { installSubagentGraphLoader } from "./helpers/subagentGraphLoader.mjs";

// Provider-error fixtures must never persist exclusions into another execution suite.
const modelCacheDir = mkdtempSync(join(tmpdir(), "pideck-run-supervision-models-"));
const modelCacheFile = join(modelCacheDir, "model-exclusions.json");
const previousExclusionsPath = process.env.PI_MODEL_EXCLUSIONS_PATH;
const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_MODEL_EXCLUSIONS_PATH = modelCacheFile;
process.env.PI_SUBAGENTS_TEMP_ROOT = join(modelCacheDir, "subagents");
after(() => {
	if (previousExclusionsPath === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
	else process.env.PI_MODEL_EXCLUSIONS_PATH = previousExclusionsPath;
	if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
	rmSync(modelCacheDir, { recursive: true, force: true });
});

installSubagentGraphLoader();
const { runSync } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/execution.ts");
const { runChildSession } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/run-child-session.ts");
const { buildInProcessChildLaunch } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts");
const { DEFAULT_CONTROL_CONFIG } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/subagent-control.ts");
const { RUN_SUPERVISION_INTERVAL_MS } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/run-supervision.ts");
const native = await import("../resources/extensions/pideck-q-subagents/src/intercom/native-supervisor-channel.ts");
const { reloadFromDisk } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/model-exclusions.ts");
beforeEach(() => { rmSync(modelCacheFile, { force: true }); reloadFromDisk(); });

const flush = () => new Promise((resolve) => setImmediate(resolve));

function eventBus() {
	const handlers = new Map();
	return {
		on(name, callback) { const listeners = handlers.get(name) ?? new Set(); listeners.add(callback); handlers.set(name, listeners); return () => listeners.delete(callback); },
		emit(name, value) { for (const callback of handlers.get(name) ?? []) callback(value); },
	};
}

/** A live read deliberately makes no progress until completion or the production host's abort. */
function childFixture({ tool = true, providerErrorOnAbort = false, onAbort } = {}) {
	let listener;
	let aborts = 0;
	let disposals = 0;
	let prompts = 0;
	let pendingTool = tool;
	const started = Promise.withResolvers();
	const pending = Promise.withResolvers();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const child = {
		messages: [], modelId: "test/model", sessionId: `child-${randomUUID()}`,
		subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
		async prompt() {
			prompts++;
			if (tool) listener({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "input.txt" } });
			started.resolve();
			await pending.promise;
		},
		async abort() {
			aborts++;
			onAbort?.();
			if (providerErrorOnAbort) {
				const message = { role: "assistant", content: [], usage, stopReason: "error", errorMessage: "HTTP 429 provider rate limit", timestamp: Date.now() };
				child.messages.push(message);
				listener?.({ type: "message_end", message });
			}
			pending.resolve();
		},
		async dispose() { disposals++; },
		async steer() {}, async followUp() {},
	};
	return {
		child, started: started.promise,
		get aborts() { return aborts; }, get disposals() { return disposals; }, get prompts() { return prompts; },
		failProvider() {
			const message = { role: "assistant", content: [], usage, stopReason: "error", errorMessage: "HTTP 429 provider rate limit", timestamp: Date.now() };
			child.messages.push(message);
			listener?.({ type: "message_end", message });
			pending.resolve();
		},
		complete() {
			if (pendingTool) {
				pendingTool = false;
				listener?.({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" });
			}
			const message = { role: "assistant", content: [{ type: "text", text: "Read completed." }], usage, stopReason: "stop", timestamp: Date.now() };
			child.messages.push(message);
			listener?.({ type: "message_end", message });
			pending.resolve();
		},
		cleanup() { pending.resolve(); },
	};
}

/** The native channel and executor share the same parent identity and transport bus. */
function launch(t, host, child, { enabled = true, fallback = false, detach = true, attempts = [child], stepRunner, rootRunner, parallel = false } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pideck-run-supervision-"));
	const runId = `review-${host}-${randomUUID()}`;
	const parentSessionId = `owner-${randomUUID()}`;
	const channelDir = native.resolveSupervisorChannelDir(runId, "worker", 0);
	const events = eventBus();
	const tools = new Map();
	const notifications = [];
	const rememberedChild = { index: 0, agent: "worker", status: "running", currentTool: "read", currentToolStartedAt: Date.now() };
	const state = {
		currentSessionId: parentSessionId, supervisorOwnerSessionId: parentSessionId,
		foregroundControls: new Map(host === "foreground" ? [[runId, { sessionId: parentSessionId }]] : []),
		foregroundRuns: new Map(host === "foreground" ? [[runId, { runId, children: [rememberedChild] }]] : []),
		asyncJobs: new Map(host === "background" ? [[runId, { status: "running", steps: [{ status: "running", agent: "worker" }] }]] : []),
	};
	events.on("pi-intercom:detach-response", (event) => { if (event.runId === runId && event.accepted) rememberedChild.status = "detached"; });
	const pi = { events, registerTool(tool) { tools.set(tool.name, tool); }, getAllTools: () => [...tools.values()], sendMessage(message) { notifications.push(message); } };
	const idleHandle = { unref() {} };
	const channel = native.createNativeSupervisorChannel(pi, state, { platform: "win32",
		timers: { setInterval: () => idleHandle, clearInterval() {}, setImmediate: () => idleHandle, clearImmediate() {} },
	});
	channel.start();
	let creates = 0;
	const factory = { async create() { const next = attempts[creates++]; assert.ok(next, "an unexpected replacement child was created"); return next.child; }, async dispose() {} };
	const owner = new AbortController();
	const interrupt = new AbortController();
	const detached = Promise.withResolvers();
	let receipt;
	let result;
	if (host === "foreground") {
		receipt = runSync(cwd, [{ name: "worker", description: "Offline review fixture", systemPrompt: "Read the file.", model: "test/model", fallbackModels: fallback ? ["test/fallback"] : undefined, tools: ["read"], completionGuard: false }], "worker", "Read input.txt.", {
			cwd, runId, index: 0, parentSessionId, orchestratorIntercomTarget: parentSessionId,
			acceptance: false, artifactConfig: { enabled: false }, childSessionFactory: factory, signal: owner.signal, interruptSignal: interrupt.signal,
			allowIntercomDetach: detach, intercomEvents: events, retainAbortOnDetach: true,
			controlConfig: { ...DEFAULT_CONTROL_CONFIG, enabled },
			onDetachedExit(terminal) { detached.resolve(terminal); },
			recoveryBrief: async () => ({ ok: false, reason: "Offline test." }),
		});
		result = receipt.then((value) => value.detached ? detached.promise : value);
	} else if (rootRunner) {
		const asyncDir = join(cwd, "async");
		const resultPath = join(cwd, "result.json");
		mkdirSync(asyncDir);
		const step = { agent: "worker", task: "Read input.txt.", parentSessionId, tools: ["read"], model: "test/model", completionGuard: false };
		result = rootRunner({ id: runId, cwd, asyncDir, resultPath, placeholder: "{previous}", sessionId: parentSessionId,
			steps: parallel ? [{ parallel: [step], concurrency: 1 }] : [step],
			controlIntercomTarget: parentSessionId, controlConfig: { ...DEFAULT_CONTROL_CONFIG, enabled }, artifactConfig: { enabled: false },
		}, factory).then(() => ({ ...JSON.parse(readFileSync(resultPath, "utf-8")), status: JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf-8")) }));
	} else if (stepRunner) {
		result = stepRunner({ agent: "worker", task: "Read input.txt.", parentSessionId, tools: ["read"], model: "test/model",
			modelCandidates: fallback ? ["test/model", "test/fallback"] : ["test/model"], completionGuard: false,
		}, {
			previousOutput: "", placeholder: "{previous}", cwd, sessionEnabled: false, id: runId, flatIndex: 0, flatStepCount: 1,
			outputFile: join(cwd, "step.txt"), childSessions: factory, artifactConfig: { enabled: false },
			orchestratorIntercomTarget: parentSessionId, runSupervisionEnabled: enabled,
		});
	} else {
		result = runChildSession({
			factory,
			launch: buildInProcessChildLaunch({ cwd, host: "runner", runId, parentSessionId, orchestratorIntercomTarget: parentSessionId,
				childAgentName: "worker", childIndex: 0, sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: ["read"], model: "test/model" }),
			prompt: "Read input.txt.", appendChildEvent() {}, writeOutputLine() {}, runSupervisionEnabled: enabled,
		});
	}
	t.after(async () => {
		owner.abort();
		for (const attempt of attempts) attempt.cleanup();
		await flush();
		channel.dispose();
		rmSync(channelDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	return {
		receipt, result, notifications, channelDir, interrupt: () => interrupt.abort(), get creates() { return creates; },
		async pending() { return (await tools.get("subagent_supervisor").execute("pending", { action: "pending" })).details.pending; },
		rawReply(id, message) { return tools.get("subagent_supervisor").execute("reply", { action: "reply", replyTo: id, message }); },
		async reply(id, message) {
			const reply = await tools.get("subagent_supervisor").execute("reply", { action: "reply", replyTo: id, message });
			t.mock.timers.tick(251);
			await flush();
			return reply;
		},
	};
}

for (const host of ["foreground", "background"]) {
	test(`${host} reviews a live read at 600 seconds and continues the same child until STOP`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const child = childFixture();
		const run = launch(t, host, child);
		await child.started;
		t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS - 1);
		await flush();
		assert.equal((await run.pending()).length, 0);
		assert.equal(child.aborts, 0);
		t.mock.timers.tick(1);
		await flush();
		let requests = await run.pending();
		assert.equal(requests.length, 1);
		assert.match(requests[0].message, /"elapsedSeconds": 600/);
		assert.match(requests[0].message, /"currentTools":\s*\[\s*"read"/);
		assert.match(requests[0].message, /Read input\.txt/);
		assert.equal(child.aborts, 0);
		assert.equal(child.disposals, 0);
		if (host === "foreground") {
			const receipt = await run.receipt;
			assert.equal(receipt.detached, true, "the parent must receive control before the child has finished");
			assert.equal(receipt.detachedReason, "intercom coordination");
			assert.equal(receipt.progress.currentTool, "read");
		}
		await run.reply(requests[0].id, "CONTINUE");
		assert.equal(child.prompts, 1);
		assert.equal(run.creates, 1, "a continue decision must not create a replacement child");
		assert.equal(child.aborts, 0);
		t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS - 1);
		await flush();
		assert.equal((await run.pending()).length, 0);
		t.mock.timers.tick(1);
		await flush();
		requests = await run.pending();
		assert.equal(requests.length, 1, "the continued child must be reviewed again");
		await run.reply(requests[0].id, "STOP");
		const terminal = await run.result;
		assert.equal(terminal.stopped, true);
		assert.equal(terminal.timedOut, undefined);
		assert.equal(terminal.exitCode, 1);
		assert.equal(child.aborts, 1);
		assert.equal(child.disposals, 1);
		assert.equal(run.creates, 1);
		assert.equal((await run.pending()).length, 0);
		assert.deepEqual(readdirSync(join(run.channelDir, "requests")), []);
		assert.deepEqual(readdirSync(join(run.channelDir, "replies")), []);
	});

	test(`${host} completion cancels a pending review and rejects a late STOP`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const child = childFixture();
		const run = launch(t, host, child);
		await child.started;
		t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
		await flush();
		const requests = await run.pending();
		assert.equal(requests.length, 1);
		child.complete();
		const terminal = await run.result;
		assert.equal(terminal.exitCode, 0);
		assert.equal(terminal.finalOutput, "Read completed.");
		assert.equal(child.aborts, 0);
		assert.equal(child.disposals, 1);
		assert.equal((await run.pending()).length, 0);
		const late = await run.reply(requests[0].id, "STOP");
		assert.equal(late.isError, true);
		assert.equal(late.details.delivered, false);
		assert.equal(child.aborts, 0);
	});

	test(`${host} disabled control creates no timed supervision request`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const child = childFixture();
		const run = launch(t, host, child, { enabled: false });
		await child.started;
		t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS * 3);
		await flush();
		assert.equal((await run.pending()).length, 0);
		assert.equal(run.notifications.length, 0);
		assert.equal(child.aborts, 0);
		child.complete();
		assert.equal((await run.result).exitCode, 0);
	});
}

test("foreground STOP cannot fall back to another model after a provider error", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const child = childFixture({ tool: false, providerErrorOnAbort: true });
	const run = launch(t, "foreground", child, { fallback: true, detach: false });
	await child.started;
	t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
	await flush();
	const requests = await run.pending();
	assert.equal(requests.length, 1);
	await run.reply(requests[0].id, "STOP");
	const terminal = await run.result;
	assert.equal(terminal.stopped, true);
	assert.equal(terminal.modelAttempts.length, 1);
	assert.equal(run.creates, 1);
	assert.equal(child.prompts, 1);
	assert.equal(child.disposals, 1);
});

test("foreground model fallback preserves the logical child's elapsed review window", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const first = childFixture({ tool: false });
	const second = childFixture();
	second.child.modelId = "test/fallback";
	const run = launch(t, "foreground", first, { fallback: true, attempts: [first, second] });
	await first.started;
	t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS - 1);
	await flush();
	assert.equal((await run.pending()).length, 0);
	first.failProvider();
	await second.started;
	assert.equal(first.disposals, 1);
	assert.equal(run.creates, 2);
	t.mock.timers.tick(1);
	await flush();
	const requests = await run.pending();
	assert.equal(requests.length, 1, "the second model must report at the original logical child's 600-second deadline");
	assert.match(requests[0].message, /"elapsedSeconds": 600/);
	assert.match(requests[0].message, /"currentTools":\s*\[\s*"read"/);
	assert.equal(second.aborts, 0);
	await run.reply(requests[0].id, "STOP");
	const terminal = await run.result;
	assert.equal(terminal.stopped, true);
	assert.equal(terminal.modelAttempts.length, 2);
	assert.equal(second.aborts, 1);
	assert.equal(second.disposals, 1);
});

test("background model fallback preserves the logical child's elapsed review window", async (t) => {
	const previousChildFlag = process.env.PI_SUBAGENT_CHILD;
	const { runSingleStepInner } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-runner.ts");
	if (previousChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = previousChildFlag;
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const first = childFixture({ tool: false });
	const second = childFixture();
	second.child.modelId = "test/fallback";
	const run = launch(t, "background", first, { fallback: true, attempts: [first, second], stepRunner: runSingleStepInner });
	await first.started;
	t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS - 1);
	await flush();
	assert.equal((await run.pending()).length, 0);
	first.failProvider();
	await second.started;
	assert.equal(first.disposals, 1);
	assert.equal(run.creates, 2);
	t.mock.timers.tick(1);
	await flush();
	const requests = await run.pending();
	assert.equal(requests.length, 1, "background fallback must retain the logical child's original deadline");
	assert.match(requests[0].message, /"elapsedSeconds": 600/);
	await run.reply(requests[0].id, "STOP");
	const terminal = await run.result;
	assert.equal(terminal.stopped, true);
	assert.equal(terminal.modelAttempts.length, 2);
	assert.equal(second.aborts, 1);
	assert.equal(second.disposals, 1);
});

test("foreground STOP remains stopped when an interrupt arrives before the child settles", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	let run;
	const child = childFixture({ onAbort() { run.interrupt(); } });
	run = launch(t, "foreground", child);
	await child.started;
	t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
	await flush();
	const requests = await run.pending();
	await run.reply(requests[0].id, "STOP");
	const terminal = await run.result;
	assert.equal(terminal.stopped, true);
	assert.notEqual(terminal.interrupted, true);
	assert.equal(terminal.exitCode, 1);
	assert.match(terminal.error, /stopped by supervisor/);
	assert.equal(child.aborts, 1);
	assert.equal(child.disposals, 1);
});

test("foreground timed review yields a receipt even when the manual intercom bridge is disabled", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const child = childFixture();
	const run = launch(t, "foreground", child, { detach: false });
	let receipt;
	void run.receipt.then((value) => { receipt = value; });
	await child.started;
	t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
	await flush();
	const requests = await run.pending();
	await flush();
	assert.equal(requests.length, 1);
	assert.equal(receipt?.detached, true, "the parent must be able to review the live child with manual intercom disabled");
	assert.equal(child.aborts, 0);
	assert.equal(child.disposals, 0);
	assert.equal(child.prompts, 1);
	await run.reply(requests[0].id, "CONTINUE");
	assert.equal(run.creates, 1);
	child.complete();
	assert.equal((await run.result).exitCode, 0);
});

for (const host of ["foreground", "background"]) {
	test(`${host} honors an acknowledged STOP when the provider ends before the reply poll`, async (t) => {
		const previousChildFlag = process.env.PI_SUBAGENT_CHILD;
		const { runSingleStepInner } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-runner.ts");
		if (previousChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousChildFlag;
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const first = childFixture({ tool: false });
		const second = childFixture();
		second.child.modelId = "test/fallback";
		const run = launch(t, host, first, { fallback: true, attempts: [first, second], stepRunner: runSingleStepInner });
		await first.started;
		t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
		await flush();
		const requests = await run.pending();
		assert.equal(requests.length, 1);
		const reply = await run.rawReply(requests[0].id, "STOP");
		assert.equal(reply.isError, undefined);
		first.failProvider();
		const outcome = await Promise.race([
			run.result.then((terminal) => ({ terminal })),
			second.started.then(() => ({ replacement: true })),
		]);
		assert.equal(outcome.replacement, undefined, "an acknowledged STOP must prevent automatic model fallback");
		assert.equal(outcome.terminal.stopped, true);
		assert.equal(outcome.terminal.timedOut, undefined);
		assert.equal(outcome.terminal.exitCode, 1);
		assert.match(outcome.terminal.error, /stopped by supervisor/);
		assert.equal(run.creates, 1);
		assert.equal(first.disposals, 1);
		assert.equal((await run.pending()).length, 0);
	});
}

test("background preserves an acknowledged CONTINUE across an immediate provider fallback", async (t) => {
	const previousChildFlag = process.env.PI_SUBAGENT_CHILD;
	const { runSingleStepInner } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-runner.ts");
	if (previousChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = previousChildFlag;
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
	const first = childFixture({ tool: false });
	const second = childFixture();
	second.child.modelId = "test/fallback";
	const run = launch(t, "background", first, { fallback: true, attempts: [first, second], stepRunner: runSingleStepInner });
	await first.started;
	t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
	await flush();
	const [request] = await run.pending();
	assert.equal((await run.rawReply(request.id, "CONTINUE")).isError, undefined);
	first.failProvider();
	await second.started;
	t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS - 1);
	await flush();
	assert.equal((await run.pending()).length, 0, "a successful CONTINUE must preserve the full next review window");
	t.mock.timers.tick(1);
	await flush();
	assert.equal((await run.pending()).length, 1);
	second.complete();
	assert.equal((await run.result).exitCode, 0);
});

for (const parallel of [false, true]) {
	test(`background ${parallel ? "parallel" : "single"} runner keeps the supervisor's stop reason in persisted results`, async (t) => {
		const previousChildFlag = process.env.PI_SUBAGENT_CHILD;
		const { runSubagent } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-runner.ts");
		if (previousChildFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previousChildFlag;
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
		const child = childFixture({ tool: false });
		const run = launch(t, "background", child, { rootRunner: runSubagent, parallel });
		await child.started;
		t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
		await flush();
		const [request] = await run.pending();
		assert.ok(request);
		assert.equal((await run.rawReply(request.id, "STOP")).isError, undefined);
		child.failProvider();
		const terminal = await run.result;
		assert.equal(terminal.results[0].stopped, true);
		assert.match(terminal.results[0].error, /stopped by supervisor/);
		assert.match(terminal.results[0].output, /stopped by supervisor/);
		assert.match(terminal.status.steps[0].error, /stopped by supervisor/);
		assert.equal(run.creates, 1);
	});
}
