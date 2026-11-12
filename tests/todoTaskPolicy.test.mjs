import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const policy = loadTsCommonJs("resources/extensions/pi-deck-todo/task.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const item = (id, done = false) => ({ id, text: `Step ${id}`, done });

test("goal policy is pure and requires a nonempty successfully-created checklist", () => {
	const initial = policy.createTodoTask("one", "todo-goal", "Task");
	const before = plain(initial);
	assert.equal(policy.decideGoalBoundary(initial, [], "completed").action, "continue");
	assert.deepEqual(plain(initial), before);
	assert.equal(policy.decideGoalBoundary(initial, [item(1, true)], "completed").action, "continue");
	const created = policy.recordTodoMutation(initial, "add");
	assert.equal(policy.decideGoalBoundary(created, [item(1, true)], "completed").action, "complete");
	assert.equal(policy.decideGoalBoundary(created, [], "completed").action, "continue");
});

test("normal unfinished responses reset consecutive errors regardless of checklist progress", () => {
	const initial = policy.recordTodoMutation(policy.createTodoTask("one", "todo-goal", "Task"), "add");
	const failed = policy.decideGoalBoundary(initial, [item(1), item(2)], "error").task;
	assert.equal(failed.consecutiveErrors, 1);
	const recovered = policy.decideGoalBoundary(failed, [item(1), item(2)], "completed");
	assert.equal(recovered.action, "continue");
	assert.equal(recovered.task.consecutiveErrors, 0);
});

test("recent task resolution handles string content, command arguments and explicit command history", () => {
	assert.equal(policy.recentTodoTask([{ type: "message", message: { role: "user", content: "First task" } }]), "First task");
	assert.equal(policy.recentTodoTask([{ type: "message", message: { role: "user", content: "/todo-goal Fix it\nThen test it" } }]), "Fix it\nThen test it");
	assert.equal(policy.recentTodoTask([
		{ type: "message", message: { role: "user", content: "First task" } },
		{ type: "message", message: { role: "user", content: "Newer explicit task" } },
		{ type: "message", message: { role: "user", content: "/todo" } },
	]), "Newer explicit task");
	assert.equal(policy.recentTodoTask([null, { type: "message", message: { role: "user", content: [{ type: "image" }] } }]), "");
});

test("resume instructions never ask for a fresh checklist once one exists", () => {
	const created = policy.recordTodoMutation(policy.createTodoTask("one", "todo-goal", "Task"), "add");
	const todos = [item(1), item(2)];
	assert.match(policy.todoTaskInstructions(created, todos), /Continue the existing checklist/);
	assert.doesNotMatch(policy.todoTaskInstructions(created, todos), /create a fresh checklist/);
	assert.match(policy.todoTaskInstructions(policy.createTodoTask("two", "todo-goal", "Task"), []), /create a fresh checklist/);
	assert.match(policy.todoTaskInstructions(created, todos), /do not clear or rebuild/);
});

test("an authorized clear keeps completed identity and asks for the remaining work only", () => {
	const created = policy.recordTodoMutation(policy.createTodoTask("one", "todo-goal", "Task"), "add");
	const cleared = policy.recordTodoMutation(created, "clear", [{ id: 1, text: "Step 1" }]);
	const instructions = policy.todoTaskInstructions(cleared, []);
	assert.match(instructions, /already completed and must not be repeated: #1 Step 1/);
	assert.doesNotMatch(instructions, /create a fresh checklist/);
	const continuation = policy.todoContinuation(cleared, []);
	assert.match(continuation, /cleared/);
	assert.match(continuation, /#1 Step 1/);
	// Re-adding steps keeps the recorded identity instead of dropping it.
	assert.deepEqual(plain(policy.recordTodoMutation(cleared, "add").clearedCompleted), [{ id: 1, text: "Step 1" }]);
	assert.match(policy.todoTaskInstructions(cleared, [item(3)]), /Continue the existing checklist/);
});

test("extension task copy provides both host-selected languages without importing renderer code", () => {
	const { todoTaskCopy } = loadTsCommonJs("resources/extensions/pi-deck-todo/copy.ts");
	assert.match(todoTaskCopy("en-US").paused, /paused.*3/);
	assert.match(todoTaskCopy("zh-CN").paused, /3.*暂停/);
	assert.deepEqual(Object.keys(todoTaskCopy("en-US")).sort(), Object.keys(todoTaskCopy("zh-CN")).sort());
});
