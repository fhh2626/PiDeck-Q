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

for (const [label, text, response] of [
	["ordinary text", "Please work on this", undefined],
	["an unregistered command", "/unknown", undefined],
	["a prompt template", "/todo-resume", { success: true, data: { commands: [{ name: "todo-resume", source: "prompt" }] } }],
	["a failed command lookup", "/todo-resume", { success: false, error: "lookup failed" }],
]) {
	test(`Node silent dispatch rejects ${label} before writing a prompt`, async (t) => {
		const session = start(t, (request) => request.type === "get_commands" ? response : undefined);
		const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: text, silent: true });
		assert.equal(result.accepted, false);
		assert.equal(result.i18nKey, "sessionCommand.silentUnavailable");
		assert.notEqual(result.delivery, "unknown");
		assert.equal(session.calls.filter((request) => request.type === "prompt").length, 0);
		assert.equal(session.runtime.tab.status, "idle");
	});
}

for (const failedLookup of [1, 2]) {
	test(`Node silent dispatch ignores command data from failed lookup ${failedLookup}`, async (t) => {
		let lookups = 0;
		const session = start(t, (request) => request.type === "get_commands" && ++lookups === failedLookup
			? { success: false, error: "registration unavailable", data: COMMANDS.data } : undefined);
		const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/todo-resume", silent: true });
		assert.equal(result.accepted, false);
		assert.equal(result.i18nKey, "sessionCommand.silentUnavailable");
		assert.notEqual(result.delivery, "unknown");
		assert.equal(session.calls.filter((request) => request.type === "prompt").length, 0);
		assert.equal(session.runtime.tab.status, "idle");
	});
}

test("Node silent dispatch accepts a registered extension command while idle", async (t) => {
	const session = start(t);
	const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/todo-resume", silent: true });
	assert.equal(result.accepted, true);
	const prompts = session.calls.filter((request) => request.type === "prompt");
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].message, "/todo-resume");
	assert.equal(session.runtime.tab.status, "idle");
});

for (const prefix of ["!", "!!"]) {
	test(`Node silent dispatch cannot bypass command validation with ${prefix}`, async (t) => {
		const session = start(t);
		const result = await session.manager.sendPrompt({ agentId: "agent-1", message: `${prefix} echo local`, silent: true });
		assert.equal(result.accepted, false);
		assert.equal(result.i18nKey, "sessionCommand.silentUnavailable");
		assert.equal(session.calls.filter((request) => request.type === "prompt" || request.type === "bash").length, 0);
		assert.equal(session.runtime.tab.status, "idle");
	});
}

test("Node silent dispatch refuses a registered command while the runtime is busy", async (t) => {
	const session = start(t);
	assert.equal((await session.send("Work in progress")).accepted, true);
	const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/todo-resume", silent: true });
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "sessionCommand.silentBusy");
	assert.equal(session.calls.filter((request) => request.type === "prompt").length, 1);
	assert.equal(session.runtime.tab.status, "running");
});

test("Node a failed command lookup keeps ordinary slash prompts available", async (t) => {
	const session = start(t, (request) => request.type === "get_commands" ? { success: false, error: "lookup failed" } : undefined);
	assert.equal((await session.send("/unregistered")).accepted, true);
	assert.equal(session.calls.filter((request) => request.type === "prompt").length, 1);
});

test("Node ordinary slash dispatch ignores failed command data when scheduling idle", async (t) => {
	const session = start(t, (request) => request.type === "get_commands"
		? { success: false, error: "registration unavailable", data: COMMANDS.data } : undefined);
	assert.equal((await session.send("/todo-resume")).accepted, true);
	assert.equal(session.calls.filter((request) => request.type === "prompt").length, 1);
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "running", "a failed lookup cannot prove the input completed outside a model turn");
});

