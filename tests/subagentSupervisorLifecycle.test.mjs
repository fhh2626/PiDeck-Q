import assert from "node:assert/strict";
import test from "node:test";
import { createFixture, loadSubagentResumeGraph, resetDoubles, setRunSyncBehavior, completedResult } from "./helpers/subagentResumeHarness.mjs";

const graph = await loadSubagentResumeGraph();
const native = await import("../resources/extensions/pideck-q-subagents/src/intercom/native-supervisor-channel.ts");
const { waitForSubagents } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-wait.ts");
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport event bus, not a model: exercise the real native ask/reply files and public executor. */
function bus() {
	const listeners = new Map();
	return { on(name, callback) { const list = listeners.get(name) ?? new Set(); list.add(callback); listeners.set(name, list); return () => list.delete(callback); }, emit(name, value) { for (const callback of listeners.get(name) ?? []) callback(value); } };
}

for (const expires of [false, true]) {
	test(`native supervisor ${expires ? "expiry" : "reply"} settles attention on the original foreground workflow`, async (t) => {
		const fixture = createFixture(graph, `native-${expires}`);
		const events = bus();
		const tools = new Map();
		const messages = [];
		Object.assign(fixture.deps.pi, { events, registerTool(tool) { tools.set(tool.name, tool); }, getAllTools: () => [...tools.values()], sendMessage(message) { messages.push(message); } });
		fixture.state.supervisorOwnerSessionId = "owner";
		const channel = native.createNativeSupervisorChannel(fixture.deps.pi, fixture.state);
		channel.start();
		t.after(() => channel.dispose());
		const oldTimeout = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
		process.env.PI_INTERCOM_ASK_TIMEOUT_MS = expires ? "120" : "1000";
		t.after(() => { if (oldTimeout === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS; else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = oldTimeout; });
		const controller = new AbortController();
		t.after(() => controller.abort());
		let childCompletion;
		resetDoubles();
		setRunSyncBehavior(({ options }) => {
			let contact;
			native.registerNativeSupervisorClient({ getAllTools: () => [], registerTool(tool) { contact = tool; } }, {
				channelDir: native.resolveSupervisorChannelDir(options.runId, "worker", 0), runId: options.runId, agent: "worker", childIndex: 0, orchestratorSessionId: "owner",
			});
			childCompletion = contact.execute("ask-tool", { reason: "need_decision", message: "Approve bounded change" }, options.signal).then(
				async () => options.onDetachedExit(completedResult(fixture, { finalOutput: "REAL ANSWER AFTER REPLY" })),
				async (error) => options.onDetachedExit(completedResult(fixture, { exitCode: 1, error: error.message, finalOutput: "DECISION EXPIRED" })),
			);
			queueMicrotask(() => channel.activateTransport());
			return completedResult(fixture, { detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
		});
		const executor = graph.createSubagentExecutor(fixture.deps);
		const initial = await executor.executePublic("native-handoff", { workflowScript: 'return runs.run("child", { agent: "worker", task: "change", async: false, acceptance: false });', async: false, output: false, timeoutMs: 2000 }, controller.signal, undefined, fixture.ctx);
		assert.match(text(initial), /needs_attention/);
		const supervisor = tools.get("subagent_supervisor");
		const pending = await supervisor.execute("pending", { action: "pending" });
		const requestId = pending.details.pending[0].id;
		assert.match(text(pending), /Approve bounded change/, "pending must expose the authoritative question, not only an expired queued hint");
		assert.match(messages[0].content, /expires at/);
		assert.match(messages[0].content, /may already be stale/);
		const blockedWait = await waitForSubagents({ id: initial.details.runId, timeoutMs: 300, stopOnAttention: false }, undefined, { state: fixture.state });
		assert.match(text(blockedWait), /needs_attention/, "a supervisor ask always yields, even with stopOnAttention:false");
		if (!expires) await supervisor.execute("reply", { action: "reply", replyTo: requestId, message: "Approved" });
		await childCompletion;
		channel.activateTransport();
		const final = await waitForSubagents({ id: initial.details.runId, timeoutMs: 1000 }, undefined, { state: fixture.state, pollIntervalMs: 10 });
		assert.match(text(final), expires ? /DECISION EXPIRED/ : /REAL ANSWER AFTER REPLY/);
		assert.equal(fixture.state.foregroundWorkflows.get(initial.details.runId).requests.size, 0);
		assert.equal((await supervisor.execute("pending-again", { action: "pending" })).details.pending.length, 0);
		const late = await supervisor.execute("late-reply", { action: "reply", replyTo: requestId, message: "too late" });
		assert.equal(late.isError, true);
		assert.equal(late.details.delivered, false);
		assert.match(text(late), /no longer pending/);
	});
}
