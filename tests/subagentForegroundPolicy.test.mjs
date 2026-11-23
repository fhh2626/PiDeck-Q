/** Foreground execution remains enforced independently of the prompt extension. */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { loadSubagentResumeGraph, createFixture, resetDoubles, setRunSyncBehavior, runSyncCalls, completedResult } from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();
const abortSignal = () => new AbortController().signal;
const textOf = (result) => result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
beforeEach(resetDoubles);

for (const entry of ["executePublic", "executeDelegated", "execute"]) {
	test(`${entry} rejects an independent background launch before creating a child`, async () => {
		const fixture = createFixture(graph, entry);

		const result = await graph.createSubagentExecutor(fixture.deps)[entry](
			"background", { agent: "worker", task: "Read the project.", async: true },
			abortSignal(), undefined, fixture.ctx,
		);
		assert.equal(result.isError, true, textOf(result));
		assert.match(textOf(result), /foreground|background.*removed/i);

		assert.equal(runSyncCalls.length, 0);
	});
}

test("legacy async defaults do not change a foreground launch", async () => {
	const fixture = createFixture(graph, "legacy-defaults");
	fixture.config.asyncByDefault = true;
	fixture.config.forceTopLevelAsync = true;
	fixture.deps.asyncByDefault = true;
	fixture.discoveredAgents[0].defaultAsync = true;
	setRunSyncBehavior(() => completedResult(fixture));
	const result = await graph.createSubagentExecutor(fixture.deps).executePublic(
		"foreground", { agent: "worker", task: "Read the project." }, abortSignal(), undefined, fixture.ctx,
	);
	assert.notEqual(result.isError, true, textOf(result));
	assert.equal(runSyncCalls.length, 1);

});

test("workflow child background requests fail without launching that child", async () => {
	const fixture = createFixture(graph, "workflow-background");

	const result = await graph.createSubagentExecutor(fixture.deps).executePublic(
		"workflow", { mission: false, workflowScript: "return runs.run('child', {agent:'worker', task:'Read', async:true})" },
		abortSignal(), undefined, fixture.ctx,
	);
	assert.equal(result.isError, true, textOf(result));
	assert.match(textOf(result), /foreground|background.*removed/i);

	assert.equal(runSyncCalls.length, 0);
});

test("removed schedule actions cannot invoke a supplied scheduler", async () => {
	const fixture = createFixture(graph, "schedule");
	let called = false;
	fixture.deps.handleScheduledRunAction = () => { called = true; throw new Error("scheduler invoked"); };
	const result = await graph.createSubagentExecutor(fixture.deps).executePublic(
		"schedule", { action: "schedule.list" }, abortSignal(), undefined, fixture.ctx,
	);
	assert.equal(result.isError, true, textOf(result));
	assert.equal(called, false);
});
