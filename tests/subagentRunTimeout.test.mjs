import assert from "node:assert/strict";
import test from "node:test";
import {
	completedResult, createFixture, loadSubagentResumeGraph,
	resetDoubles, runSyncCalls, seedCompletedForegroundRun, setRunSyncBehavior,
} from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();
const { resolveForegroundTimeout, resolveSingleAgentLaunchTimeout, resolveConfigDefaultTimeoutMs } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/subagent-executor.ts");
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

test("run timeout resolution has no implicit limit for any foreground launch shape", () => {
	for (const shape of [{ agent: "worker" }, { tasks: [{ agent: "worker", task: "Inspect" }] }, { chain: [{ agent: "worker", task: "Inspect" }] }, { workflowScript: "return 1" }]) {
		assert.deepEqual(resolveSingleAgentLaunchTimeout(shape), {});
	}
});

test("explicit run timeout aliases and configured defaults keep their precedence", () => {
	assert.deepEqual(resolveSingleAgentLaunchTimeout({ agent: "worker" }, 4000), { timeoutMs: 4000 });
	assert.deepEqual(resolveSingleAgentLaunchTimeout({ agent: "worker", timeoutMs: 2000 }, 4000), { timeoutMs: 2000 });
	assert.deepEqual(resolveSingleAgentLaunchTimeout({ agent: "worker", maxRuntimeMs: 3000 }, 4000), { timeoutMs: 3000 });
	assert.deepEqual(resolveSingleAgentLaunchTimeout({ tasks: [{ agent: "worker", task: "Inspect" }] }, 4000), { timeoutMs: 4000 });
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

for (const mode of ["single", "parallel", "chain", "workflow", "resume"]) {
	test(`${mode} launch does not inject a thirty-minute deadline`, async () => {
		const fixture = createFixture(graph, `timeout-${mode}`);
		const executor = graph.createSubagentExecutor(fixture.deps);
		resetDoubles();
		setRunSyncBehavior(() => completedResult(fixture));
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
			request.async = false;
		}
		const result = await executor.execute(`timeout-${mode}`, request, new AbortController().signal, undefined, fixture.ctx);
		assert.notEqual(result.isError, true, textOf(result));
		const launches = runSyncCalls.map((call) => call.options);
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
