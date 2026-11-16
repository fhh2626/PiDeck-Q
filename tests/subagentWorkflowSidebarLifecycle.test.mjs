import assert from "node:assert/strict";
import test from "node:test";

import {
	completedResult,
	createFixture,
	loadSubagentResumeGraph,
	resetDoubles,
	setRunSyncBehavior,
} from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();

function launch(executor, fixture, onUpdate, script, signal) {
	return executor.executePublic("workflow-run", {
		workflowScript: script,
		async: false,
		output: false,
		timeoutMs: 5000,
	}, signal, onUpdate, fixture.ctx);
}

test("a throwing progress callback never changes the workflow outcome", async () => {
	const fixture = createFixture(graph, "throwing-update");
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, { finalOutput: "child done" }));
	const executor = graph.createSubagentExecutor(fixture.deps);
	const controller = new AbortController();
	// 宿主状态上报失败不能把子代理/工作流判失败，也不能变成未捕获异常。
	const result = await launch(executor, fixture, () => { throw new Error("host update failed"); }, `
		return runs.run("child", { agent: "worker", task: "do work", async: false, acceptance: false });
	`, controller.signal);
	assert.notEqual(result.isError, true);
	assert.match(result.content.map((part) => part.text ?? "").join("\n"), /child done/);
	controller.abort();
});
