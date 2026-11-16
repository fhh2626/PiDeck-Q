import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const IDLE = { success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } };
const COMMANDS = { success: true, data: { commands: [{ name: "todo-resume", source: "extension" }] } };

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

async function flush() {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function start(t, respond) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
	const calls = [];
	const makeProcess = (handler = respond) => {
		const process = {
			isRunning: () => true,
			client: {
				request: async (request) => {
					calls.push({ process, ...request });
					const selected = handler?.(request);
					if (selected !== undefined) return selected;
					if (request.type === "get_state") return IDLE;
					if (request.type === "get_commands") return COMMANDS;
					return { success: true, data: {} };
				},
			},
		};
		return process;
	};
	const runtime = {
		tab: { id: "agent-1", projectId: "project-1", cwd: "C:/project", title: "Session", status: "idle", createdAt: 1 },
		process: makeProcess(),
	};
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null, { get: () => ({ rpcTimeout: 30_000 }) }, {},
	);
	manager.agents.set("agent-1", runtime);
	const send = (message, requestId = message) => manager.sendPrompt({ agentId: "agent-1", message, requestId });
	return { manager, runtime, calls, makeProcess, send };
}

test("Node extension timer waits for a newer command lookup", async (t) => {
	const lookup = deferred();
	let lookups = 0;
	const session = start(t, (request) => request.type === "get_commands" && ++lookups === 2 ? lookup.promise : undefined);
	assert.equal((await session.send("/todo-resume", "first")).accepted, true);
	const pending = session.send("/todo-resume", "next");
	await flush();
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "running");
	lookup.resolve(COMMANDS);
	assert.equal((await pending).accepted, true);
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "idle", "the current completed command still gets an idle confirmation");
});

for (const accepted of [true, false]) {
	test(`Node late ${accepted ? "accepted" : "rejected"} command ACK preserves newer work`, async (t) => {
		const ack = deferred();
		let prompts = 0;
		const session = start(t, (request) => request.type === "prompt" && ++prompts === 1 ? ack.promise : undefined);
		const first = session.send("/todo-resume", "first");
		await flush();
		assert.equal((await session.send("Next task", "next")).accepted, true);
		ack.resolve({ success: accepted, data: {}, error: accepted ? undefined : "rejected" });
		assert.equal((await first).accepted, accepted);
		t.mock.timers.tick(100);
		await flush();
		assert.equal(session.runtime.tab.status, "running");
	});
}

test("Node command lookup cannot dispatch into a replacement process", async (t) => {
	const lookup = deferred();
	const session = start(t, (request) => request.type === "get_commands" ? lookup.promise : undefined);
	const pending = session.send("/todo-resume");
	await flush();
	session.runtime.process = session.makeProcess(() => undefined);
	session.runtime.tab.status = "starting";
	lookup.resolve(COMMANDS);
	const result = await pending;
	assert.equal(result.accepted, false);
	assert.notEqual(result.delivery, "unknown", "the input was never dispatched");
	assert.equal(session.calls.some((request) => request.type === "prompt"), false);
	assert.equal(session.runtime.tab.status, "starting");
});

test("Node command ACK cannot update a replacement process or arm its idle timer", async (t) => {
	const ack = deferred();
	const session = start(t, (request) => request.type === "prompt" ? ack.promise : undefined);
	const pending = session.send("/todo-resume");
	await flush();
	const replacement = session.makeProcess(() => undefined);
	session.runtime.process = replacement;
	session.runtime.tab.status = "running";
	ack.resolve({ success: true, data: {} });
	const result = await pending;
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "unknown");
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "running");
	assert.equal(session.calls.some((request) => request.process === replacement), false);
});

test("Node rejected newer input can still settle the completed prior command", async (t) => {
	let prompts = 0;
	const session = start(t, (request) => request.type === "prompt" && ++prompts === 2 ? { success: false, error: "rejected" } : undefined);
	assert.equal((await session.send("/todo-resume", "first")).accepted, true);
	assert.equal((await session.send("Next task", "next")).accepted, false);
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "idle");
});

test("Node overlapping commands wait for all ACKs and then settle", async (t) => {
	const ack = deferred();
	let prompts = 0;
	const session = start(t, (request) => request.type === "prompt" && ++prompts === 1 ? ack.promise : undefined);
	const first = session.send("/todo-resume", "first");
	await flush();
	assert.equal((await session.send("/todo-resume", "next")).accepted, true);
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "running");
	ack.resolve({ success: true, data: {} });
	await first;
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "idle");
});

test("Node old idle response cannot settle a bash command while its RPC is pending", async (t) => {
	const state = deferred();
	const bash = deferred();
	let polls = 0;
	const session = start(t, (request) => {
		if (request.type === "get_state" && ++polls === 1) return state.promise;
		if (request.type === "bash") return bash.promise;
	});
	session.runtime.tab.status = "running";
	const idle = session.manager.markIdleIfPiReportsNoWork("agent-1");
	const pending = session.send("! sleep 1");
	state.resolve(IDLE);
	await idle;
	try {
		assert.equal(session.runtime.tab.status, "running", "the newer bash request invalidates the earlier snapshot");
	} finally {
		bash.resolve({ success: true, data: { output: "done", exitCode: 0 } });
		await pending;
	}
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "idle", "the prior completed task is confirmed after bash finishes");
});

test("Node late bash completion cannot return a newer prompt to idle", async (t) => {
	const bash = deferred();
	const session = start(t, (request) => request.type === "bash" ? bash.promise : undefined);
	const first = session.send("! sleep 1");
	assert.equal((await session.send("Next task", "next")).accepted, true);
	bash.resolve({ success: true, data: { output: "done", exitCode: 0 } });
	assert.equal((await first).accepted, true);
	assert.equal(session.runtime.tab.status, "running");
});

for (const [label, event] of [
	["ask", { type: "extension_ui_request", id: "late-ask", method: "input", title: "Still waiting" }],
	["assistant", { type: "message_start", message: { role: "assistant", content: [] } }],
	["tool", { type: "tool_execution_start", toolCallId: "late-tool", toolName: "read", args: { path: "file.txt" } }],
]) {
	test(`Node idle confirmation rechecks a new ${label} event after its state round trip`, async (t) => {
		const state = deferred();
		const session = start(t, (request) => request.type === "get_state" ? state.promise : undefined);
		session.runtime.tab.status = "running";
		const pending = session.manager.markIdleIfPiReportsNoWork("agent-1");
		session.manager.handlePiEvent("agent-1", event);
		state.resolve(IDLE);
		await pending;
		assert.equal(session.runtime.tab.status, "running", "the new event supersedes the older no-work snapshot");
	});
}
