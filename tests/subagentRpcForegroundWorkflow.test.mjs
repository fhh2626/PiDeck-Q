/** RPC stop must reach the original retained foreground continuation. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { createFixture, resetDoubles, setRunSyncBehavior, runSyncCalls, completedResult } from "./helpers/subagentResumeHarness.mjs";

await import("./helpers/piFixtureResolver.mjs");
const executionDouble = new URL("./helpers/subagentExecutionDouble.mjs", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL?.includes("pideck-q-subagents") && specifier.endsWith("/execution.ts")) {
			return { url: executionDouble, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const graph = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/subagent-executor.ts");
const rpc = await import("../resources/extensions/pideck-q-subagents/src/extension/rpc.ts");

function eventsFor() {
	const listeners = new Map();
	return {
		on(name, callback) { const list = listeners.get(name) ?? new Set(); list.add(callback); listeners.set(name, list); return () => list.delete(callback); },
		emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); },
	};
}
// The retained result is published before this terminal notification is sent.
function workflowCompletion(fixture) {
	const { promise, resolve } = Promise.withResolvers();
	fixture.deps.pi.sendMessage = (message) => {
		if (message.customType === "subagent-workflow-complete") resolve();
	};
	return promise;
}

function request(events, method, params) {
	const requestId = `${method}-${Math.random()}`;
	return new Promise((resolve) => {
		const off = events.on(rpc.subagentRpcReplyEvent(requestId), (reply) => { off(); resolve(reply); });
		events.emit(rpc.SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId, method, params });
	});
}

for (const target of ["workflow", "child"]) {
	test(`RPC stops the retained ${target} through its original foreground control`, { timeout: 10_000 }, async (t) => {
		if (target === "child") {
			const postMessage = Worker.prototype.postMessage;
			// Model the workflow worker running later than the test's event-loop turns.
			// Delay only the failed run response, leaving the real worker and VM in use.
			t.mock.method(Worker.prototype, "postMessage", function (message, ...args) {
				if (message.type !== "response" || message.ok !== false) return postMessage.call(this, message, ...args);
				let remainingTurns = 101;
				const deliver = () => {
					if (--remainingTurns > 0) setImmediate(deliver);
					else postMessage.call(this, message, ...args);
				};
				setImmediate(deliver);
			});
		}
		const fixture = createFixture(graph, `rpc-${target}`);
		const completion = workflowCompletion(fixture);
		const events = eventsFor();
		fixture.deps.pi.events = events;
		const executor = graph.createSubagentExecutor(fixture.deps);
		const owner = new AbortController();
		let child;
		resetDoubles();
		setRunSyncBehavior(({ options }) => {
			child = options;
			events.emit("pi-intercom:detach-request", { requestId: "rpc-ask", runId: options.runId, agent: "worker", childIndex: 0, source: "native" });
			return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
		});
		const initial = await executor.executePublic("rpc-workflow", {
			workflowScript: 'const first = await runs.run("first", { agent: "worker", task: "inspect", acceptance: false }); return runs.run("later", { agent: "worker", task: first.output, acceptance: false });',
			output: false, timeoutMs: 5000,
		}, owner.signal, undefined, fixture.ctx);
		assert.notEqual(initial.isError, true, JSON.stringify(initial));
		assert.ok(child);
		const run = fixture.state.foregroundWorkflows.get(initial.details.runId);
		const bridge = rpc.registerSubagentRpcBridge({ events, getContext: () => fixture.ctx, state: fixture.state, execute: executor.executePublic });
		try {
			const invalid = await request(events, "stop", { id: run.runId, childId: {} });
			assert.equal(invalid.success, false);
			assert.equal(child.signal.aborted, false);
			assert.equal(child.interruptSignal.aborted, false);
			const reply = await request(events, "stop", { id: run.runId.slice(0, 12), ...(target === "child" ? { childId: "first" } : {}) });
			assert.equal(reply.success, true, JSON.stringify(reply));
			assert.equal(target === "child" ? child.interruptSignal.aborted : child.signal.aborted, true);
			assert.equal(fixture.state.foregroundControls.has(child.runId), true, "child ownership remains until its authoritative exit");
			assert.equal(runSyncCalls.length, 1, "stopping must not replay the workflow");
			if (target === "child") {
				assert.equal(fixture.state.workflowControllers.get(run.runId).signal.aborted, false);
				assert.equal(run.result, undefined, "child stop ACK is not terminal workflow output");
			}
			await child.onDetachedExit(completedResult(fixture, { interrupted: true, exitCode: 1, finalOutput: "CHILD STOP CONFIRMED" }));
			await completion;
			assert.equal(run.result?.isError, true);
			// The call trace can mention the interrupted child even if the worker actually times out.
			const terminal = run.result.content[0].text.split("\n\nCall trace:", 1)[0];
			if (target === "child") {
				assert.match(terminal, /^Workflow failed: Error: Run 'first' failed:/m);
				assert.match(terminal, /Run paused after interrupt/);
			} else {
				assert.match(terminal, /^Workflow failed: [^\r\n]*Foreground workflow interrupted/m);
			}
			assert.equal(runSyncCalls.length, 1, "the next stage remains cancelled after the late child exit");
		} finally {
			bridge.dispose();
			owner.abort();
		}
	});
}

test("RPC cannot stop a retained workflow owned by another session", async () => {
	const fixture = createFixture(graph, "rpc-foreign");
	fixture.state.currentSessionId = fixture.parentSessionFile;
	let stopped = false;
	fixture.state.foregroundWorkflows = new Map([["foreign-workflow", { runId: "foreign-workflow", sessionId: "other-session", interrupt() { stopped = true; } }]]);
	const events = eventsFor();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const bridge = rpc.registerSubagentRpcBridge({ events, getContext: () => fixture.ctx, state: fixture.state, execute: executor.executePublic });
	try {
		const reply = await request(events, "stop", { id: "foreign-workflow" });
		assert.equal(reply.success, false);
		assert.equal(stopped, false);
	} finally { bridge.dispose(); }
});

for (const mode of ["steer", "follow_up"]) {
	test(`RPC ${mode} reaches the original child of a retained foreground workflow`, { timeout: 10_000 }, async () => {
		const fixture = createFixture(graph, `rpc-${mode}`);
		const completion = workflowCompletion(fixture);
		const events = eventsFor();
		fixture.deps.pi.events = events;
		const executor = graph.createSubagentExecutor(fixture.deps);
		const owner = new AbortController();
		const delivered = [];
		let child;
		resetDoubles();
		setRunSyncBehavior(({ options }) => {
			child = options;
			options.onChildSession({
				steer: async (message) => { delivered.push({ mode: "steer", message }); },
				followUp: async (message) => { delivered.push({ mode: "follow_up", message }); },
			});
			events.emit("pi-intercom:detach-request", { requestId: "steer-ask", runId: options.runId, agent: "worker", childIndex: 0, source: "native" });
			return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
		});
		const initial = await executor.executePublic(`rpc-${mode}-workflow`, {
			workflowScript: 'return runs.run("first", { agent: "worker", task: "inspect", acceptance: false });',
			output: false, timeoutMs: 5000,
		}, owner.signal, undefined, fixture.ctx);
		assert.notEqual(initial.isError, true, JSON.stringify(initial));
		const retained = fixture.state.foregroundWorkflows.get(initial.details.runId);
		const bridge = rpc.registerSubagentRpcBridge({ events, getContext: () => fixture.ctx, state: fixture.state, execute: executor.executePublic });
		try {
			const reply = await request(events, "steer", { id: child.runId.slice(0, 12), mode, message: "Keep the existing work and check the final output." });
			assert.equal(reply.success, true, JSON.stringify(reply));
			assert.deepEqual(delivered, [{ mode, message: "Keep the existing work and check the final output." }]);
			assert.equal(runSyncCalls.length, 1, "steering must use the original child session");
			assert.equal(child.signal.aborted, false);
			assert.equal(child.interruptSignal.aborted, false);
			assert.equal(retained.result, undefined, "the existing workflow continuation must remain live");
		} finally {
			bridge.dispose();
			try {
				await child.onDetachedExit(completedResult(fixture, { finalOutput: "STEERED CHILD COMPLETE" }));
				await completion;
			} finally {
				owner.abort();
			}
		}
	});
}

for (const mode of ["steer", "follow_up"]) {
	test(`RPC ${mode} reaches a direct detached foreground child`, { timeout: 10_000 }, async () => {
		const fixture = createFixture(graph, `rpc-direct-${mode}`);
		const events = eventsFor();
		fixture.deps.pi.events = events;
		const executor = graph.createSubagentExecutor(fixture.deps);
		const owner = new AbortController();
		const delivered = [];
		let child;
		resetDoubles();
		setRunSyncBehavior(({ options }) => {
			child = options;
			options.onChildSession({
				steer: async (message) => { delivered.push({ mode: "steer", message }); },
				followUp: async (message) => { delivered.push({ mode: "follow_up", message }); },
			});
			return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
		});
		const initial = await executor.executePublic(`rpc-direct-${mode}`, {
			agent: "worker", task: "inspect", acceptance: false, output: false,
		}, owner.signal, undefined, fixture.ctx);
		assert.notEqual(initial.isError, true, JSON.stringify(initial));
		const bridge = rpc.registerSubagentRpcBridge({ events, getContext: () => fixture.ctx, state: fixture.state, execute: executor.executePublic });
		try {
			const reply = await request(events, "steer", { id: child.runId.slice(0, 12), mode, message: "Check the current output before finishing." });
			assert.equal(reply.success, true, JSON.stringify(reply));
			assert.deepEqual(delivered, [{ mode, message: "Check the current output before finishing." }]);
			assert.equal(runSyncCalls.length, 1);
			assert.equal(child.signal.aborted, false);
			assert.equal(child.interruptSignal.aborted, false);
			fixture.ctx.sessionManager.getSessionFile = () => `${fixture.parentSessionFile}.another-session`;
			const foreignInterrupt = await request(events, "interrupt", { id: child.runId });
			assert.equal(foreignInterrupt.success, false, "an exact-id interrupt must refresh ownership from the incoming context");
			assert.equal(child.interruptSignal.aborted, false);
			const foreign = await request(events, "steer", { id: child.runId, mode, message: "This must not be delivered." });
			assert.equal(foreign.success, false, "a new parent session must not steer the retained child");
			assert.equal(delivered.length, 1);
			const foreignStatus = await request(events, "status", { id: child.runId });
			assert.equal(foreignStatus.success, false, "a new parent session must not inspect the retained child");
		} finally {
			bridge.dispose();
			await child.onDetachedExit(completedResult(fixture, { finalOutput: "DIRECT CHILD COMPLETE" }));
			owner.abort();
		}
	});
}

test("RPC rejects removed spawn and schedule management methods", async () => {
	const fixture = createFixture(graph, "rpc-removed");
	const events = eventsFor();
	const executor = graph.createSubagentExecutor(fixture.deps);
	const bridge = rpc.registerSubagentRpcBridge({ events, getContext: () => fixture.ctx, state: fixture.state, execute: executor.executePublic });
	try {
		for (const method of ["spawn", "manage"]) {
			const reply = await request(events, method, { agent: "worker", task: "do work", action: "schedule.list" });
			assert.equal(reply.success, false);
			assert.equal(reply.error.code, "unsupported_method");
		}
	} finally { bridge.dispose(); }
});
