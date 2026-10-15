import assert from "node:assert/strict";
import test from "node:test";
import { createFixture, loadSubagentResumeGraph, resetDoubles, setRunSyncBehavior, runSyncCalls, completedResult, seedCompletedForegroundRun } from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();
const { waitForSubagents } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-wait.ts");

/** Event-bus boundary used by native supervisor and foreground execution in production. */
function eventsFor() {
	const listeners = new Map();
	return {
		on(name, callback) { const list = listeners.get(name) ?? new Set(); list.add(callback); listeners.set(name, list); return () => list.delete(callback); },
		emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); },
		listenerCount() { return [...listeners.values()].reduce((count, list) => count + list.size, 0); },
	};
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

for (const resume of [false, true]) {
	test(`foreground workflow yields supervisor attention for ${resume ? "resumed" : "new"} child and keeps the original continuation`, async () => {
		const fixture = createFixture(graph, `supervisor-${resume}`);
		const bus = eventsFor();
		fixture.deps.pi.events = bus;
		const sourceId = "0b2c80e6-4ca2-4025-9850-10cdfd000001";
		if (resume) seedCompletedForegroundRun(fixture, { runId: sourceId });
		const executor = graph.createSubagentExecutor(fixture.deps);
		const controller = new AbortController();
		let detachedOptions;
		let request;
		resetDoubles();
		setRunSyncBehavior(({ options, task }) => {
			if (task.includes("second stage")) return completedResult(fixture, { finalOutput: "SECOND STAGE COMPLETE" });
			detachedOptions = options;
			request = { requestId: "ask-1", runId: options.runId, agent: "worker", childIndex: 0, source: "native" };
			bus.emit("pi-intercom:detach-request", request);
			return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
		});
		const launch = resume ? `resume: "${sourceId}"` : 'agent: "worker"';
		const pending = executor.executePublic("supervisor-wf", {
			workflowScript: `const first = await runs.run("first", { ${launch}, task: "first stage", async: false, acceptance: false });
			return runs.run("second", { agent: "worker", task: "second stage: " + first.output, async: false, acceptance: false });`,
			async: false, output: false, timeoutMs: 2000,
		}, controller.signal, undefined, fixture.ctx);
		try {
			const result = await Promise.race([pending, pause(400).then(() => null)]);
			assert.ok(result, "supervisor request must release the parent before waiting for a reply");
			assert.match(text(result), /needs.attention/i);
			assert.match(text(result), /ask-1/);
			assert.equal(runSyncCalls.length, 1, "no later stage may run on a provisional detach receipt");
			assert.equal(detachedOptions.retainAbortOnDetach, true, "new and resumed workflow children must retain runSync cancellation after a handoff");
			const replay = await executor.executePublic("reject-replay", { action: "resume", id: result.details.runId }, new AbortController().signal, undefined, fixture.ctx);
			assert.equal(replay.isError, true);
			assert.match(text(replay), /do not replay/);
			const waiting = await executor.executePublic("status-wf", { action: "status", id: result.details.runId }, new AbortController().signal, undefined, fixture.ctx);
			assert.match(text(waiting), /ask-1/);
			bus.emit("pi-subagents:supervisor-request-settled", { ...request, lifecycle: "resolved" });
			await detachedOptions.onDetachedExit(completedResult(fixture, { finalOutput: "AUTHORITATIVE FIRST RESULT" }));
			for (let i = 0; i < 30 && runSyncCalls.length < 2; i++) await pause(10);
			assert.equal(runSyncCalls.length, 2, "reply continues the original VM, not a replacement child");
			assert.match(runSyncCalls[1].task, /AUTHORITATIVE FIRST RESULT/);
			for (let i = 0; i < 30; i++) {
				const status = await executor.executePublic("done-wf", { action: "status", id: result.details.runId }, new AbortController().signal, undefined, fixture.ctx);
				if (text(status).includes("SECOND STAGE COMPLETE")) {
					assert.equal(bus.listenerCount(), 0, "all handoff listeners must be cleaned up after terminal output");
					return;
				}
				await pause(10);
			}
			assert.fail("the retained workflow must expose its final output");
		} finally {
			controller.abort();
			await pending;
		}
	});
}

