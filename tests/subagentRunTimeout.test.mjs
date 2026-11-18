import assert from "node:assert/strict";
import test from "node:test";
import {
	asyncCalls, asyncStartedResult, completedResult, createFixture, loadSubagentResumeGraph,
	resetDoubles, runSyncCalls, seedCompletedForegroundRun, setAsyncBehaviors, setRunSyncBehavior,
} from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();
const { resolveForegroundTimeout, resolveSingleAgentLaunchTimeout, resolveConfigDefaultTimeoutMs } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/subagent-executor.ts");
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("run timeout resolution has no implicit limit for any launch shape", () => {
	for (const async of [false, true]) {
		for (const shape of [{ agent: "worker" }, { tasks: [{ agent: "worker", task: "Inspect" }] }, { chain: [{ agent: "worker", task: "Inspect" }] }, { workflowScript: "return 1" }]) {
			assert.deepEqual(resolveSingleAgentLaunchTimeout(shape, async), {});
		}
	}
});

test("explicit run timeout aliases and configured defaults keep their precedence", () => {
	for (const async of [false, true]) {
		assert.deepEqual(resolveSingleAgentLaunchTimeout({ agent: "worker" }, async, 4000), { timeoutMs: 4000 });
		assert.deepEqual(resolveSingleAgentLaunchTimeout({ agent: "worker", timeoutMs: 2000 }, async, 4000), { timeoutMs: 2000 });
		assert.deepEqual(resolveSingleAgentLaunchTimeout({ agent: "worker", maxRuntimeMs: 3000 }, async, 4000), { timeoutMs: 3000 });
	}
	assert.deepEqual(resolveSingleAgentLaunchTimeout({ tasks: [{ agent: "worker", task: "Inspect" }] }, true, 4000), {}, "a global default must not acquire a new meaning for async composite roots");
	assert.deepEqual(resolveSingleAgentLaunchTimeout({ tasks: [{ agent: "worker", task: "Inspect" }] }, false, 4000), { timeoutMs: 4000 });
});