for (const blockedLookup of [1, 2]) {
	test(`Node silent dispatch rechecks busy state after command lookup ${blockedLookup}`, async (t) => {
		const lookup = deferred();
		let lookups = 0;
		const session = start(t, (request) => request.type === "get_commands" && ++lookups === blockedLookup ? lookup.promise : undefined);
		const pending = session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/todo-resume", silent: true });
		await flush();
		assert.equal((await session.send("New task")).accepted, true);
		lookup.resolve(COMMANDS);
		const result = await pending;
		assert.equal(result.accepted, false);
		assert.equal(result.i18nKey, "sessionCommand.silentBusy");
		assert.equal(session.calls.filter((request) => request.type === "prompt").length, 1);
		assert.equal(session.runtime.tab.status, "running");
	});
}

for (const [label, response] of [
	["lost registration", { success: true, data: { commands: [] } }],
	["failed lookup", { success: false, error: "lookup failed" }],
]) {
	test(`Node silent dispatch requires registration at the final lookup after ${label}`, async (t) => {
		let lookups = 0;
		const session = start(t, (request) => request.type === "get_commands" && ++lookups === 2 ? response : undefined);
		const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/todo-resume", silent: true });
		assert.equal(result.accepted, false);
		assert.equal(result.i18nKey, "sessionCommand.silentUnavailable");
		assert.equal(session.calls.filter((request) => request.type === "prompt").length, 0);
		assert.equal(session.runtime.tab.status, "idle");
	});
}

test("Node a rejected silent command leaves the previous completion probe valid", async (t) => {
	const session = start(t);
	assert.equal((await session.send("/todo-resume")).accepted, true);
	const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/unknown", silent: true });
	assert.equal(result.accepted, false);
	t.mock.timers.tick(100);
	await flush();
	assert.equal(session.runtime.tab.status, "idle");
	assert.equal(session.calls.filter((request) => request.type === "prompt").length, 1);
});

for (const [label, response] of [
	["lost registration", { success: true, data: { commands: [] } }],
	["failed lookup", { success: false, error: "registration unavailable", data: COMMANDS.data }],
]) {
	test(`Node error settlement survives rejected silent ${label}`, async (t) => {
		let lookups = 0;
		const session = start(t, (request) => request.type === "get_commands" && ++lookups === 2 ? response : undefined);
		const localEvents = [];
		t.after(session.manager.addLocalEventListener((_agentId, event) => localEvents.push(event)));
		assert.equal((await session.send("Work")).accepted, true);
		session.manager.handlePiEvent("agent-1", { type: "agent_end", errorMessage: "Model failed", messages: [] });
		await flush();
		assert.equal(session.runtime.tab.status, "error");
		const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/todo-resume", silent: true });
		assert.equal(result.accepted, false);
		assert.equal(result.i18nKey, "sessionCommand.silentUnavailable");
		t.mock.timers.tick(5_000);
		await flush();
		assert.equal(session.runtime.tab.status, "error", "settlement retains the failed turn's visible state");
		assert.equal(localEvents.filter((event) => event.type === "agent_settled").length, 1,
			"an undispatched silent input must preserve the final event that closes the prior stream");
		assert.equal(session.calls.filter((request) => request.type === "prompt").length, 1);
	});
}

test("Node silent dispatch cannot enter while an ordinary prompt still awaits its ACK", async (t) => {
	const ack = deferred();
	const session = start(t, (request) => request.type === "prompt" ? ack.promise : undefined);
	const pending = session.send("New task");
	await flush();
	try {
		const result = await session.manager.sendPrompt({ agentId: "agent-1", message: "", agentMessage: "/todo-resume", silent: true });
		assert.equal(result.accepted, false);
		assert.equal(result.i18nKey, "sessionCommand.silentBusy");
		assert.equal(session.calls.filter((request) => request.type === "prompt").length, 1);
		assert.equal(session.runtime.tab.status, "running");
	} finally {
		ack.resolve({ success: true });
		assert.equal((await pending).accepted, true);
	}
});

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
