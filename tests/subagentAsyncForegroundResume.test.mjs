/**
 * Behavioral regression tests for subagent foreground resume semantics.
 *
 * Contract under test:
 *   - Interactive subagent tool calls run in the foreground when `async` is
 *     omitted or false; only explicit `async:true` launches background work.
 *   - action:'resume' continues the child in place (same session file, new run)
 *     through runSync and must forward the recovered agent config, budgets and
 *     the effective resume contract.
 *   - The session lease and foreground control stay owned until the run is
 *     truly finished; a detached receipt keeps them until the authoritative
 *     onDetachedExit callback.
 *
 * All calls go through the real `createSubagentExecutor(...).executePublic(...)`.
 * Only the runSync / async-execution boundaries are test doubles; session lease,
 * foreground control, remembered runs, recovery descriptors and dispatch are
 * production code.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
	asyncStartedResult,
	completedResult,
	createFixture,
	loadSubagentResumeGraph,
	recoveryDescriptorFor,
	resetDoubles,
	runSyncCalls,
	asyncCalls,
	seedAsyncRun,
	seedAwaitedAsyncRootResult,
	seedCompletedForegroundRun,
	setAsyncBehaviors,
	setRunSyncBehavior,
} from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const RUN_C = "33333333-3333-4333-8333-333333333333";
const RUN_D = "44444444-4444-4444-8444-444444444444";
const RUN_E = "55555555-5555-4555-8555-555555555555";
const RUN_F = "66666666-6666-4666-8666-666666666666";
const RUN_G = "77777777-7777-4777-8777-777777777777";
const RUN_H = "88888888-8888-4888-8888-888888888888";
const RUN_I = "99999999-9999-4999-8999-999999999999";
const RUN_J = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_K = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const abortSignal = () => new AbortController().signal;

function textOf(result) {
	return (result.content ?? []).map((entry) => entry.text ?? "").join("\n");
}

test("resolveAsyncByDefault defaults to foreground and async:true stays the only background opt-in", () => {
	assert.equal(graph.resolveAsyncByDefault({}), false);
	assert.equal(graph.resolveAsyncByDefault({ asyncByDefault: true }), true);
	assert.equal(graph.resolveAsyncByDefault({ asyncByDefault: false }), false);
});

test("applyForceTopLevelAsyncOverride never flips an omitted or explicit async:false", () => {
	const force = { clarify: true, async: true };
	// Explicit async:true keeps running async but must not stay in clarify mode.
	assert.deepEqual(graph.applyForceTopLevelAsyncOverride({ async: true, clarify: true }, 0, true), { async: true, clarify: false });
	// Explicit false and omission are foreground decisions and are never overridden.
	assert.deepEqual(graph.applyForceTopLevelAsyncOverride({ async: false, clarify: true }, 0, true), { async: false, clarify: true });
	assert.deepEqual(graph.applyForceTopLevelAsyncOverride({ clarify: true }, 0, true), { clarify: true });
	// Non-top-level or disabled force leaves params untouched.
	assert.deepEqual(graph.applyForceTopLevelAsyncOverride(force, 1, true), force);
	assert.deepEqual(graph.applyForceTopLevelAsyncOverride(force, 0, false), force);
});

test("action:'resume' with omitted or explicit async:false continues in the foreground via runSync", async () => {
	const fixture = createFixture(graph, "mode");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const omitted = await executor.executePublic("call-1", { action: "resume", id: RUN_A, message: "continue" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(omitted.isError, true, `resume must succeed: ${textOf(omitted)}`);
	assert.equal(runSyncCalls.length, 1, "omitted async must run in the foreground exactly once");
	assert.equal(asyncCalls.length, 0, "omitted async must not launch background work");
	assert.equal(runSyncCalls[0].options.sessionFile, fixture.childSessionFile, "foreground resume continues the stored child session in place");
	assert.equal(omitted.details.results[0].exitCode, 0);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const explicitFalse = await executor.executePublic("call-2", { action: "resume", id: RUN_A, message: "continue", async: false }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(explicitFalse.isError, true, `resume must succeed: ${textOf(explicitFalse)}`);
	assert.equal(runSyncCalls.length, 1, "async:false must run in the foreground exactly once");
	assert.equal(asyncCalls.length, 0, "async:false must not launch background work");

	// Explicit async:true keeps the historical detached background flow.
	resetDoubles();
	setAsyncBehaviors({ single: (runId) => asyncStartedResult(runId) });
	const explicitTrue = await executor.executePublic("call-3", { action: "resume", id: RUN_A, message: "continue", async: true }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(explicitTrue.isError, true, `async:true resume must start: ${textOf(explicitTrue)}`);
	assert.equal(runSyncCalls.length, 0, "async:true must not block on a foreground runSync");
	assert.equal(asyncCalls.length, 1, "async:true must keep the background resume flow");
	assert.equal(asyncCalls[0].kind, "single");
	assert.equal(asyncCalls[0].params.sessionFile, fixture.childSessionFile, "background resume also continues the stored child session");
});

test("foreground resume forwards the recovered agent config to runSync instead of the rediscovered one", async () => {
	const fixture = createFixture(graph, "recover");
	const descriptor = recoveryDescriptorFor(graph, fixture, RUN_B);
	seedAsyncRun(graph, fixture, { runId: RUN_B, recoveryDescriptor: descriptor });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const result = await executor.executePublic("call-1", { action: "resume", id: RUN_B, message: "follow up" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(result.isError, true, `resume must succeed: ${textOf(result)}`);
	assert.equal(runSyncCalls.length, 1);
	const sent = runSyncCalls[0].agents.find((agent) => agent.name === "worker");
	assert.ok(sent, "runSync must receive the target agent configuration");
	assert.ok(sent.systemPrompt.startsWith("RECOVERED PROMPT"), "the recovery descriptor's systemPrompt must win over rediscovered agents");
	assert.ok(sent.tools.includes("read"), "the recovery descriptor's tools must include 'read'");
	assert.equal(sent.tools.includes("write"), false, "the rediscovered agent's 'write' tool must be replaced by the recovery descriptor");
	assert.equal(runSyncCalls[0].agents[0], sent, "the recovered config must be the entry runSync resolves by name");

	// An undiscoverable agent with a recovery descriptor must still reach runSync.
	const orphan = createFixture(graph, "recover-orphan");
	orphan.discoveredAgents.length = 0;
	seedAsyncRun(graph, orphan, { runId: RUN_C, recoveryDescriptor: recoveryDescriptorFor(graph, orphan, RUN_C) });
	const orphanExecutor = graph.createSubagentExecutor(orphan.deps);
	resetDoubles();
	setRunSyncBehavior(() => completedResult(orphan));
	const orphanResult = await orphanExecutor.executePublic("call-2", { action: "resume", id: RUN_C, message: "follow up" }, abortSignal(), undefined, orphan.ctx);
	assert.notEqual(orphanResult.isError, true, `undiscovered agent with recovery descriptor must resume: ${textOf(orphanResult)}`);
	assert.equal(runSyncCalls.length, 1);
	assert.equal(runSyncCalls[0].agents[0]?.name, "worker");
	assert.ok(runSyncCalls[0].agents[0]?.systemPrompt.startsWith("RECOVERED PROMPT"));
});

test("lease and foreground control are fully cleaned up on completion, runSync failure and setup failure", async () => {
	const fixture = createFixture(graph, "lease");
	seedCompletedForegroundRun(fixture, { runId: RUN_D });
	const executor = graph.createSubagentExecutor(fixture.deps);

	// 1. Normal completion releases the lease and removes the controller.
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const done = await executor.executePublic("call-1", { action: "resume", id: RUN_D, message: "continue" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(done.isError, true, textOf(done));
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "completed resume must release the session lease");
	assert.equal(fixture.state.foregroundControls.size, 0, "completed resume must remove its foreground control");
	assert.equal(fixture.state.foregroundRuns.get(done.details.runId)?.children[0]?.status, "completed");

	// 2. A runSync failure still releases the lease and the controller.
	resetDoubles();
	setRunSyncBehavior(() => {
		throw new Error("runSync exploded");
	});
	await assert.rejects(() => executor.executePublic("call-2", { action: "resume", id: RUN_D, message: "continue" }, abortSignal(), undefined, fixture.ctx), /runSync exploded/);
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "failed resume must release the session lease");
	assert.equal(fixture.state.foregroundControls.size, 0, "failed resume must not leave a controller behind");

	// 3. Setup failures after lease acquisition (here: an invalid outputSchema) must
	//    also release the lease and never register a controller.
	resetDoubles();
	await assert.rejects(
		() => executor.executePublic("call-3", { action: "resume", id: RUN_D, message: "continue", outputSchema: 42 }, abortSignal(), undefined, fixture.ctx),
		/outputSchema/i,
	);
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "setup failure must release the session lease");
	assert.equal(fixture.state.foregroundControls.size, 0, "setup failure must not register a controller");
	assert.equal(runSyncCalls.length, 0, "setup failure must not reach runSync");

	// 4. An interrupted continuation is remembered as paused and stays resumable.
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, { exitCode: 130, interrupted: true, finalOutput: undefined }));
	const interrupted = await executor.executePublic("call-4", { action: "resume", id: RUN_D, message: "continue" }, abortSignal(), undefined, fixture.ctx);
	assert.equal(fixture.state.foregroundRuns.get(interrupted.details.runId)?.children[0]?.status, "paused");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free");
	setRunSyncBehavior(() => completedResult(fixture));
	const again = await executor.executePublic("call-5", { action: "resume", id: interrupted.details.runId, message: "continue" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(again.isError, true, `paused run must stay resumable: ${textOf(again)}`);
	assert.equal(runSyncCalls.length, 2);
});

test("a detached receipt keeps the session lease until the authoritative onDetachedExit", async () => {
	const fixture = createFixture(graph, "detach");
	seedCompletedForegroundRun(fixture, { runId: RUN_E });
	const executor = graph.createSubagentExecutor(fixture.deps);

	let detachedOptions;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		detachedOptions = options;
		return completedResult(fixture, { detached: true, detachedReason: "user request", exitCode: undefined, finalOutput: undefined });
	});
	const receipt = await executor.executePublic("call-1", { action: "resume", id: RUN_E, message: "detach please" }, abortSignal(), undefined, fixture.ctx);
	assert.equal(receipt.details.results[0]?.detached, true, "the detach receipt must be returned to the caller");
	assert.equal(typeof detachedOptions?.onDetachedExit, "function", "runSync must receive the authoritative completion callback");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "owned", "a detach receipt is not completion: the lease must stay held");

	// While the detached child may still be live, a second hop must be rejected.
	const blocked = await executor.executePublic("call-2", { action: "resume", id: RUN_E, message: "again" }, abortSignal(), undefined, fixture.ctx);
	assert.equal(blocked.isError, true, "resuming again while the lease is still owned must be rejected");
	assert.equal(runSyncCalls.length, 1, "the rejected second hop must not reach runSync");

	// The authoritative terminal callback owns the cleanup and final bookkeeping.
	const terminal = completedResult(fixture, { detached: undefined, detachedReason: "user request", finalOutput: "final output" });
	await detachedOptions.onDetachedExit(terminal);
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "the terminal callback must release the session lease");
	assert.equal(fixture.state.foregroundRuns.get(receipt.details.runId)?.children[0]?.status, "completed", "detached runs become resumable only after the terminal callback");
	assert.equal(fixture.state.foregroundControls.size, 0);

	setRunSyncBehavior(() => completedResult(fixture));
	const third = await executor.executePublic("call-3", { action: "resume", id: RUN_E, message: "again" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(third.isError, true, `resume must work again after the terminal callback: ${textOf(third)}`);
	assert.equal(runSyncCalls.length, 2);
});

test("sequential resumes keep the effective contract across continuations", async () => {
	const fixture = createFixture(graph, "contract");
	const outputSchema = { type: "object", properties: { summary: { type: "string" } } };
	const agentContract = { version: 1 };
	const acceptance = { level: "verified" };
	seedCompletedForegroundRun(fixture, {
		runId: RUN_F,
		resumeContract: { outputSchema, agentContract, acceptance, outputMode: "inline" },
	});
	const executor = graph.createSubagentExecutor(fixture.deps);

	// Hold the first continuation in flight so a concurrent second hop can be observed.
	let releaseFirst;
	resetDoubles();
	setRunSyncBehavior(() => new Promise((resolve) => {
		releaseFirst = () => resolve(completedResult(fixture));
	}));
	const pending = executor.executePublic("call-1", { action: "resume", id: RUN_F, message: "first" }, abortSignal(), undefined, fixture.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runSyncCalls.length, 1);

	// A second hop into the same child session while it is being continued must fail.
	const concurrent = await executor.executePublic("call-2", { action: "resume", id: RUN_F, message: "second" }, abortSignal(), undefined, fixture.ctx);
	assert.equal(concurrent.isError, true, "resuming a child session that is already being continued must be rejected");
	assert.equal(runSyncCalls.length, 1, "the rejected concurrent hop must not reach runSync");

	releaseFirst();
	const first = await pending;
	assert.notEqual(first.isError, true, textOf(first));
	assert.deepEqual(runSyncCalls[0].options.structuredOutput?.schema, outputSchema);
	assert.deepEqual(runSyncCalls[0].options.agentContract, agentContract);
	assert.deepEqual(runSyncCalls[0].options.acceptance, acceptance);

	// The second continuation supplies only a message; the recorded contract must hold.
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const secondRunId = first.details.runId;
	const second = await executor.executePublic("call-3", { action: "resume", id: secondRunId, message: "second" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(second.isError, true, textOf(second));
	assert.equal(runSyncCalls.length, 1);
	assert.deepEqual(runSyncCalls[0].options.structuredOutput?.schema, outputSchema, "outputSchema must survive into the next continuation");
	assert.deepEqual(runSyncCalls[0].options.agentContract, agentContract, "agentContract must survive into the next continuation");
	assert.deepEqual(runSyncCalls[0].options.acceptance, acceptance, "acceptance must survive into the next continuation");
});

test("budgets and tool timeouts are forwarded to the resumed run and validated before launch", async () => {
	const fixture = createFixture(graph, "budget");
	seedCompletedForegroundRun(fixture, { runId: RUN_G });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const ok = await executor.executePublic("call-1", {
		action: "resume",
		id: RUN_G,
		message: "budgeted",
		toolBudget: { hard: 3, soft: 1 },
		toolTimeoutMs: 777,
		usageBudget: { costUsd: { hard: 5 } },
	}, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(ok.isError, true, textOf(ok));
	assert.equal(runSyncCalls.length, 1);
	assert.equal(runSyncCalls[0].options.toolBudget?.hard, 3, "requested toolBudget.hard must reach runSync");
	assert.equal(runSyncCalls[0].options.toolBudget?.soft, 1, "requested toolBudget.soft must reach runSync");
	assert.ok(Array.isArray(runSyncCalls[0].options.toolBudget?.block), "the resolved budget keeps its block list");
	assert.equal(runSyncCalls[0].options.toolTimeoutMs, 777, "requested toolTimeoutMs must reach runSync");
	assert.equal(runSyncCalls[0].options.configToolTimeoutMs, 9000, "the raw global tool timeout must reach runSync");
	assert.equal(runSyncCalls[0].options.usageBudget?.costUsd?.hard, 5, "requested usageBudget must reach runSync");

	// Without a request budget, the recovery descriptor's initialToolBudget applies.
	const recoveryFixture = createFixture(graph, "budget-recovery");
	const descriptor = recoveryDescriptorFor(graph, recoveryFixture, RUN_I, { initialToolBudget: { hard: 7 } });
	seedAsyncRun(graph, recoveryFixture, { runId: RUN_I, recoveryDescriptor: descriptor });
	const recoveryExecutor = graph.createSubagentExecutor(recoveryFixture.deps);
	resetDoubles();
	setRunSyncBehavior(() => completedResult(recoveryFixture));
	const recovered = await recoveryExecutor.executePublic("call-2", { action: "resume", id: RUN_I, message: "budgeted" }, abortSignal(), undefined, recoveryFixture.ctx);
	assert.notEqual(recovered.isError, true, textOf(recovered));
	assert.equal(runSyncCalls[0].options.toolBudget?.hard, 7, "the recovery descriptor's initialToolBudget must apply without a request budget");

	// Invalid budgets are rejected before any launch and leave no lease behind.
	resetDoubles();
	const badBudget = await executor.executePublic("call-3", { action: "resume", id: RUN_G, message: "budgeted", toolBudget: { hard: -1 } }, abortSignal(), undefined, fixture.ctx);
	assert.equal(badBudget.isError, true, "an invalid toolBudget must be rejected");
	assert.equal(runSyncCalls.length, 0, "an invalid toolBudget must not launch runSync");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free");

	resetDoubles();
	const badUsage = await executor.executePublic("call-4", { action: "resume", id: RUN_G, message: "budgeted", usageBudget: { nope: 1 } }, abortSignal(), undefined, fixture.ctx);
	assert.equal(badUsage.isError, true, "an invalid usageBudget must be rejected");
	assert.equal(runSyncCalls.length, 0, "an invalid usageBudget must not launch runSync");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free");
});

test("prepareWorkflowLaunchParams strips workflow-level async default and preserves explicit child async", () => {
	// 1. Workflow 顶层的 async: true 默认值不能渗透给 child；child 缺省 async 时保持 undefined（即遵循前台默认）
	const omittedChild = graph.prepareWorkflowLaunchParams(
		{ async: true, agent: "reviewer" },
		{ agent: "worker", task: "code" },
		"wf-parent-1",
		"step-1",
	);
	assert.equal(omittedChild.async, undefined, "workflow-level async:true default must not leak to a child that omitted async");
	assert.equal(omittedChild.workflowParentRunId, "wf-parent-1");
	assert.equal(omittedChild.workflowKey, "step-1");

	// 2. Child 显式传入 async: false 保持不变
	const explicitFalse = graph.prepareWorkflowLaunchParams(
		{ async: true },
		{ agent: "worker", task: "code", async: false },
		"wf-parent-2",
		"step-2",
	);
	assert.equal(explicitFalse.async, false, "child explicit async:false must be preserved");

	// 3. Child 显式传入 async: true 保持不变
	const explicitTrue = graph.prepareWorkflowLaunchParams(
		{ async: false },
		{ agent: "worker", task: "code", async: true },
		"wf-parent-3",
		"step-3",
	);
	assert.equal(explicitTrue.async, true, "child explicit async:true must be preserved");

	// 4. Workflow resume child must inherit workflowAwaitDetached when awaitDetachedChild is set
	const awaitedResume = graph.prepareWorkflowLaunchParams(
		{ async: false },
		{ resume: RUN_A, task: "cont" },
		"wf-parent-4",
		"step-4",
		{ awaitDetachedChild: true },
	);
	assert.equal(awaitedResume.workflowAwaitDetached, true, "workflow resume child must receive workflowAwaitDetached: true");

	// 5. Workflow resume child validates timeout aliases from the active scope:
	// a. Equal aliases in childParams are accepted
	const equalAliases = graph.prepareWorkflowLaunchParams(
		{},
		{ resume: RUN_A, task: "cont", timeoutMs: 1500, maxRuntimeMs: 1500 },
		"wf-parent-5",
		"step-5",
	);
	assert.equal(equalAliases.timeoutMs, 1500);

	// b. Child maxRuntimeMs alone overrides workflow defaults
	const childOverridesDefault = graph.prepareWorkflowLaunchParams(
		{ timeoutMs: 9999 },
		{ resume: RUN_A, task: "cont", maxRuntimeMs: 2500 },
		"wf-parent-6",
		"step-6",
	);
	assert.equal(childOverridesDefault.timeoutMs, 2500);

	// c. Defaults conflicting aliases are rejected when child gives none
	assert.throws(
		() => graph.prepareWorkflowLaunchParams(
			{ timeoutMs: 1000, maxRuntimeMs: 2000 },
			{ resume: RUN_A, task: "cont" },
			"wf-parent-7",
			"step-7",
		),
		/aliases|timeoutMs and maxRuntimeMs/i,
	);
});

test("external-job follow-up requires explicit async:true and otherwise fails closed", async () => {
	const unregister = graph.registerExternalJobProvider({
		name: "fake-job",
		start: () => ({ providerJobId: "job-0", state: "queued" }),
		status: () => ({ providerJobId: "job-0", state: "completed" }),
		result: () => ({ providerJobId: "job-0", state: "completed" }),
		reattach: () => ({ providerJobId: "job-0", state: "completed" }),
		followUp: () => ({ providerJobId: "job-2", state: "queued" }),
	});
	try {
		const fixture = createFixture(graph, "external-job");
		const runner = { type: "external-job", provider: "fake-job", options: { queue: "test" } };
		const externalJob = { provider: "fake-job", options: { queue: "test" }, providerJobId: "job-1", state: "completed" };
		seedAsyncRun(graph, fixture, { runId: RUN_H, runner, externalJob });
		const executor = graph.createSubagentExecutor(fixture.deps);

		resetDoubles();
		const omitted = await executor.executePublic("call-1", { action: "resume", id: RUN_H, message: "follow up" }, abortSignal(), undefined, fixture.ctx);
		assert.equal(omitted.isError, true, "external-job follow-up without async must be rejected");
		assert.match(textOf(omitted), /async:true/, "the rejection must state the explicit async:true requirement");
		assert.equal(asyncCalls.length, 0, "a rejected external-job follow-up must not start a background run");

		const explicitFalse = await executor.executePublic("call-2", { action: "resume", id: RUN_H, message: "follow up", async: false }, abortSignal(), undefined, fixture.ctx);
		assert.equal(explicitFalse.isError, true, "external-job follow-up with async:false must be rejected");
		assert.equal(asyncCalls.length, 0, "async:false must not start an external-job background run");

		resetDoubles();
		setAsyncBehaviors({ single: (runId) => asyncStartedResult(runId) });
		const started = await executor.executePublic("call-3", { action: "resume", id: RUN_H, message: "follow up", async: true }, abortSignal(), undefined, fixture.ctx);
		assert.notEqual(started.isError, true, `external-job follow-up with async:true must start: ${textOf(started)}`);
		assert.equal(asyncCalls.length, 1, "async:true keeps the external-job background follow-up flow");
		assert.equal(asyncCalls[0].kind, "single");
		assert.equal(started.details.asyncId, asyncCalls[0].runId);
	} finally {
		unregister();
	}
});

test("foreground resume resolves agent-specific modelScope before passing to runSync", async () => {
	const fixture = createFixture(graph, "model-scope");
	fixture.deps.config.modelScope = {
		enforce: true,
		allow: ["provider/allowed-global"],
		agents: {
			worker: {
				enforce: true,
				allow: ["provider/allowed-worker-only"],
			},
		},
	};
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const result = await executor.executePublic("call-1", { action: "resume", id: RUN_A, message: "follow up" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(result.isError, true, `resume must succeed: ${textOf(result)}`);
	assert.equal(runSyncCalls.length, 1);
	const sentModelScope = runSyncCalls[0].options.modelScope;
	// resolveModelScopesForAgent returns an array of ResolvedModelScope, whereas raw config is an object
	assert.ok(Array.isArray(sentModelScope), "runSync must receive resolved model scopes array, not raw config object");
	const workerScope = sentModelScope.find((s) => s.origin === "modelScope.agents.worker" || s.allow?.includes("provider/allowed-worker-only"));
	assert.ok(workerScope, "agent-specific model scope must be resolved for worker");
});

test("workflow resume inherits workflow usageBudget unless overridden by child", async () => {
	const fixture = createFixture(graph, "wf-budget");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	// 1. Workflow with usageBudget resumes a child without explicit budget
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const wfScript = `return runs.run("child-1", { resume: "${RUN_A}", task: "continue in workflow" });`;
	const wfResult = await executor.executePublic(
		"wf-call-1",
		{
			workflowScript: wfScript,
			async: false,
			usageBudget: { costUsd: { hard: 42 } },
		},
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.notEqual(wfResult.isError, true, `workflow must succeed: ${textOf(wfResult)}`);
	assert.equal(runSyncCalls.length, 1);
	assert.equal(runSyncCalls[0].options.usageBudget?.costUsd?.hard, 42, "workflow-owned usage budget must reach resumed child");
});

test("workflow resume awaits detached continuation until authoritative onDetachedExit settles", async () => {
	const fixture = createFixture(graph, "wf-detach");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	let detachedOptions;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		detachedOptions = options;
		return completedResult(fixture, { detached: true, detachedReason: "user request", exitCode: undefined, finalOutput: undefined });
	});

	let wfSettled = false;
	const wfScript = `return runs.run("child-1", { resume: "${RUN_A}", task: "continue in workflow" });`;
	const wfPromise = executor.executePublic(
		"wf-call-detach",
		{
			workflowScript: wfScript,
			async: false,
		},
		abortSignal(),
		undefined,
		fixture.ctx,
	).then((res) => {
		wfSettled = true;
		return res;
	});

	// Yield event loop to let workflow start and runSync return the detach receipt
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(wfSettled, false, "workflow must NOT settle on provisional detach receipt");
	assert.equal(typeof detachedOptions?.onDetachedExit, "function");

	// Now trigger authoritative terminal exit
	const terminal = completedResult(fixture, { detached: undefined, detachedReason: "user request", exitCode: 0, finalOutput: "REAL WORKFLOW TERMINAL OUTPUT" });
	await detachedOptions.onDetachedExit(terminal);

	const wfResult = await wfPromise;
	assert.equal(wfSettled, true, "workflow must settle once onDetachedExit settles");
	assert.notEqual(wfResult.isError, true, `workflow must succeed: ${textOf(wfResult)}`);
	assert.match(textOf(wfResult), /REAL WORKFLOW TERMINAL OUTPUT/, "workflow must receive authoritative terminal output");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "lease must be released after completion");
});

test("foreground resume forwards onUpdate progress and emits real control notifications via SUBAGENT_CONTROL_EVENT", async () => {
	const fixture = createFixture(graph, "progress-control");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	const emittedEvents = [];
	fixture.deps.pi.events = {
		emit: (channel, payload) => {
			emittedEvents.push({ channel, payload });
		},
	};

	let capturedOptions;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		capturedOptions = options;
		// 1. Simulate a tool update event during runSync
		options.onUpdate?.({
			content: [{ type: "text", text: "step progress" }],
			details: {
				mode: "single",
				results: [],
				progress: [
					{
						index: 0,
						agent: "worker",
						status: "running",
						task: "continue",
						toolCount: 1,
						tokens: 50,
						durationMs: 100,
						currentTool: "read",
					},
				],
			},
		});

		// 2. Simulate a full, valid control event while the child is actively running
		const liveRunId = fixture.state.lastForegroundControlId;
		assert.ok(liveRunId, "foreground control must be registered for the active resume child");
		assert.equal(typeof options.onControlEvent, "function", "runSync must receive onControlEvent notifier");

		options.onControlEvent({
			type: "needs_attention",
			from: "running",
			to: "needs_attention",
			agent: "worker",
			index: 0,
			runId: liveRunId,
			message: "worker requires supervisor intervention",
			reason: "tool_failures",
			ts: Date.now(),
			toolCount: 5,
		});

		return completedResult(fixture);
	});

	const updates = [];
	const onUpdate = (u) => updates.push(u);

	const res = await executor.executePublic(
		"call-update-1",
		{
			action: "resume",
			id: RUN_A,
			message: "cont",
			control: {
				enabled: true,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event"],
			},
		},
		abortSignal(),
		onUpdate,
		fixture.ctx,
	);
	assert.notEqual(res.isError, true, textOf(res));
	assert.equal(runSyncCalls.length, 1);
	assert.equal(updates.length, 1, "caller onUpdate callback must receive forwarded progress updates");

	// A real control event must emit via the SUBAGENT_CONTROL_EVENT channel during the live run
	const matchingControlEvents = emittedEvents.filter(
		(e) => e.channel === graph.SUBAGENT_CONTROL_EVENT,
	);
	assert.equal(matchingControlEvents.length, 1, "exactly one SUBAGENT_CONTROL_EVENT must be emitted");
	assert.equal(matchingControlEvents[0].payload.source, "foreground", "payload source must be 'foreground'");
	assert.equal(matchingControlEvents[0].payload.event?.type, "needs_attention");
	assert.equal(matchingControlEvents[0].payload.event?.message, "worker requires supervisor intervention");
	assert.equal(matchingControlEvents[0].payload.event?.toolCount, 5);
	assert.equal(matchingControlEvents[0].payload.event?.runId, res.details.runId);
});

test("foreground resume honours the maxRuntimeMs alias and rejects conflicting timeouts", async () => {
	const fixture = createFixture(graph, "timeout-alias");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	// 1. maxRuntimeMs alone must reach runSync as the run timeout.
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const aliased = await executor.executePublic("call-1", { action: "resume", id: RUN_A, message: "continue", maxRuntimeMs: 1000 }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(aliased.isError, true, textOf(aliased));
	assert.equal(runSyncCalls.length, 1);
	assert.equal(runSyncCalls[0].options.timeoutMs, 1000, "maxRuntimeMs must be forwarded as the run timeout");

	// 2. Conflicting aliases must fail before any launch.
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const conflicting = await executor.executePublic("call-2", { action: "resume", id: RUN_A, message: "continue", timeoutMs: 1000, maxRuntimeMs: 2000 }, abortSignal(), undefined, fixture.ctx);
	assert.equal(conflicting.isError, true, "conflicting timeout aliases must be rejected");
	assert.equal(runSyncCalls.length, 0, "a rejected timeout must not launch runSync");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "the lease must be released after a rejected timeout");
});

test("workflow resume rejects conflicting timeout aliases before launching child run", async () => {
	const fixture = createFixture(graph, "wf-timeout-conflict");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));

	// 1. Conflicting timeout aliases in childParams must be rejected before launching runSync
	const wfScriptConflict = `return runs.run("child-conflict", { resume: "${RUN_A}", task: "continue in wf", timeoutMs: 1000, maxRuntimeMs: 2000 });`;
	const resConflict = await executor.executePublic(
		"call-wf-timeout-conflict",
		{ workflowScript: wfScriptConflict, async: false },
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.equal(resConflict.isError, true, "workflow resume with conflicting timeout aliases must fail");
	assert.match(textOf(resConflict), /aliases|timeoutMs and maxRuntimeMs/i, "error message must indicate alias conflict");
	assert.equal(runSyncCalls.length, 0, "runSync must not be launched when timeout aliases conflict");

	// 2. Consistent equal timeout aliases in childParams must be accepted
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const wfScriptEqual = `return runs.run("child-equal", { resume: "${RUN_A}", task: "continue in wf", timeoutMs: 1500, maxRuntimeMs: 1500 });`;
	const resEqual = await executor.executePublic(
		"call-wf-timeout-equal",
		{ workflowScript: wfScriptEqual, async: false },
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.notEqual(resEqual.isError, true, textOf(resEqual));
	assert.equal(runSyncCalls.length, 1);
	assert.equal(runSyncCalls[0].options.timeoutMs, 1500, "equal timeout aliases must be accepted");

	// 3. Child single alias must override workflow defaults without being treated as a conflict
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const wfScriptOverride = `return runs.run("child-override", { resume: "${RUN_A}", task: "continue in wf", maxRuntimeMs: 3000 });`;
	const resOverride = await executor.executePublic(
		"call-wf-timeout-override",
		{ workflowScript: wfScriptOverride, async: false, timeoutMs: 9999 },
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.notEqual(resOverride.isError, true, textOf(resOverride));
	assert.equal(runSyncCalls.length, 1);
	assert.equal(runSyncCalls[0].options.timeoutMs, 3000, "child maxRuntimeMs must override workflow default timeoutMs");
});

test("foreground resume cleans up the structured-output temp directory when artifacts are disabled", async () => {
	const fixture = createFixture(graph, "structured-output-cleanup");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	let tempDir;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		const runtime = options.structuredOutput;
		assert.ok(runtime?.schemaPath, "resume must build a structured-output runtime for outputSchema");
		tempDir = path.dirname(runtime.schemaPath);
		assert.ok(fs.existsSync(tempDir), "structured-output temp dir must exist while the run is live");
		return completedResult(fixture);
	});

	const res = await executor.executePublic(
		"call-cleanup",
		{ action: "resume", id: RUN_A, message: "continue", outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, artifacts: false },
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.notEqual(res.isError, true, textOf(res));
	assert.ok(tempDir, "the runSync double must have observed the structured runtime");
	assert.equal(fs.existsSync(tempDir), false, "structured-output temp dir must be removed once the run finishes with artifacts disabled");
});

test("structured-output temp directory is preserved across provisional detach receipt and cleaned up on authoritative exit", async () => {
	const fixture = createFixture(graph, "structured-output-detach");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	let tempDir;
	let capturedOptions;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		capturedOptions = options;
		const runtime = options.structuredOutput;
		assert.ok(runtime?.schemaPath, "resume must configure structured output runtime");
		tempDir = path.dirname(runtime.schemaPath);
		assert.ok(fs.existsSync(tempDir), "structured-output temp dir must exist during execution");
		return completedResult(fixture, {
			detached: true,
			detachedReason: "user request",
			exitCode: undefined,
			finalOutput: undefined,
		});
	});

	// 1. Direct foreground resume returns the provisional detach receipt
	const res = await executor.executePublic(
		"call-detach-structured",
		{
			action: "resume",
			id: RUN_A,
			message: "continue with detach",
			outputSchema: { type: "object", properties: { status: { type: "string" } } },
			artifacts: false,
		},
		abortSignal(),
		undefined,
		fixture.ctx,
	);

	assert.notEqual(res.isError, true, textOf(res));
	assert.ok(tempDir, "tempDir must have been captured");
	// Crucial assertion: on receipt arrival, the run is still alive detached, so the temp dir
	// must NOT be cleaned up yet, and the lease must remain held.
	assert.equal(fs.existsSync(tempDir), true, "temp dir must NOT be cleaned up when receiving provisional detach receipt");
	assert.notEqual(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "lease must remain held while detached");
	assert.equal(typeof capturedOptions?.onDetachedExit, "function", "onDetachedExit callback must be supplied");

	// 2. Authoritative exit fires: now the temp dir must be deleted and lease released
	await capturedOptions.onDetachedExit(completedResult(fixture, { exitCode: 0, finalOutput: "DETACH FINISHED" }));
	assert.equal(fs.existsSync(tempDir), false, "temp dir must be cleaned up once onDetachedExit completes");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "lease must be released once onDetachedExit completes");
});

test("structured-output temp directory and session lease are cleaned up when runSync throws an exception", async () => {
	const fixture = createFixture(graph, "structured-output-crash");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	let tempDir;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		const runtime = options.structuredOutput;
		assert.ok(runtime?.schemaPath, "resume must configure structured output runtime");
		tempDir = path.dirname(runtime.schemaPath);
		assert.ok(fs.existsSync(tempDir), "structured-output temp dir must exist before runSync throws");
		throw new Error("simulated crash in runSync");
	});

	await assert.rejects(
		() => executor.executePublic(
			"call-crash-structured",
			{
				action: "resume",
				id: RUN_A,
				message: "continue",
				outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
				artifacts: false,
			},
			abortSignal(),
			undefined,
			fixture.ctx,
		),
		/simulated crash in runSync/,
	);

	assert.ok(tempDir, "tempDir must have been captured");
	assert.equal(fs.existsSync(tempDir), false, "temp dir must be cleaned up on runSync exception");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "lease must be released on runSync exception");
});

test("asyncByDefault:true still runs a plain new task in the foreground when async is omitted", async () => {
	const fixture = createFixture(graph, "async-by-default");
	// Global config opts into background-by-default; a plain new launch that omits
	// `async` must follow the resolved default and still use the foreground path.
	fixture.deps.asyncByDefault = true;
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, { finalOutput: "FOREGROUND UNDER ASYNC DEFAULT" }));
	const res = await executor.executePublic(
		"call-async-default",
		{ agent: "worker", task: "plain new task" },
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.notEqual(res.isError, true, textOf(res));
	assert.match(textOf(res), /FOREGROUND UNDER ASYNC DEFAULT/, "an omitted async must follow asyncByDefault and run in the foreground");
	assert.equal(runSyncCalls.length, 1, "asyncByDefault:true must not divert a plain launch to the async runner");
	assert.equal(asyncCalls.length, 0, "no async execution must be started for a foreground launch");
	assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "the foreground lease must be released after completion");
});

test("mission workflow child with omitted or false async never writes ghost async binding directory even under asyncByDefault:true", async () => {
	const fixture = createFixture(graph, "mission-wf-ghost-async");
	fixture.deps.asyncByDefault = true;
	const executor = graph.createSubagentExecutor(fixture.deps);

	const initialAsyncEntries = new Set(fs.existsSync(graph.DIRS.async) ? fs.readdirSync(graph.DIRS.async) : []);
	// A ghost async dir has mission.json written by bindMissionWorkflowChildAsyncLaunch
	// but no status.json because it never actually ran as an async execution.
	const listGhostAsyncDirs = (known) => {
		const current = fs.existsSync(graph.DIRS.async) ? fs.readdirSync(graph.DIRS.async) : [];
		return current.filter((entry) => {
			if (known.has(entry)) return false;
			const entryPath = path.join(graph.DIRS.async, entry);
			if (!fs.statSync(entryPath).isDirectory()) return false;
			return fs.existsSync(path.join(entryPath, "mission.json")) && !fs.existsSync(path.join(entryPath, "status.json"));
		});
	};

	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, { finalOutput: "CHILD COMPLETED" }));

	const wfScript = `return runs.run("child-1", { agent: "worker", task: "mission task in foreground" });`;
	const wfResult = await executor.executePublic(
		"call-wf-mission",
		{
			workflowScript: wfScript,
			async: false,
			mission: { title: "Test Mission Title" },
		},
		abortSignal(),
		undefined,
		fixture.ctx,
	);

	assert.notEqual(wfResult.isError, true, `workflow should succeed: ${textOf(wfResult)}`);
	assert.equal(runSyncCalls.length, 1, "the workflow child must run in foreground via runSync");
	assert.equal(asyncCalls.length, 0, "the workflow child must not launch an async run");

	const createdGhostAsyncDirs = listGhostAsyncDirs(initialAsyncEntries);

	assert.deepEqual(
		createdGhostAsyncDirs,
		[],
		`must not pre-write ghost async mission directory for foreground workflow child: ${createdGhostAsyncDirs.join(", ")}`,
	);

	// Explicit async:false must also never write a ghost async binding directory
	const beforeExplicitFalse = new Set(fs.existsSync(graph.DIRS.async) ? fs.readdirSync(graph.DIRS.async) : []);
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture, { finalOutput: "CHILD EXPLICIT FOREGROUND" }));
	const explicitFalseResult = await executor.executePublic(
		"call-wf-mission-explicit-false",
		{
			workflowScript: `return runs.run("child-false", { agent: "worker", task: "explicit false", async: false });`,
			async: false,
			mission: { title: "Explicit False Mission" },
		},
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.notEqual(explicitFalseResult.isError, true, textOf(explicitFalseResult));
	assert.equal(runSyncCalls.length, 1);
	assert.equal(asyncCalls.length, 0);
	const explicitFalseGhostDirs = listGhostAsyncDirs(beforeExplicitFalse);
	assert.deepEqual(
		explicitFalseGhostDirs,
		[],
		`explicit async:false child must not pre-write a ghost async mission directory: ${explicitFalseGhostDirs.join(", ")}`,
	);

	// Explicit async:true DOES attach workflowChildAsyncId and writes mission binding
	resetDoubles();
	setAsyncBehaviors({
		single: (runId) => asyncStartedResult(runId),
	});
	const explicitAsyncResult = await executor.executePublic(
		"call-wf-mission-explicit-true",
		{
			workflowScript: `return runs.run("child-true", { agent: "worker", task: "explicit true", async: true });`,
			async: false,
			mission: { title: "Explicit True Mission" },
		},
		abortSignal(),
		undefined,
		fixture.ctx,
	);
	assert.notEqual(explicitAsyncResult.isError, true, textOf(explicitAsyncResult));
	assert.equal(asyncCalls.length, 1, "explicit async:true child must trigger async single execution");
	assert.ok(asyncCalls[0].runId, "explicit async:true child must have an async run id");
	assert.ok(
		fs.existsSync(path.join(graph.DIRS.async, asyncCalls[0].runId, "mission.json")),
		"explicit async:true child must write mission.json in its async directory",
	);
});

test("async workflow resume keeps the preassigned mission binding directory aligned with the real async run", async () => {
	const fixture = createFixture(graph, "mission-wf-async-resume");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	resetDoubles();
	const beforeEntries = new Set(fs.existsSync(graph.DIRS.async) ? fs.readdirSync(graph.DIRS.async) : []);
	// The workflow rewrites the binding after the child returns (subagent-executor
	// `writeMissionAsyncBinding(result.details.asyncDir, ...)`), so a post-return
	// assertion alone cannot prove the prelaunch binding was visible to observers
	// during the run. Capture what a completion-time observer sees at launch time.
	let bindingAtLaunch;
	setAsyncBehaviors({
		single: (runId) => {
			const realAsyncDir = path.join(graph.DIRS.async, runId);
			bindingAtLaunch = graph.readMissionBinding(realAsyncDir);
			seedAwaitedAsyncRootResult(realAsyncDir, "ASYNC ROOT COMPLETED");
			return asyncStartedResult(runId, realAsyncDir);
		},
	});

	const wfScript = `return runs.run("child-async-resume", { resume: "${RUN_A}", task: "continue asynchronously", async: true });`;
	const wfResult = await executor.executePublic(
		"call-wf-mission-async-resume",
		{
			workflowScript: wfScript,
			async: false,
			mission: { title: "Async Resume Mission" },
		},
		abortSignal(),
		undefined,
		fixture.ctx,
	);

	assert.notEqual(wfResult.isError, true, `workflow should succeed: ${textOf(wfResult)}`);
	assert.equal(asyncCalls.length, 1, "explicit async:true resume must launch async execution");
	const realRunId = asyncCalls[0].runId;
	assert.ok(realRunId, "the async resume must have a real run id");

	// The binding must already exist under the real async run id at launch time; a
	// post-return check alone would also pass thanks to the workflow's later rewrite.
	assert.equal(
		bindingAtLaunch?.missionId !== undefined,
		true,
		`mission binding must be visible under the real async run directory '${realRunId}' during the run`,
	);

	// The mission binding written before launch must live in the same directory as the
	// real async run, so completion-time observers can resolve the mission.
	assert.ok(
		fs.existsSync(path.join(graph.DIRS.async, realRunId, "mission.json")),
		`mission.json must be written into the real async run directory '${realRunId}'`,
	);

	const ghostDirs = fs.existsSync(graph.DIRS.async)
		? fs.readdirSync(graph.DIRS.async).filter((entry) => {
			// DIRS.async is shared across the whole test file, so only inspect entries this
			// case created; otherwise bindings from earlier cases look like leftovers.
			if (beforeEntries.has(entry) || entry === realRunId) return false;
			const entryPath = path.join(graph.DIRS.async, entry);
			if (!fs.statSync(entryPath).isDirectory()) return false;
			return fs.existsSync(path.join(entryPath, "mission.json"));
		})
		: [];
	assert.deepEqual(ghostDirs, [], `no mission binding may be left in an unused async directory: ${ghostDirs.join(", ")}`);
});

test("detach reconciliation failure still settles the awaiting workflow and releases the lease", async () => {
	const fixture = createFixture(graph, "detach-reconcile-failure");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const executor = graph.createSubagentExecutor(fixture.deps);

	let detachedOptions;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		detachedOptions = options;
		return completedResult(fixture, { detached: true, detachedReason: "user request", exitCode: undefined, finalOutput: undefined });
	});

	const wfScript = `return runs.run("child-1", { resume: "${RUN_A}", task: "continue in workflow" });`;
	const wfPromise = executor.executePublic(
		"wf-call-reconcile-failure",
		{ workflowScript: wfScript, async: false },
		abortSignal(),
		undefined,
		fixture.ctx,
	);

	// Let the workflow start and receive the provisional detach receipt.
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(typeof detachedOptions?.onDetachedExit, "function");

	// Reconciliation must not be able to strand the awaiting workflow or the lease.
	graph.setDetachReconcileFailure(new Error("injected reconciliation failure"));
	try {
		const terminal = completedResult(fixture, { detached: undefined, detachedReason: "user request", exitCode: 0, finalOutput: "TERMINAL AFTER FAILED RECONCILE" });
		await detachedOptions.onDetachedExit(terminal);

		const wfResult = await Promise.race([
			wfPromise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("workflow never settled after reconciliation failure")), 3000)),
		]);
		assert.notEqual(wfResult.isError, true, `workflow must settle successfully: ${textOf(wfResult)}`);
		assert.match(textOf(wfResult), /TERMINAL AFTER FAILED RECONCILE/, "workflow must receive the authoritative terminal output");
		assert.equal(graph.inspectSessionLease(fixture.childSessionFile).state, "free", "lease must be released even when reconciliation fails");
		assert.equal(fixture.state.foregroundControls.size, 0, "foreground control must be cleaned up even when reconciliation fails");
	} finally {
		graph.clearDetachReconcileFailure();
	}
});

test("foreground resume rejects a second simultaneous foreground call to a different child session", async () => {
	const fixture = createFixture(graph, "resume-dispatch-guard");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const secondSession = path.join(fixture.dir, "second-child.jsonl");
	fs.writeFileSync(secondSession, "");
	const firstRun = fixture.state.foregroundRuns.get(RUN_A);
	fixture.state.foregroundRuns.set(RUN_J, {
		...firstRun,
		runId: RUN_J,
		children: [{ ...firstRun.children[0], sessionFile: secondSession }],
	});
	const executor = graph.createSubagentExecutor(fixture.deps);
	resetDoubles();
	let releaseFirst;
	setRunSyncBehavior(() => runSyncCalls.length === 1
		? new Promise((resolve) => { releaseFirst = () => resolve(completedResult(fixture)); })
		: completedResult(fixture, { sessionFile: secondSession }));
	const first = executor.executePublic("call-first", { action: "resume", id: RUN_A, message: "first" }, abortSignal(), undefined, fixture.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(typeof releaseFirst, "function", "the first foreground resume must reach runSync");
	try {
		const second = await executor.executePublic("call-second", { action: "resume", id: RUN_J, message: "second", async: false }, abortSignal(), undefined, fixture.ctx);
		assert.equal(second.isError, true, "a distinct session must not bypass the single foreground-call guard");
		assert.equal(runSyncCalls.length, 1, "the second foreground resume must not reach runSync");

		setAsyncBehaviors({ single: (runId) => asyncStartedResult(runId) });
		const background = await executor.executePublic("call-background", { action: "resume", id: RUN_J, message: "background", async: true }, abortSignal(), undefined, fixture.ctx);
		assert.notEqual(background.isError, true, `explicit async:true resume must remain outside the foreground guard: ${textOf(background)}`);
		assert.equal(asyncCalls.length, 1);
	} finally {
		releaseFirst();
		await first;
	}
	assert.equal(fixture.state.subagentInProgress, false, "the guard must be released after completion");
});

test("nested foreground resume retains its inherited fan-out budget and qualifies its run path", async () => {
	const fixture = createFixture(graph, "resume-nested-budget");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const inheritedBudget = { ...graph.createRunFanoutBudget(RUN_H, 2), parentPath: "parent-step" };
	fixture.deps.childRuntime = { depth: 1, maxDepth: 4, nestedRoute: graph.createNestedRoute(RUN_H), runFanoutBudget: inheritedBudget };
	const executor = graph.createSubagentExecutor(fixture.deps);
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const result = await executor.executePublic("call-nested-budget", { action: "resume", id: RUN_A, message: "continue" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(result.isError, true, textOf(result));
	const passedBudget = runSyncCalls[0].options.runFanoutBudget;
	assert.equal(passedBudget.rootRunId, inheritedBudget.rootRunId);
	assert.equal(passedBudget.directory, inheritedBudget.directory);
	assert.equal(passedBudget.limit, inheritedBudget.limit);
	assert.equal(passedBudget.parentPath, `parent-step/${result.details.runId}`);


	const recoveryFixture = createFixture(graph, "resume-nested-recovery-budget");
	const recoveryBudget = graph.createRunFanoutBudget(RUN_G, 4);
	seedAsyncRun(graph, recoveryFixture, {
		runId: RUN_K,
		recoveryDescriptor: recoveryDescriptorFor(graph, recoveryFixture, RUN_K, { runFanoutBudget: recoveryBudget }),
	});
	recoveryFixture.deps.childRuntime = fixture.deps.childRuntime;
	const recoveryExecutor = graph.createSubagentExecutor(recoveryFixture.deps);
	resetDoubles();
	setRunSyncBehavior(() => completedResult(recoveryFixture));
	const recovered = await recoveryExecutor.executePublic("call-recovery-budget", { action: "resume", id: RUN_K, message: "continue" }, abortSignal(), undefined, recoveryFixture.ctx);
	assert.notEqual(recovered.isError, true, textOf(recovered));
	assert.deepEqual(runSyncCalls[0].options.runFanoutBudget, recoveryBudget, "the retained recovery budget must win over an unrelated inherited one");
});

test("foreground resume uses agent timeout before the global default but preserves explicit alias precedence", async () => {
	const fixture = createFixture(graph, "resume-agent-timeout");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	fixture.discoveredAgents[0].defaultTimeoutMs = 1200;
	fixture.config.timeoutMs = 9000;
	const executor = graph.createSubagentExecutor(fixture.deps);
	resetDoubles();
	setRunSyncBehavior(() => completedResult(fixture));
	const defaulted = await executor.executePublic("call-timeout-default", { action: "resume", id: RUN_A, message: "continue" }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(defaulted.isError, true, textOf(defaulted));
	assert.equal(runSyncCalls[0].options.timeoutMs, 1200, "selected agent timeout must win over the global default");
	const explicit = await executor.executePublic("call-timeout-alias", { action: "resume", id: RUN_A, message: "continue", maxRuntimeMs: 1500 }, abortSignal(), undefined, fixture.ctx);
	assert.notEqual(explicit.isError, true, textOf(explicit));
	assert.equal(runSyncCalls[1].options.timeoutMs, 1500, "an explicit alias must override the agent default");
	const conflicting = await executor.executePublic("call-timeout-conflict", { action: "resume", id: RUN_A, message: "continue", timeoutMs: 1000, maxRuntimeMs: 2000 }, abortSignal(), undefined, fixture.ctx);
	assert.equal(conflicting.isError, true, "conflicting explicit aliases must still be rejected");
	assert.equal(runSyncCalls.length, 2);
});

test("nested mission workflow async resume prewrites the binding in the actual nested run directory", async () => {
	const fixture = createFixture(graph, "mission-wf-nested-async-resume");
	seedCompletedForegroundRun(fixture, { runId: RUN_A });
	const route = graph.createNestedRoute(RUN_I);
	fixture.deps.childRuntime = { depth: 1, maxDepth: 4, nestedRoute: route };
	const executor = graph.createSubagentExecutor(fixture.deps);
	const priorTopLevelDirs = new Set(fs.existsSync(graph.DIRS.async) ? fs.readdirSync(graph.DIRS.async) : []);
	let bindingAtLaunch;
	resetDoubles();
	setAsyncBehaviors({ single: (runId) => {
		const actualAsyncDir = path.join(graph.TEMP_ROOT_DIR, "nested-subagent-runs", route.rootRunId, runId);
		bindingAtLaunch = graph.readMissionBinding(actualAsyncDir);
		seedAwaitedAsyncRootResult(actualAsyncDir);
		return asyncStartedResult(runId, actualAsyncDir);
	} });
	const result = await executor.executePublic(
		"call-nested-mission-resume",
		{ workflowScript: `return runs.run("child-nested", { resume: "${RUN_A}", task: "nested async", async: true });`, async: false, mission: { title: "Nested Async Mission" } },
		abortSignal(), undefined, fixture.ctx,
	);
	assert.notEqual(result.isError, true, textOf(result));
	assert.equal(asyncCalls.length, 1);
	assert.ok(bindingAtLaunch?.missionId, "nested async binding must be readable before completion in the actual run directory");
	assert.ok(graph.readMissionBinding(path.join(graph.TEMP_ROOT_DIR, "nested-subagent-runs", route.rootRunId, asyncCalls[0].runId)));
	const newTopLevelBindingDirs = (fs.existsSync(graph.DIRS.async) ? fs.readdirSync(graph.DIRS.async) : [])
		.filter((entry) => !priorTopLevelDirs.has(entry) && fs.existsSync(path.join(graph.DIRS.async, entry, "mission.json")));
	assert.deepEqual(newTopLevelBindingDirs, [], "nested async resume must not prewrite a ghost top-level mission binding");

	resetDoubles();
	let newTaskBindingAtLaunch;
	setAsyncBehaviors({ single: (runId) => {
		const actualAsyncDir = path.join(graph.TEMP_ROOT_DIR, "nested-subagent-runs", route.rootRunId, runId);
		newTaskBindingAtLaunch = graph.readMissionBinding(actualAsyncDir);
		return asyncStartedResult(runId, actualAsyncDir);
	} });
	const newTask = await executor.executePublic(
		"call-nested-mission-new-task",
		{ workflowScript: 'return runs.run("child-new", { agent: "worker", task: "new nested async task", async: true });', async: false, mission: { title: "Nested Async New Task" } },
		abortSignal(), undefined, fixture.ctx,
	);
	assert.notEqual(newTask.isError, true, textOf(newTask));
	assert.equal(asyncCalls.length, 1);
	assert.ok(newTaskBindingAtLaunch?.missionId, "a new nested async task also needs its binding in the actual run directory at launch");
	const newTopLevelAfterTask = (fs.existsSync(graph.DIRS.async) ? fs.readdirSync(graph.DIRS.async) : [])
		.filter((entry) => !priorTopLevelDirs.has(entry) && fs.existsSync(path.join(graph.DIRS.async, entry, "mission.json")));
	assert.deepEqual(newTopLevelAfterTask, [], "neither nested launch may leave a top-level mission binding");
});
