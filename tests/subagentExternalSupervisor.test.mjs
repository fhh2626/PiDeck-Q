import assert from "node:assert/strict";
import test from "node:test";
import { createFixture, loadSubagentResumeGraph, resetDoubles, setRunSyncBehavior, completedResult } from "./helpers/subagentResumeHarness.mjs";
import { createForegroundSupervisorBridge } from "../resources/extensions/pideck-q-subagents/src/runs/foreground/foreground-supervisor.ts";

const graph = await loadSubagentResumeGraph();
const { waitForSubagents } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-wait.ts");
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");
function bus() {
	const handlers = new Map();
	return { on(name, fn) { const set = handlers.get(name) ?? new Set(); set.add(fn); handlers.set(name, set); return () => set.delete(fn); }, emit(name, value) { for (const fn of handlers.get(name) ?? []) fn(value); } };
}

test("external tool replies clear only their own asks, and repeated asks survive stale replies", async () => {
	const fixture = createFixture(graph, "external-lifecycle");
	const events = bus();
	fixture.deps.pi.events = events;
	const executor = graph.createSubagentExecutor(fixture.deps);
	const owner = new AbortController();
	let child;
	let bridge;
	let detached = false;
	let activeCalls = ["tool-call-1"];
	resetDoubles();
	setRunSyncBehavior(({ options }) => {
		child = options;
		bridge = createForegroundSupervisorBridge({ events, enabled: true, runId: options.runId, agent: "worker", childIndex: 0,
			isLive: () => true, isDetached: () => detached,
			detach: () => { if (detached) return false; detached = true; return true; },
			activeIntercomCalls: () => activeCalls.map((key) => ({ key, toolCallId: key })),
		});
		queueMicrotask(() => events.emit("pi-intercom:detach-request", { requestId: "external-1" }));
		return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
	});
	const initial = await executor.executePublic("external-wf", { workflowScript: 'return runs.run("one", { agent: "worker", task: "inspect", async: false, acceptance: false });', async: false, output: false, timeoutMs: 2000 }, owner.signal, undefined, fixture.ctx);
	try {
		assert.match(text(initial), /needs_attention/);
		const retained = fixture.state.foregroundWorkflows.get(initial.details.runId);
		bridge.toolEnded("tool-call-1");
		assert.equal(retained.requests.size, 0, "external tool completion, not a fabricated native event, must settle attention");
		const running = await waitForSubagents({ id: initial.details.runId, timeoutMs: 1 }, undefined, { state: fixture.state, pollIntervalMs: 250 });
		assert.match(text(running), /window elapsed/i);
		activeCalls = ["tool-call-2"];
		events.emit("pi-intercom:detach-request", { requestId: "external-2" });
		assert.equal(retained.requests.size, 1, "a child already detached can ask another question");
		bridge.toolEnded("tool-call-1");
		assert.equal(retained.requests.size, 1, "late completion of the previous tool must not clear the new ask");
		const pending = await waitForSubagents({ id: initial.details.runId }, undefined, { state: fixture.state });
		assert.match(text(pending), /external-2/);
		assert.match(text(pending), /intercom\(\{ action: "pending"/);
		events.emit("pi-subagents:supervisor-request-settled", { requestId: "external-2", runId: "foreign-child", agent: "worker", childIndex: 0, source: "external" });
		assert.equal(retained.requests.size, 1);
		bridge.toolEnded("tool-call-2");
		assert.equal(retained.requests.size, 0);
		await child.onDetachedExit(completedResult(fixture, { finalOutput: "EXTERNAL CHILD COMPLETE" }));
		const final = await waitForSubagents({ id: initial.details.runId, timeoutMs: 1000 }, undefined, { state: fixture.state, pollIntervalMs: 250 });
		assert.match(text(final), /EXTERNAL CHILD COMPLETE/);
	} finally { bridge?.dispose(); owner.abort(); }
});

test("external request correlation refuses ambiguity and disposes its outstanding asks", () => {
	const events = bus();
	const responses = [];
	const settled = [];
	events.on("pi-intercom:detach-response", (event) => responses.push(event));
	events.on("pi-subagents:supervisor-request-settled", (event) => settled.push(event));
	let activeCalls = ["a", "b"];
	const bridge = createForegroundSupervisorBridge({ events, enabled: true, runId: "child", agent: "readonly", childIndex: 0,
		isLive: () => true, isDetached: () => false, detach: () => true, activeIntercomCalls: () => activeCalls.map((key) => ({ key: `id:${key}`, toolCallId: key })),
	});
	try {
		events.emit("pi-intercom:detach-request", { requestId: "ambiguous" });
		assert.equal(responses.length, 0, "an unrouted ask must not attach to an arbitrary simultaneous tool call");
		activeCalls = ["a"];
		events.emit("pi-intercom:detach-request", { requestId: "owned" });
		assert.equal(responses.length, 1);
		bridge.dispose();
		assert.equal(settled.length, 1);
		assert.equal(settled[0].requestId, "owned");
		assert.equal(settled[0].lifecycle, "run-exited");
		events.emit("pi-intercom:detach-request", { requestId: "late" });
		assert.equal(responses.length, 1);
	} finally { bridge.dispose(); }
});

test("an explicit external toolCallId correlates simultaneous tools without clearing the wrong ask", () => {
	const events = bus();
	const settled = [];
	events.on("pi-subagents:supervisor-request-settled", (event) => settled.push(event));
	const bridge = createForegroundSupervisorBridge({ events, enabled: true, runId: "child", agent: "readonly", childIndex: 0,
		isLive: () => true, isDetached: () => false, detach: () => true,
		activeIntercomCalls: () => [{ key: "id:a", toolCallId: "a" }, { key: "id:b", toolCallId: "b" }],
	});
	try {
		events.emit("pi-intercom:detach-request", { requestId: "ask-a", toolCallId: "a" });
		events.emit("pi-intercom:detach-request", { requestId: "ask-b", toolCallId: "b" });
		bridge.toolEnded("id:b");
		assert.deepEqual(settled.map((event) => event.requestId), ["ask-b"]);
		bridge.toolEnded("id:a");
		assert.deepEqual(settled.map((event) => event.requestId), ["ask-b", "ask-a"]);
	} finally { bridge.dispose(); }
});

test("native asks remain owned by the native channel, not external tool completion", () => {
	const events = bus();
	const responses = [];
	const settled = [];
	events.on("pi-intercom:detach-response", (event) => responses.push(event));
	events.on("pi-subagents:supervisor-request-settled", (event) => settled.push(event));
	const bridge = createForegroundSupervisorBridge({ events, enabled: true, runId: "child", agent: "readonly", childIndex: 0,
		isLive: () => true, isDetached: () => false, detach: () => true, activeIntercomCalls: () => [],
	});
	events.emit("pi-intercom:detach-request", { requestId: "native", runId: "child", agent: "readonly", childIndex: 0, source: "native" });
	assert.equal(responses.length, 1);
	assert.equal(responses[0].source, "native");
	bridge.toolEnded("id:other");
	bridge.dispose();
	assert.equal(settled.length, 0);
});
