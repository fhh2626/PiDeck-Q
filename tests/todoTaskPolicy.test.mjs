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

test("goal policy counts distinct completed ids, not list churn or failed turns", () => {
	const initial = policy.recordTodoMutation(policy.createTodoTask("one", "todo-goal", "Task"), "add");
	const progressed = policy.decideGoalBoundary(initial, [item(1, true), item(2)], "completed").task;
	assert.equal(progressed.stalls, 0);
	const failed = policy.decideGoalBoundary(progressed, [item(1, true), item(2, true), item(3)], "error").task;
	assert.equal(failed.stalls, 1);
	assert.deepEqual(plain(failed.completedIds), [1, 2]);
	assert.equal(policy.decideGoalBoundary(failed, [item(1, true), item(2, true), item(3)], "completed").task.stalls, 2);
	assert.equal(policy.decideGoalBoundary(failed, [item(1, true), item(2, true), item(3, true), item(4)], "completed").task.stalls, 0);
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

test("extension task copy provides both host-selected languages without importing renderer code", () => {
	const { todoTaskCopy } = loadTsCommonJs("resources/extensions/pi-deck-todo/copy.ts");
	assert.match(todoTaskCopy("en-US").paused, /paused.*3/);
	assert.match(todoTaskCopy("zh-CN").paused, /3.*暂停/);
	assert.deepEqual(Object.keys(todoTaskCopy("en-US")).sort(), Object.keys(todoTaskCopy("zh-CN")).sort());
});