for (const ending of ["timeout", "interrupt", "stop", "session-change"]) {
	test(`a handed-off workflow settles on ${ending} without launching a later stage or releasing a live child's ownership early`, async () => {
		const fixture = createFixture(graph, ending);
		const events = eventsFor();
		fixture.deps.pi.events = events;
		const executor = graph.createSubagentExecutor(fixture.deps);
		let child;
		resetDoubles();
		setRunSyncBehavior(({ options }) => {
			child = options;
			events.emit("pi-intercom:detach-response", { accepted: true, requestId: "external-ask", runId: options.runId, agent: "worker", childIndex: 0 });
			return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
		});
		const owner = new AbortController();
		const initial = await executor.executePublic("ending-wf", {
			workflowScript: 'await runs.run("first", { agent: "worker", task: "first stage", async: false, acceptance: false }); return runs.run("second", { agent: "worker", task: "must not start", async: false });',
			async: false, output: false, timeoutMs: ending === "timeout" ? 150 : 2000,
		}, owner.signal, undefined, fixture.ctx);
		try {
			assert.match(text(initial), /needs_attention/, "accepted external-intercom detach must also release the parent");
			if (ending === "interrupt" || ending === "stop") {
				const stopped = await executor.executePublic("interrupt-wf", { action: ending, id: initial.details.runId.slice(0, 12) }, new AbortController().signal, undefined, fixture.ctx);
				assert.notEqual(stopped.isError, true, text(stopped));
			} else if (ending === "session-change") {
				fixture.state.currentSessionId = "different-session";
				const { interruptForeignForegroundWorkflows } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/workflow-handoff.ts");
				interruptForeignForegroundWorkflows(fixture.state, fixture.state.currentSessionId);
			}
			const run = fixture.state.foregroundWorkflows.get(initial.details.runId);
			for (let i = 0; i < 100 && !run.result; i++) await pause(10);
			assert.ok(run.result, "no terminal child callback is necessary to settle the root VM on cancellation");
			assert.equal(run.result.isError, true);
			assert.equal(child.signal.aborted, true);
			assert.equal(runSyncCalls.length, 1);
			assert.equal(events.listenerCount(), 0);
			assert.equal(fixture.state.workflowControllers.has(initial.details.runId), false);
			assert.equal(fixture.state.foregroundControls.has(child.runId), true, "root cancellation must not erase a child that has not confirmed exit");
			// The authoritative child exit, not the parent handoff, remains the lifecycle/lease boundary.
			await child.onDetachedExit(completedResult(fixture, { exitCode: 1, interrupted: true, error: "stopped", finalOutput: "STOPPED" }));
			await pause(20);
			assert.equal(runSyncCalls.length, 1, "a late child completion must never replay a cancelled continuation");
		} finally {
			owner.abort();
		}
	});
}

