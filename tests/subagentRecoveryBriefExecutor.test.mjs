/**
 * Behavioral tests for recovery-brief propagation through the real subagent
 * executor graph.
 *
 * Contract under test:
 *   - every foreground launch and every resume hands the runSync boundary a
 *     recovery-brief generator, so an abnormal child can produce a brief,
 *   - a failed receipt carries the brief plus authoritative references and
 *     only promises a resume when the child is actually resumable,
 *   - a successful receipt never prints a brief,
 *   - workflow children keep the brief instead of dropping it at the aggregate.
 *
 * Only the runSync boundary is a double; dispatch, remembered runs, resume
 * target resolution and receipt formatting are production code.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	completedResult,
	createFixture,
	loadSubagentResumeGraph,
	resetDoubles,
	runSyncCalls,
	seedCompletedForegroundRun,
	setRunSyncBehavior,
} from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

const BRIEF_BODY = "## Subagent Recovery Brief\n\nBRIEF_BODY: patched the merge guard, regression test still failing.";

const abortSignal = () => new AbortController().signal;

function textOf(result) {
	return (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

function failedResult(fixture, overrides = {}) {
	return {
		agent: "worker",
		task: "fix duplicated messages",
		exitCode: 1,
		error: "Provider transport aborted.",
		finalOutput: "partial output before the abort",
		sessionFile: fixture.childSessionFile,
		model: "anthropic/claude-sonnet-4",
		thinking: "high",
		recoveryBrief: {
			text: BRIEF_BODY,
			source: "model",
			model: "anthropic/claude-sonnet-4",
			thinking: "high",
		},
		progressSummary: { toolCount: 2, tokens: 10, durationMs: 5 },
		progress: {
			index: 0,
			agent: "worker",
			status: "failed",
			task: "fix duplicated messages",
			recentTools: [],
			recentOutput: [],
			toolCount: 2,
			tokens: 10,
			durationMs: 5,
		},
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		...overrides,
	};
}

test("a plain foreground launch receives a recovery-brief generator", async () => {
	const fixture = createFixture(graph, "brief-launch");
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	await executor.executePublic("call-brief-launch", { agent: "worker", task: "code" }, abortSignal(), undefined, fixture.ctx);

	assert.equal(runSyncCalls.length, 1);
	assert.equal(
		typeof runSyncCalls[0].options.recoveryBrief,
		"function",
		"the launch path must hand runSync a recovery-brief generator",
	);
});

test("a foreground resume receives a recovery-brief generator", async () => {
	const fixture = createFixture(graph, "brief-resume");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	await executor.executePublic("call-brief-resume", { action: "resume", id: RUN_A, message: "continue" }, abortSignal(), undefined, fixture.ctx);

	assert.equal(runSyncCalls.length, 1);
	assert.equal(
		typeof runSyncCalls[0].options.recoveryBrief,
		"function",
		"the resume path must hand runSync a recovery-brief generator",
	);
});

test("a failed receipt carries the brief, authoritative references and a resume instruction", async () => {
	const fixture = createFixture(graph, "brief-failed");
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => failedResult(fixture));
	const result = await executor.executePublic("call-brief-failed", { agent: "worker", task: "fix duplicated messages" }, abortSignal(), undefined, fixture.ctx);

	assert.equal(result.isError, true, "a failed child must stay an error receipt");
	const text = textOf(result);
	assert.ok(text.includes("Provider transport aborted."), "the original failure must stay visible");
	assert.ok(text.includes("BRIEF_BODY"), "the recovery brief must reach the parent");
	assert.ok(text.includes(result.details.runId), "the receipt must name the authoritative run id");
	assert.ok(text.includes(fixture.childSessionFile), "the receipt must name the child session file");
	assert.ok(text.includes('action: "resume"'), "a resumable child must be offered a resume instruction");
	assert.equal(result.details.results[0].recoveryBrief.text, BRIEF_BODY, "the structured result must carry the brief");
});

test("a failed receipt without a persisted child session refuses to promise a resume", async () => {
	const fixture = createFixture(graph, "brief-not-resumable");
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => failedResult(fixture, { sessionFile: undefined }));
	const result = await executor.executePublic("call-brief-nr", { agent: "worker", task: "fix duplicated messages" }, abortSignal(), undefined, fixture.ctx);

	const text = textOf(result);
	assert.ok(text.includes("BRIEF_BODY"), "the brief must still reach the parent");
	assert.equal(text.includes('action: "resume"'), false, "no resume instruction without a persisted child session");
	assert.match(text, /cannot be resumed/i);
});

test("a successful receipt never prints a recovery brief", async () => {
	const fixture = createFixture(graph, "brief-success");
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, {
		finalOutput: "ALL GOOD",
		recoveryBrief: { text: BRIEF_BODY, source: "model" },
	}));
	const result = await executor.executePublic("call-brief-ok", { agent: "worker", task: "code" }, abortSignal(), undefined, fixture.ctx);

	assert.notEqual(result.isError, true);
	const text = textOf(result);
	assert.ok(text.includes("ALL GOOD"));
	assert.equal(text.includes("BRIEF_BODY"), false, "a successful child must not print a recovery brief");
});

test("a failed resumed child receipt carries the brief and honest resume advice", async () => {
	const fixture = createFixture(graph, "brief-resume-failed");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => failedResult(fixture));
	const result = await executor.executePublic(
		"call-brief-resume-failed",
		{ action: "resume", id: RUN_A, message: "continue" },
		abortSignal(),
		undefined,
		fixture.ctx,
	);

	assert.equal(result.isError, true, "a failed resumed child must stay an error receipt");
	const text = textOf(result);
	assert.ok(text.includes("Provider transport aborted."), "the original failure must stay visible");
	assert.ok(text.includes("BRIEF_BODY"), "a resumed child's failure must deliver the brief to the parent");
	assert.ok(text.includes(result.details.runId), "the receipt must name the authoritative resumed run id");
	assert.ok(text.includes(fixture.childSessionFile), "the receipt must name the child session file");
	assert.ok(text.includes('action: "resume"'), "the resumed child is still resumable and must say so");
	assert.equal(result.details.results[0].recoveryBrief.text, BRIEF_BODY);
});

test("a workflow that catches a failed child still surfaces its brief once", async () => {
	const fixture = createFixture(graph, "brief-workflow-all");
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => failedResult(fixture));
	const result = await executor.executePublic(
		"call-brief-wf-all",
		{ workflowScript: 'const [child] = await runs.all([{ key: "child-brief", agent: "worker", task: "fix duplicated messages", async: false }]); return child.output;' },
		abortSignal(),
		undefined,
		fixture.ctx,
	);

	const text = textOf(result);
	assert.ok(text.includes("Workflow completed."), "runs.all resolves per-child failures instead of failing the script");
	assert.ok(text.includes("BRIEF_BODY"), "the aggregate must surface the brief even when the script returns only child.output");
	assert.equal(text.split(BRIEF_BODY).length - 1, 1, "the brief must not be duplicated in the aggregate text");
	assert.equal(text.includes(`- Output artifact: ${fixture.childSessionFile}`), false, "a child session is not an output artifact");
});

test("a workflow child keeps the brief in the aggregate result", async () => {
	const fixture = createFixture(graph, "brief-workflow");
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => failedResult(fixture));
	const result = await executor.executePublic(
		"call-brief-wf",
		{ workflowScript: 'return runs.run("child-brief", { agent: "worker", task: "fix duplicated messages" });' },
		abortSignal(),
		undefined,
		fixture.ctx,
	);

	const childRow = result.details.workflowChildren?.children?.find((entry) => entry.childId === "child-brief");
	assert.ok(childRow, "the workflow must report its child");
	assert.ok(
		result.details.results?.some((entry) => entry.recoveryBrief?.text === BRIEF_BODY),
		"the workflow child result must carry the recovery brief instead of dropping it",
	);
	const text = textOf(result);
	assert.ok(text.includes("BRIEF_BODY"), "the aggregate workflow output must surface the brief");
	assert.equal(text.split(BRIEF_BODY).length - 1, 1, "the brief must not be duplicated in the aggregate text");
});
