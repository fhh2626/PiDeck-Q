import assert from "node:assert/strict";
import test from "node:test";
import { createTodoHarness } from "./helpers/todoExtensionHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const { reconcileOptimisticUserMessages } = loadTsCommonJs("src/renderer/src/utils/optimisticUserReconciliation.ts");

/** Drive the real host send/event boundary without starting a pi process. */
function managerFor(t) {
	const manager = new AgentManager(
		() => ({ id: "project", name: "Project", path: "/project" }),
		() => null, { get: () => ({ rpcTimeout: 30_000 }) }, {},
		undefined, undefined, undefined, (key) => key,
	);
	manager.agents.set("agent", {
		tab: { id: "agent", projectId: "project", cwd: "/project", title: "Session", status: "idle", createdAt: 1 },
		process: { isRunning: () => true, stop() {}, client: { request: async () => ({ success: true, data: {} }) } },
	});
	t.after(() => manager.stopAll());
	return manager;
}

const rawTask = (message, timestamp = 1000) => ({ ...message, role: "custom", timestamp });
const project = (message) => new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false })
	.convert("agent", [rawTask(message)], ["task-entry"])[0];

for (const commandName of ["todo", "todo-goal"]) {
	test(`${commandName} persists its command identity while keeping the model goal neutral`, async () => {
		const h = createTodoHarness();
		await h.command(commandName, "Inspect the parser");
		const message = h.messages[0].message;
		assert.equal(message.content, "Inspect the parser");
		assert.equal(message.details.commandName, commandName);
		assert.equal(message.details.commandArgs, "Inspect the parser");
		const row = project(message);
		assert.equal(row.text, `/${commandName} Inspect the parser`);
		assert.equal(row.role, "system", "a custom task must keep its real read-only entry kind");
		assert.equal(row.meta.entryId, "task-entry");
	});
}

test("live todo-goal replaces its pending slash row and replay keeps exactly one command", async (t) => {
	const manager = managerFor(t);
	await manager.sendPrompt({ agentId: "agent", requestId: "request", message: "/todo-goal Inspect the parser" });
	const pendingId = manager.messages.get("agent")[0].id;
	const h = createTodoHarness();
	await h.command("todo-goal", "Inspect the parser");
	const event = { type: "message_end", message: rawTask(h.messages[0].message) };
	manager.handlePiEvent("agent", event);
	manager.handlePiEvent("agent", event);
	const rows = manager.messages.get("agent");
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, pendingId, "acknowledgement must retain the visible row identity");
	assert.equal(rows[0].text, "/todo-goal Inspect the parser");
	assert.equal(rows[0].role, "system");
	assert.equal(rows[0].meta.optimisticRequestId, "request");
});

test("argument-less goals keep the resolved task and replace only their own command", async (t) => {
	const manager = managerFor(t);
	await manager.sendPrompt({ agentId: "agent", requestId: "empty-args", message: "/todo-goal" });
	const h = createTodoHarness();
	h.state.answer = "Inspect the parser";
	await h.command("todo-goal");
	manager.handlePiEvent("agent", { type: "message_end", message: rawTask(h.messages[0].message) });
	const rows = manager.messages.get("agent");
	assert.equal(rows.length, 1);
	assert.equal(rows[0].text, "/todo-goal Inspect the parser");
	assert.equal(rows[0].meta.optimisticRequestId, "empty-args");
	assert.equal(project(h.messages[0].message).text, rows[0].text, "reload must keep the command and clarified goal");
});

test("todo-resume keeps its command identity and acknowledges only its own pending guidance", async (t) => {
	const manager = managerFor(t);
	const h = createTodoHarness();
	await h.command("todo-goal", "Inspect the parser");
	await h.runTool("todo_goal_blocked", { reason: "Missing access", needs: "Grant access" });
	await manager.sendPrompt({ agentId: "agent", requestId: "resume", message: "/todo-resume Access granted" });
	await h.command("todo-resume", "Access granted");
	const message = h.messages.at(-1).message;
	assert.equal(message.content, "Access granted");
	assert.equal(message.details.commandName, "todo-resume");
	manager.handlePiEvent("agent", { type: "message_end", message: rawTask(message) });
	const rows = manager.messages.get("agent");
	assert.equal(rows.length, 1);
	assert.equal(rows[0].text, "/todo-resume Access granted");
	assert.equal(rows[0].meta.todoTaskKind, "resume");
	assert.equal(rows[0].meta.optimisticRequestId, "resume");
});

test("an old task replay cannot consume a later identical command", async (t) => {
	const manager = managerFor(t);
	const h = createTodoHarness();
	await manager.sendPrompt({ agentId: "agent", requestId: "first", message: "/todo-goal Inspect the parser" });
	await h.command("todo-goal", "Inspect the parser");
	const first = rawTask(h.messages[0].message);
	manager.handlePiEvent("agent", { type: "message_end", message: first });
	manager.handlePiEvent("agent", { type: "agent_settled" });
	await manager.sendPrompt({ agentId: "agent", requestId: "second", message: "/todo-goal Inspect the parser" });
	manager.handlePiEvent("agent", { type: "message_end", message: first });
	assert.equal(manager.messages.get("agent")[1].role, "user");
	await h.command("todo-goal", "Inspect the parser");
	manager.handlePiEvent("agent", { type: "message_end", message: rawTask(h.messages.at(-1).message, 2000) });
	const rows = manager.messages.get("agent");
	assert.equal(rows.length, 2);
	assert.deepEqual(Array.from(rows, (row) => row.meta.optimisticRequestId), ["first", "second"]);
	assert.ok(rows.every((row) => row.meta.type === "todoTask"));
});

test("a task cannot consume a different pending command or an unrelated same-text user turn", async (t) => {
	const manager = managerFor(t);
	await manager.sendPrompt({ agentId: "agent", requestId: "different", message: "/todo-goal Another task" });
	const h = createTodoHarness();
	await h.command("todo-goal", "Inspect the parser");
	manager.handlePiEvent("agent", { type: "message_end", message: rawTask(h.messages[0].message) });
	assert.equal(manager.messages.get("agent").length, 2);
	assert.equal(manager.messages.get("agent")[0].text, "/todo-goal Another task");
});

test("legacy task history remains visible without inventing the original command", () => {
	const legacy = { customType: "pi-deck-todo-task-start", content: "Inspect the parser", display: true,
		details: { taskId: "legacy", messageId: "legacy-start" } };
	assert.equal(project(legacy).text, "Inspect the parser");
});

test("malformed command metadata cannot relabel a legacy task", () => {
	const legacy = { customType: "pi-deck-todo-task-start", content: "Inspect the parser", display: true };
	for (const details of [
		{ commandName: "todo-resume", commandArgs: "Inspect the parser" },
		{ commandName: "other", commandArgs: "Inspect the parser" },
		{ commandName: "todo-goal", commandArgs: 1 },
	]) assert.equal(project({ ...legacy, details }).text, "Inspect the parser");
});

test("a task acknowledgement reconciles its optimistic user by request identity", () => {
	const local = { id: "request", agentId: "agent", role: "user", text: "/todo-goal Inspect the parser", timestamp: 1,
		meta: { optimistic: true, optimisticPending: true, optimisticRequestId: "request" } };
	const canonical = { id: "task", agentId: "agent", role: "system", text: "/todo-goal Inspect the parser", timestamp: 2,
		meta: { type: "todoTask", optimisticRequestId: "request" } };
	assert.deepEqual(Array.from(reconcileOptimisticUserMessages([local], [canonical]).droppedIds), ["request"]);
});