test("stopping a retained workflow child uses its live interrupt control without cancelling the root VM", async () => {
	const fixture = createFixture(graph, "stop-one-child");
	const events = eventsFor();
	fixture.deps.pi.events = events;
	const executor = graph.createSubagentExecutor(fixture.deps);
	let child;
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		child = options;
		events.emit("pi-intercom:detach-request", { requestId: "stop-ask", runId: options.runId, agent: "worker", childIndex: 0, source: "native" });
		return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
	});
	const owner = new AbortController();
	const initial = await executor.executePublic("stop-child-root", { workflowScript: 'return runs.run("first", { agent: "worker", task: "inspect", async: false, acceptance: false });', async: false, output: false, timeoutMs: 2000 }, owner.signal, undefined, fixture.ctx);
	try {
		const stopped = await executor.executePublic("stop-one", { action: "stop", id: initial.details.runId, childId: "first" }, new AbortController().signal, undefined, fixture.ctx);
		assert.notEqual(stopped.isError, true, text(stopped));
		assert.equal(child.interruptSignal.aborted, true);
		assert.equal(fixture.state.workflowControllers.get(initial.details.runId).signal.aborted, false);
		await child.onDetachedExit(completedResult(fixture, { interrupted: true, exitCode: 1, finalOutput: "CHILD STOP CONFIRMED" }));
		events.emit("pi-subagents:supervisor-request-settled", { requestId: "stop-ask", runId: child.runId, agent: "worker", childIndex: 0 });
		const final = await waitForSubagents({ id: initial.details.runId, timeoutMs: 1000 }, undefined, { state: fixture.state, pollIntervalMs: 10 });
		assert.equal(final.isError, true, "an interrupted child pauses/fails the workflow instead of pretending it succeeded");
		assert.match(text(final), /Run paused after interrupt/);
		assert.equal(final.details.results[0].interrupted, true);
		assert.equal(runSyncCalls.length, 1);
	} finally { owner.abort(); }
});

test("parallel asks and a repeated ask yield without wait-all or stopOnAttention:false hiding the decision", async () => {
	const fixture = createFixture(graph, "parallel-asks");
	const events = eventsFor();
	fixture.deps.pi.events = events;
	const executor = graph.createSubagentExecutor(fixture.deps);
	const children = [];
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		children.push(options);
		events.emit("pi-intercom:detach-request", { requestId: `ask-${children.length}`, runId: options.runId, agent: "worker", childIndex: 0, source: "native" });
		return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
	});
	const owner = new AbortController();
	const initial = await executor.executePublic("parallel-asks", {
		workflowScript: 'return runs.all([{ key: "a", agent: "worker", task: "inspect A", async: false, acceptance: false }, { key: "b", agent: "worker", task: "inspect B", async: false, acceptance: false }]);',
		async: false, output: false, timeoutMs: 2000,
	}, owner.signal, undefined, fixture.ctx);
	try {
		for (let i = 0; i < 30 && children.length < 2; i++) await pause(10);
		const retained = fixture.state.foregroundWorkflows.get(initial.details.runId);
		assert.equal(retained.requests.size, 2);
		const wait = await waitForSubagents({ all: true, timeoutMs: 100, stopOnAttention: false }, undefined, { state: fixture.state });
		assert.match(text(wait), /ask-1/);
		assert.match(text(wait), /ask-2/);
		for (let i = 0; i < 2; i++) events.emit("pi-subagents:supervisor-request-settled", { requestId: `ask-${i + 1}`, runId: children[i].runId, agent: "worker", childIndex: 0, lifecycle: "resolved" });
		assert.equal(retained.requests.size, 0);
		const emptyWindow = await waitForSubagents({ id: initial.details.runId, timeoutMs: 5 }, undefined, { state: fixture.state, pollIntervalMs: 5 });
		assert.match(text(emptyWindow), /window elapsed/i);
		events.emit("pi-intercom:detach-request", { requestId: "ask-again", runId: children[0].runId, agent: "worker", childIndex: 0, source: "native" });
		const repeated = await waitForSubagents({ id: initial.details.runId, timeoutMs: 100 }, undefined, { state: fixture.state });
		assert.match(text(repeated), /ask-again/);
		for (let i = 0; i < 2; i++) await children[i].onDetachedExit(completedResult(fixture, { finalOutput: `ANSWER-${i}` }));
		for (let i = 0; i < 30 && !retained.result; i++) await pause(10);
		const done = await waitForSubagents({ id: initial.details.runId }, undefined, { state: fixture.state });
		assert.match(text(done), /ANSWER-0/);
		assert.match(text(done), /ANSWER-1/);
		assert.equal(runSyncCalls.length, 2);
	} finally { owner.abort(); }
});