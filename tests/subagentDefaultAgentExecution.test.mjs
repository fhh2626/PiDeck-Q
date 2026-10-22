import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
	completedResult, createFixture, loadSubagentResumeGraph,
	resetDoubles, runSyncCalls, setRunSyncBehavior,
} from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();
const { normalizePublicSubagentExecution } = await import("../resources/extensions/pideck-q-subagents/src/extension/public-execution.ts");
const signal = () => new AbortController().signal;
const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

/** Use the default name with a real output setting; only actual child/model execution is doubled. */
function fixtureFor(label) {
	const fixture = createFixture(graph, label);
	fixture.discoveredAgents[0].name = "writable";
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, { agent: "writable" }));
	return fixture;
}

test("public single-child execution defaults an omitted agent to writable before validation", async () => {
	const fixture = fixtureFor("public-default");
	const executor = graph.createSubagentExecutor(fixture.deps);
	const result = await executor.executePublic("default-call", { task: "Implement this bounded change", async: false, acceptance: false }, signal(), undefined, fixture.ctx);
	assert.notEqual(result.isError, true, textOf(result));
	assert.equal(runSyncCalls.length, 1);
	assert.equal(runSyncCalls[0].agentName, "writable");
});

test("public defaulting does not attach an agent to management, workflow, or resume requests", () => {
	for (const params of [
		{ action: "list" },
		{ workflowScript: "return 1" },
		{ workflow: "named-workflow" },
	]) {
		const normalized = normalizePublicSubagentExecution(params);
		assert.equal(normalized.ok, true);
		assert.equal(normalized.params.agent, undefined);
	}
	for (const params of [
		{ workflowScript: "return 1", task: "conflicting" },
		{ workflow: "named-workflow", task: "conflicting" },
		{ resume: "run-1", task: "follow up" },
	]) assert.equal(normalizePublicSubagentExecution(params).ok, false);
});

test("public execution does not turn explicit invalid agent names into writable", async () => {
	const fixture = fixtureFor("public-invalid");
	const executor = graph.createSubagentExecutor(fixture.deps);
	for (const agent of ["", "  ", "reviwer"]) {
		const result = await executor.executePublic("invalid-call", { agent, task: "Inspect code", async: false }, signal(), undefined, fixture.ctx);
		assert.equal(result.isError, true);
		if (agent.trim()) assert.match(textOf(result), /writable/, "unknown agent errors list available names");
	}
	assert.equal(runSyncCalls.length, 0);
});

for (const explicitAgent of [false, true]) {
	test(`parallel ${explicitAgent ? "explicit" : "omitted"} writable agents split an inherited output before launch`, async () => {
		const fixture = fixtureFor(`outputs-${explicitAgent}`);
		const sharedOutput = path.join(fixture.dir, "shared.md");
		fixture.discoveredAgents[0].output = sharedOutput;
		const executor = graph.createSubagentExecutor(fixture.deps);
		const agent = explicitAgent ? 'agent: "writable",' : "";
		const result = await executor.executePublic("parallel-defaults", {
			workflowScript: `return runs.all([
				{key: "first", ${agent} task: "Inspect first module", async: false, acceptance: false},
				{key: "second", ${agent} task: "Inspect second module", async: false, acceptance: false}
			]);`,
			async: false,
			output: false,
		}, signal(), undefined, fixture.ctx);
		assert.notEqual(result.isError, true, textOf(result));
		assert.equal(runSyncCalls.length, 2);
		const outputs = runSyncCalls.map((call) => call.options.outputPath);
		assert.ok(outputs.every((output) => typeof output === "string"), JSON.stringify(outputs));
		assert.equal(new Set(outputs).size, 2, "each child must have its own claimed output");
		assert.ok(outputs.every((output) => output !== sharedOutput), "the colliding default must not be used");
	});
}

test("parallel omitted agents still reject explicit output conflicts before any launch", async () => {
	const fixture = fixtureFor("explicit-output-conflict");
	const shared = JSON.stringify(path.join(fixture.dir, "shared.md"));
	const result = await graph.createSubagentExecutor(fixture.deps).executePublic("conflict", {
		workflowScript: `return runs.all([
			{key: "first", task: "Inspect first module", output: ${shared}, async: false},
			{key: "second", task: "Inspect second module", output: ${shared}, async: false}
		]);`,
		async: false,
		output: false,
	}, signal(), undefined, fixture.ctx);
	// runs.all returns per-child failures rather than failing the enclosing JavaScript script.
	// Assert both public child outcomes and that no execution was admitted.
	const failures = result.details.workflow.trace.filter((entry) => entry.operation === "run" && entry.state === "failed");
	assert.deepEqual(failures.map((entry) => entry.key).sort(), ["first", "second"]);
	for (const failure of failures) assert.match(failure.error, /same path/);
	assert.equal(runSyncCalls.length, 0);
});