test("explicit run deadlines reject timer overflow before launch", () => {
	for (const key of ["timeoutMs", "maxRuntimeMs"]) {
		assert.deepEqual(resolveForegroundTimeout({ [key]: MAX_TIMER_DELAY_MS }), { timeoutMs: MAX_TIMER_DELAY_MS });
		for (const value of [0, -1, 1.5, Infinity, MAX_TIMER_DELAY_MS + 1]) {
			assert.match(resolveForegroundTimeout({ [key]: value }).error ?? "", /positive integer.*2147483647/);
		}
	}
	assert.equal(resolveConfigDefaultTimeoutMs(MAX_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS);
	assert.equal(resolveConfigDefaultTimeoutMs(MAX_TIMER_DELAY_MS + 1), undefined);
	assert.match(resolveForegroundTimeout({ timeoutMs: 1, maxRuntimeMs: 2 }).error, /aliases/);
});

for (const mode of ["single", "parallel", "chain", "workflow", "resume", "async-single"]) {
	test(`${mode} launch does not inject a thirty-minute deadline`, async () => {
		const fixture = createFixture(graph, `timeout-${mode}`);
		const executor = graph.createSubagentExecutor(fixture.deps);
		resetDoubles();
		setRunSyncBehavior(() => completedResult(fixture));
		setAsyncBehaviors({ single: (runId) => asyncStartedResult(runId) });
		const request = { async: false, output: false, acceptance: false };
		if (mode === "parallel") request.workflowScript = 'return runs.all([{ key: "one", agent: "worker", task: "Inspect first.", async: false, acceptance: false }, { key: "two", agent: "worker", task: "Inspect second.", async: false, acceptance: false }]);';
		else if (mode === "chain") request.workflowScript = 'await runs.run("one", { agent: "worker", task: "Inspect first.", async: false, acceptance: false }); return runs.run("two", { agent: "worker", task: "Inspect second.", async: false, acceptance: false });';
		else if (mode === "workflow") request.workflowScript = 'return runs.run("one", { agent: "worker", task: "Inspect.", async: false, acceptance: false });';
		else if (mode === "resume") {
			request.action = "resume";
			request.id = "11111111-1111-4111-8111-111111111111";
			request.message = "Continue.";
			seedCompletedForegroundRun(fixture, { runId: request.id });
		} else {
			request.agent = "worker";
			request.task = "Inspect.";
			request.async = mode === "async-single";
		}
		const result = await executor.execute(`timeout-${mode}`, request, new AbortController().signal, undefined, fixture.ctx);
		assert.notEqual(result.isError, true, textOf(result));
		const launches = mode === "async-single" ? asyncCalls.map((call) => call.params) : runSyncCalls.map((call) => call.options);
		assert.ok(launches.length > 0);
		for (const launch of launches) {
			assert.equal(launch.timeoutMs, undefined);
			assert.equal(launch.deadlineAt, undefined);
		}
	});
}

test("agent defaults and call overrides are still passed to a real launch boundary", async () => {
	const fixture = createFixture(graph, "timeout-precedence");
	fixture.discoveredAgents[0].defaultTimeoutMs = 8000;
	fixture.config.timeoutMs = 12000;
	const executor = graph.createSubagentExecutor(fixture.deps);
	for (const [request, expected] of [[{}, 8000], [{ maxRuntimeMs: 4000 }, 4000]]) {
		resetDoubles();
		setRunSyncBehavior(() => completedResult(fixture));
		const result = await executor.executePublic("explicit-timeout", { agent: "worker", task: "Inspect.", async: false, acceptance: false, output: false, ...request }, new AbortController().signal, undefined, fixture.ctx);
		assert.notEqual(result.isError, true, textOf(result));
		assert.equal(runSyncCalls[0].options.timeoutMs, expected);
	}
});

test("an overflowing agent default is rejected before starting a child", async () => {
	const fixture = createFixture(graph, "timeout-agent-overflow");
	fixture.discoveredAgents[0].defaultTimeoutMs = MAX_TIMER_DELAY_MS + 1;
	resetDoubles();
	const result = await graph.createSubagentExecutor(fixture.deps).executePublic("overflow", { agent: "worker", task: "Inspect.", async: false }, new AbortController().signal, undefined, fixture.ctx);
	assert.equal(result.isError, true);
	assert.match(textOf(result), /2147483647/);
	assert.equal(runSyncCalls.length, 0);
});

test("workflow roots reject overflowing deadlines and conflicting aliases before launching children", async () => {
	const fixture = createFixture(graph, "workflow-timeout-validation");
	const executor = graph.createSubagentExecutor(fixture.deps);
	for (const timeout of [{ timeoutMs: MAX_TIMER_DELAY_MS + 1 }, { maxRuntimeMs: MAX_TIMER_DELAY_MS + 1 }, { timeoutMs: 1000, maxRuntimeMs: 2000 }]) {
		resetDoubles();
		const result = await executor.executePublic("invalid-workflow-timeout", { workflowScript: 'return runs.run("one", { agent: "worker", task: "Inspect.", async: false });', async: false, ...timeout }, new AbortController().signal, undefined, fixture.ctx);
		assert.equal(result.isError, true);
		assert.match(textOf(result), /2147483647|aliases/);
		assert.equal(runSyncCalls.length, 0);
	}
});

test("background runner steps have only their explicitly configured agent deadline", async () => {
	// Imported directly from this test to keep the production step builder, while
	// the executor's detached-launch boundary remains replaced by its offline double.
	const { buildAsyncRunnerSteps } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/async-execution.ts");
	const fixture = createFixture(graph, "runner-step-timeouts");
	const step = { agent: "worker", task: "Inspect.", output: false, progress: false, acceptance: false };
	for (const timeoutMs of [undefined, 8000]) {
		fixture.discoveredAgents[0].defaultTimeoutMs = timeoutMs;
		const built = buildAsyncRunnerSteps("timeout-runner", {
			chain: [step, { parallel: [step, step] }],
			agents: fixture.discoveredAgents,
			unknownAgentDiagnosticContext: { cwd: fixture.projectDir, scope: "both", directories: [], agents: fixture.discoveredAgents },
			ctx: { pi: fixture.deps.pi, cwd: fixture.projectDir, currentSessionId: "parent-session-id" },
			maxSubagentDepth: 4,
			asyncDir: fixture.dir,
		});
		assert.equal(built.error, undefined);
		assert.equal(built.steps[0].timeoutMs, timeoutMs);
		for (const child of built.steps[1].parallel) assert.equal(child.timeoutMs, timeoutMs);
	}
});
