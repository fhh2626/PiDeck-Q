import assert from "node:assert/strict";
import test from "node:test";
import { createTodoHarness } from "./helpers/todoExtensionHarness.mjs";

const content = (result) => result?.entries?.map((entry) => entry.content).join("\n") ?? "";

/** Start a command and create an unfinished list without relying on private state. */
async function goalHarness() {
	const harness = createTodoHarness();
	await harness.command("todo-goal", "Fix the parser and test it");
	await harness.run({ action: "add", text: "Fix parser" });
	await harness.run({ action: "add", text: "Test parser" });
	return harness;
}

test("todo and todo-goal are task commands, independent of plan-progress", () => {
	const h = createTodoHarness();
	assert.deepEqual([...h.commands.keys()].sort(), ["todo", "todo-goal", "todo-resume"]);
});

test("/todo starts the supplied task with transient todo instructions", async () => {
	const h = createTodoHarness();
	await h.command("todo", "Implement the endpoint");
	assert.equal(h.messages.length, 1);
	assert.match(h.messages[0].message.content, /Implement the endpoint/);
	assert.equal(h.messages[0].options.triggerTurn, true);
	const injected = await h.emit("before_agent_start", { messageType: "custom", message: h.messages[0].message });
	assert.match(injected.message.content, /todo/i);
	assert.match(injected.message.content, /ask_question/i);
	assert.equal(injected.message.display, false);
	assert.equal(await h.boundary(), undefined, "ordinary todo never continues automatically");
});

test("an explicit command resets old items even though Pi dispatches commands before input", async () => {
	const h = createTodoHarness();
	await h.run({ action: "add", text: "Old task" });
	await h.command("todo", "New task");
	const result = await h.run({ action: "list" });
	assert.equal(result.details.todos.length, 0);
});

test("an argument-less command uses the latest user task on the current branch", async () => {
	const h = createTodoHarness({ branch: [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the API" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Ignore me" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "/todo" }] } },
	] });
	await h.command("todo");
	assert.match(h.messages[0].message.content, /Fix the API/);
	assert.doesNotMatch(h.messages[0].message.content, /Ignore me/);
});

test("a missing task is clarified before starting; cancelling preserves the old list", async () => {
	const h = createTodoHarness();
	await h.run({ action: "add", text: "Keep this" });
	await h.command("todo-goal");
	assert.equal(h.messages.length, 0);
	assert.equal((await h.run({ action: "list" })).details.todos[0].text, "Keep this");
	h.state.answer = "Implement a cache";
	await h.command("todo-goal");
	assert.match(h.messages[0].message.content, /Implement a cache/);
});

test("a running agent rejects a task command without replacing the current goal", async () => {
	const h = await goalHarness();
	h.state.idle = false;
	await h.command("todo", "Replace goal");
	assert.equal(h.messages.length, 1);
	assert.equal((await h.boundary()).continue, true);
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /Fix the parser and test it/);
});

test("goal clarification stays available until the first successful add", async () => {
	const h = createTodoHarness();
	await h.command("todo-goal", "Build it");
	assert.equal(await h.ask(), undefined);
	await h.run({ action: "add", text: "   " });
	assert.equal(await h.ask(), undefined, "a failed add must not lock questions");
	await h.run({ action: "list" });
	assert.equal(await h.ask(), undefined);
	await h.run({ action: "add", text: "Build" });
	assert.equal((await h.ask()).block, true);
});

test("ordinary todo injects its rules for read-only work while plan mode is active", async () => {
	const h = createTodoHarness();
	h.publishPlanState(true);
	await h.command("todo", "Inspect without editing");
	const injected = await h.emit("before_agent_start", { messageType: "custom", message: h.messages.at(-1).message });
	assert.match(injected.message.content, /TODO TASK: todo\]/);
	assert.equal(await h.boundary(), undefined);
});

test("ordinary todo cannot replace a suspended goal while plan mode owns its checklist", async () => {
	const h = await goalHarness();
	h.publishPlanState(true);
	h.pause();
	await h.command("todo", "Inspect something else");
	assert.equal(h.messages.length, 1);
	assert.equal((await h.run({ action: "list" })).details.todos.length, 2);
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /Fix the parser and test it/);
});

test("resume without a goal reports unavailable even while plan mode is active", async () => {
	const h = createTodoHarness();
	h.publishPlanState(true);
	await h.command("todo-resume");
	assert.match(h.notifications.at(-1).text, /There is no paused todo goal/);
});

test("ordinary todo allows questions after adding items", async () => {
	const h = createTodoHarness();
	await h.command("todo", "Build it");
	await h.run({ action: "add", text: "Build" });
	assert.equal(await h.ask(), undefined);
});

test("clearing a goal list neither unlocks questions nor marks the task complete", async () => {
	const h = await goalHarness();
	await h.run({ action: "clear" });
	assert.equal((await h.ask()).block, true);
	const result = await h.boundary();
	assert.equal(result.continue, true);
	assert.match(content(result), /rebuild only the remaining work/i);
	const injected = await h.emit("before_agent_start", {});
	assert.match(injected.message.content, /rebuild only the remaining work/i);
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /rebuild only the remaining work/i);
});

test("unfinished goals continue with a short instruction and context tool reference", async () => {
	const h = await goalHarness();
	await h.run({ action: "toggle", id: 1 });
	const result = await h.boundary();
	assert.equal(result.continue, true);
	assert.doesNotMatch(content(result), /Fix the parser and test it|Test parser/);
	assert.match(content(result), /todo_goal_context/);
	assert.match(content(result), /not.*(reset|rebuild)|do not.*(reset|rebuild)/i);
	assert.equal(h.messages.length, 1, "continuation belongs to the Pi boundary, not another prompt RPC");
});

test("goal creation is required: an empty list is not successful completion", async () => {
	const h = createTodoHarness();
	await h.command("todo-goal", "Build it");
	assert.equal((await h.boundary()).continue, true);
});

test("a completed list finishes without clearing the widget or retaining task restrictions", async () => {
	const h = await goalHarness();
	await h.run({ action: "toggle", id: 1 });
	await h.run({ action: "toggle", id: 2 });
	assert.equal(await h.boundary(), undefined);
	assert.match(h.widgets.at(-1).join("\n"), /☑ #1/);
	assert.equal(await h.ask(), undefined);
	assert.equal(await h.emit("before_agent_start", {}), undefined);
});

test("unfinished goals continue after repeated normal replies without tool activity", async () => {
	const h = await goalHarness();
	for (let index = 0; index < 15; index++) {
		assert.equal((await h.boundary())?.continue, true);
	}
	await h.run({ action: "toggle", id: 1 });
	await h.run({ action: "toggle", id: 2 });
	assert.equal(await h.boundary(), undefined);
});

test("a normal reply resets consecutive provider errors", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	assert.equal((await h.boundary()).continue, true);
	assert.equal((await h.boundary("error")).continue, true);
	assert.equal((await h.boundary("error")).continue, true);
	assert.equal(await h.boundary("error"), undefined);
});

test("goal context tool returns the current goal and complete checklist without mutations", async () => {
	const h = await goalHarness();
	await h.run({ action: "toggle", id: 1 });
	const before = h.snapshots.length;
	const result = await h.runTool("todo_goal_context");
	const text = JSON.stringify(result);
	assert.match(text, /Fix the parser and test it/);
	assert.match(text, /Fix parser/);
	assert.match(text, /Test parser/);
	assert.equal(h.snapshots.length, before);
});

test("blocked goal pauses and resume preserves its checklist and accepts user guidance", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access", needs: "Grant access" });
	assert.equal(await h.boundary(), undefined);
	assert.ok(h.notifications.some(({ text }) => /Missing access/.test(text) && /Grant access/.test(text)));
	assert.equal((await h.emit("tool_call", { toolName: "edit" })).block, true);
	assert.equal(await h.emit("tool_call", { toolName: "todo_goal_context" }), undefined);
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /Goal is blocked: Missing access \(needs: Grant access\)/);
	await h.command("todo-resume", "Access granted");
	assert.match(JSON.stringify(h.messages.at(-1)), /Access granted/);
	const start = await h.emit("before_agent_start", { messageType: "custom", message: h.messages.at(-1).message });
	assert.match(start.message.content, /TODO TASK: todo-goal/);
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /Test parser/);
	assert.equal((await h.boundary()).continue, true);
});

test("a natural reply to a blocked goal keeps the goal and checklist and resumes it", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access", needs: "Grant access" });
	// Pi emits input before the run starts; a blocked goal must not treat the reply as new work.
	await h.emit("input", { source: "interactive", text: "Access granted" });
	assert.deepEqual(Array.from((await h.run({ action: "list" })).details.todos, (item) => item.text),
		["Fix parser", "Test parser"], "the checklist survives the reply");
	const resumed = await h.emit("before_agent_start", { messageType: "user", prompt: "Access granted" });
	assert.match(resumed.message.content, /TODO TASK: todo-goal/);
	assert.equal(await h.emit("tool_call", { toolName: "edit" }), undefined, "resuming releases the tool block");
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /Goal is active\./);
	assert.equal((await h.boundary()).continue, true);
});

test("resume stays blocked until the resuming run actually starts", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	// pi.sendMessage is fire-and-forget: a send that never starts a run must not unblock.
	await h.command("todo-resume", "Access granted");
	assert.equal((await h.emit("tool_call", { toolName: "edit" })).block, true);
	assert.equal(await h.boundary(), undefined, "no continuation without a confirmed run");
	await h.command("todo-resume", "Access granted");
	assert.equal(h.messages.filter(({ message }) => message.customType === "pi-deck-todo-task-resume").length, 2,
		"the blocker stays retryable");
});

test("a synchronous resume send failure keeps the goal blocked instead of pretending success", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	h.state.failSend = true;
	await h.command("todo-resume", "Access granted");
	assert.equal(h.messages.length, 1, "only the goal start was sent");
	assert.ok(h.notifications.some(({ type }) => type === "error"));
	assert.equal((await h.emit("tool_call", { toolName: "edit" })).block, true);
	assert.equal(await h.boundary(), undefined);
});

test("goal tools reject calls without an active goal", async () => {
	const h = createTodoHarness();
	await assert.rejects(() => h.runTool("todo_goal_context"));
	await assert.rejects(() => h.runTool("todo_goal_blocked", { reason: "Missing access" }));
});

test("goal tools refuse third-party todo ownership and reject empty blockers", async () => {
	const h = await goalHarness();
	await assert.rejects(() => h.runTool("todo_goal_blocked", { reason: "   " }));
	assert.equal((await h.boundary()).continue, true);
	h.state.ownsTodo = false;
	await assert.rejects(() => h.runTool("todo_goal_context"));
	await assert.rejects(() => h.runTool("todo_goal_blocked", { reason: "Missing access" }));
});

test("continuation preserves other extensions' boundary entries", async () => {
	const h = await goalHarness();
	const entry = { type: "custom_message", customType: "other", content: "Other extension", display: false };
	const result = await h.boundary("completed", { entries: [entry] });
	assert.equal(result.entries.length, 2);
	assert.equal(result.entries[0], entry);
});

test("plan pause keeps the blocker without letting resume take over the turn", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	h.pause();
	await h.command("todo-resume", "Access granted");
	assert.equal(h.messages.length, 1, "plan mode owns the turn");
	assert.ok(h.notifications.some(({ text }) => /plan mode/i.test(text)), "the blocker is still reported, not erased");
	assert.equal(await h.boundary(), undefined);
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Continue" }), undefined);
});

test("explicit plan release makes the preserved blocker resumable in the same session", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	h.pause();
	h.releasePlan("another-session");
	await h.command("todo-resume", "Access granted");
	assert.equal(h.messages.length, 1);
	h.releasePlan();
	await h.command("todo-resume", "Access granted");
	assert.equal(h.messages.length, 2);
	await h.emit("before_agent_start", { messageType: "custom", message: h.messages.at(-1).message });
	assert.equal((await h.boundary()).continue, true);
});

test("recoverable final errors are bounded by the same three-failure fuse", async () => {
	const h = await goalHarness();
	assert.equal((await h.boundary("error")).continue, true);
	assert.equal((await h.boundary("error")).continue, true);
	assert.equal(await h.boundary("error"), undefined);
});

test("an error-fused goal can be resumed explicitly without losing its checklist", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	await h.boundary("error");
	assert.equal(await h.boundary(), undefined, "the fuse keeps the goal paused");
	await h.command("todo-resume", "Provider is back");
	assert.match(JSON.stringify(h.messages.at(-1)), /Provider is back/);
	const resumed = await h.emit("before_agent_start", { messageType: "custom", message: h.messages.at(-1).message });
	assert.match(resumed.message.content, /Continue the existing checklist/);
	assert.doesNotMatch(resumed.message.content, /create a fresh checklist/);
	assert.deepEqual(Array.from((await h.run({ action: "list" })).details.todos, (item) => item.text),
		["Fix parser", "Test parser"]);
	assert.equal((await h.boundary()).continue, true);
});

test("a blocked goal survives a plan release that lands after the input handler", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	h.pause();
	// Production load order can run the todo input handler before plan mode releases the pause.
	await h.emit("input", { source: "interactive", text: "Access granted" });
	h.releasePlan();
	assert.deepEqual(Array.from((await h.run({ action: "list" })).details.todos, (item) => item.text),
		["Fix parser", "Test parser"], "the checklist survives the reordered release");
	const resumed = await h.emit("before_agent_start", { messageType: "user", prompt: "Access granted" });
	assert.match(resumed.message.content, /TODO TASK: todo-goal/);
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /Goal is active\./);
	assert.equal((await h.boundary()).continue, true);
});

test("a plan release before the input handler also preserves the blocked goal", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	h.pause();
	h.releasePlan();
	await h.emit("input", { source: "interactive", text: "Access granted" });
	assert.equal((await h.run({ action: "list" })).details.todos.length, 2, "the checklist survives either handler order");
	const resumed = await h.emit("before_agent_start", { messageType: "user", prompt: "Access granted" });
	assert.match(resumed.message.content, /TODO TASK: todo-goal/);
	assert.equal((await h.boundary()).continue, true);
});

test("a plan pause that keeps ownership suspends the goal without destroying it", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	h.pause();
	await h.emit("input", { source: "interactive", text: "Plan instead" });
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Plan instead" }), undefined,
		"plan mode owns the turn, so goal rules are not injected into it");
	assert.equal((await h.run({ action: "list" })).details.todos.length, 2, "suspending must not destroy the checklist");
	await h.command("todo-resume", "Continue");
	assert.equal(h.messages.length, 1, "resume must not steal the plan-owned turn");
	assert.equal(await h.boundary(), undefined);
});

test("approving a plan resumes the suspended blocker before queued execution", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Need access" });
	h.pause();
	h.releasePlan({ sessionId: "test-session", approved: true });
	assert.equal(await h.emit("tool_call", { toolName: "edit", input: {} }), undefined);
	assert.equal((await h.boundary()).continue, true);
});

test("a plan turn can inspect and clarify without modifying the suspended goal", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Need access" });
	h.pause();
	assert.equal(await h.emit("tool_call", { toolName: "read", input: { path: "source.ts" } }), undefined);
	assert.equal(await h.ask(), undefined);
	assert.equal(await h.emit("tool_call", { toolName: "todo", input: { action: "list" } }), undefined);
	assert.equal((await h.emit("tool_call", { toolName: "todo", input: { action: "clear" } })).block, true);
});

test("an active goal survives a composer plan marker before the plan handler runs", async () => {
	const h = await goalHarness();
	await h.emit("input", { source: "interactive", text: "__PI_DECK_PLAN_MODE__Plan the change" });
	h.pause();
	assert.equal((await h.run({ action: "list" })).details.todos.length, 2);
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Plan the change" }), undefined);
	h.releasePlan();
	await h.emit("input", { source: "interactive", text: "Now implement" });
	const resumed = await h.emit("before_agent_start", { messageType: "user", prompt: "Now implement" });
	assert.match(resumed.message.content, /Continue the existing checklist/);
});

test("a plan-paused goal without a blocker survives the next user message", async () => {
	const h = await goalHarness();
	// Plan mode pauses a running goal before the agent ever reports a blocker.
	h.pause();
	await h.emit("input", { source: "interactive", text: "Continue the goal" });
	h.releasePlan();
	assert.deepEqual(Array.from((await h.run({ action: "list" })).details.todos, (item) => item.text),
		["Fix parser", "Test parser"], "the checklist survives a plan pause without a reported blocker");
	const resumed = await h.emit("before_agent_start", { messageType: "user", prompt: "Continue the goal" });
	assert.match(resumed.message.content, /TODO TASK: todo-goal/);
	assert.equal((await h.boundary()).continue, true);
});

test("a plan release that lands before the input handler keeps a non-blocked goal", async () => {
	const h = await goalHarness();
	h.pause();
	h.releasePlan();
	await h.emit("input", { source: "interactive", text: "Continue the goal" });
	assert.equal((await h.run({ action: "list" })).details.todos.length, 2, "handler order must not clear the checklist");
	const resumed = await h.emit("before_agent_start", { messageType: "user", prompt: "Continue the goal" });
	assert.match(resumed.message.content, /TODO TASK: todo-goal/);
});

test("an error-fused goal is not resumed by an ordinary user message", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	await h.boundary("error");
	await h.emit("input", { source: "interactive", text: "Something else" });
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Something else" }), undefined);
	assert.equal((await h.run({ action: "list" })).details.todos.length, 0, "a new task replaces a failed goal");
});

test("plan mode does not make an error-fused goal resumable by a plain message", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	await h.boundary("error");
	h.pause();
	h.releasePlan();
	await h.emit("input", { source: "interactive", text: "Something else" });
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Something else" }), undefined);
	assert.equal((await h.run({ action: "list" })).details.todos.length, 0,
		"the error fuse still requires an explicit /todo-resume");
});

test("an error-fused goal keeps its checklist when production plan-first order enters plan mode", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	await h.boundary("error");
	assert.equal(await h.boundary(), undefined, "the error fuse keeps the goal paused");
	// Production load order runs the plan handler first: it pauses the goal and strips the
	// composer marker before the todo input handler sees the message.
	h.pause();
	await h.emit("input", { source: "interactive", text: "Plan the change" });
	assert.deepEqual(Array.from((await h.run({ action: "list" })).details.todos, (item) => item.text),
		["Fix parser", "Test parser"], "suspending must not destroy an error-fused checklist");
	assert.match(JSON.stringify(await h.runTool("todo_goal_context")), /suspended while plan mode owns the turn/i);
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Plan the change" }), undefined,
		"plan mode owns the turn, so goal rules stay out of it");
	assert.equal(await h.boundary(), undefined, "a suspended goal must not continue inside plan mode");
	// Leaving plan mode keeps the original explicit-resume requirement for the error fuse.
	h.releasePlan();
	await h.command("todo-resume", "Provider is back");
	assert.equal(h.messages.length, 2, "the preserved goal is explicitly resumable");
	const resumed = await h.emit("before_agent_start", { messageType: "custom", message: h.messages.at(-1).message });
	assert.match(resumed.message.content, /Continue the existing checklist/);
	assert.equal((await h.boundary()).continue, true);
});

test("an error-fused goal still needs an explicit resume after plan mode releases it", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	await h.boundary("error");
	h.pause();
	await h.emit("input", { source: "interactive", text: "Plan the change" });
	h.releasePlan();
	await h.emit("input", { source: "interactive", text: "Something else" });
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Something else" }), undefined);
	assert.equal((await h.run({ action: "list" })).details.todos.length, 0,
		"a plain message still replaces an error-fused goal");
});

test("plan ownership rejects a new goal instead of starting an unpaused one", async () => {
	const h = await goalHarness();
	await h.runTool("todo_goal_blocked", { reason: "Missing access" });
	h.publishPlanState(true);
	await h.command("todo-goal", "Implement the endpoint");
	assert.equal(h.messages.length, 1, "no goal turn may start inside read-only plan mode");
	assert.ok(h.notifications.some(({ text }) => /plan mode/i.test(text)), "the rejection explains plan mode");
	assert.deepEqual(Array.from((await h.run({ action: "list" })).details.todos, (item) => item.text),
		["Fix parser", "Test parser"], "the existing checklist is preserved");
});

test("plan ownership does not block ordinary /todo", async () => {
	const h = createTodoHarness();
	h.publishPlanState(true);
	await h.command("todo", "Inspect the parser");
	assert.equal(h.messages.length, 1, "ordinary /todo stays available in plan mode");
});

test("plan ownership from another session does not block a new goal", async () => {
	const h = createTodoHarness();
	h.publishPlanState(true, "another-session");
	await h.command("todo-goal", "Implement the endpoint");
	assert.equal(h.messages.length, 1);
});

test("/todo-resume cannot bypass an active plan turn without a plan pause", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	await h.boundary("error");
	h.publishPlanState(true);
	await h.command("todo-resume", "Provider is back");
	assert.equal(h.messages.length, 1, "only the original goal start was sent");
	assert.ok(h.notifications.some(({ text }) => /plan mode/i.test(text)));
	h.publishPlanState(false);
	await h.command("todo-resume", "Provider is back");
	assert.equal(h.messages.length, 2, "the explicit resume works once plan mode releases");
});

test("an active goal is suspended by plan ownership even when the pause event is late", async () => {
	const h = await goalHarness();
	// Reverse load order: the todo handler runs before plan mode publishes its pause.
	h.publishPlanState(true);
	assert.equal(await h.emit("before_agent_start", { messageType: "user", prompt: "Plan the change" }), undefined,
		"plan ownership alone must keep goal rules out of the plan turn");
	assert.equal(await h.boundary(), undefined, "no automatic continuation inside plan mode");
	assert.equal((await h.run({ action: "list" })).details.todos.length, 2, "the checklist is preserved");
});

test("clearing a goal checklist records completed steps and forbids repeating them", async () => {
	const h = await goalHarness();
	await h.run({ action: "toggle", id: 1 });
	await h.run({ action: "clear" });
	const injected = await h.emit("before_agent_start", {});
	assert.match(injected.message.content, /already completed and must not be repeated/i);
	assert.match(injected.message.content, /#1 Fix parser/);
	assert.doesNotMatch(injected.message.content, /create a fresh checklist/i,
		"an authorized clear must rebuild only the remaining work, not restart the goal");
	const continuation = await h.boundary();
	assert.equal(continuation.continue, true);
	assert.match(content(continuation), /cleared/i);
	assert.match(content(continuation), /#1 Fix parser/);
	const context = JSON.stringify(await h.runTool("todo_goal_context"));
	assert.match(context, /#1 Fix parser/);
	assert.match(context, /not complete/i);
});

test("a boundary without entries still continues instead of throwing", async () => {
	const h = await goalHarness();
	const result = await h.emit("agent_before_settle", {
		outcome: "completed", continue: false, context: { pendingMessages: [] },
	});
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0].customType, "pi-deck-todo-task-continue");
});

test("agent_end does not race Pi's automatic retry or compaction", async () => {
	const h = await goalHarness();
	await h.emit("agent_end", { messages: [] });
	await h.emit("agent_end", { messages: [] });
	assert.equal(h.messages.length, 1);
	assert.equal((await h.boundary()).continue, true);
});

test("a duplicate settlement boundary cannot append two continuations", async () => {
	const h = await goalHarness();
	assert.equal((await h.boundary()).continue, true);
	assert.equal(await h.emit("agent_before_settle", {
		outcome: "completed", context: { pendingMessages: [] },
	}), undefined);
});

for (const pending of ["runtime", "boundary", "another-extension"]) {
	test(`pending ${pending} work is not double-scheduled or counted as a failure`, async () => {
		const h = await goalHarness();
		h.state.pending = pending === "runtime";
		const extra = pending === "boundary" ? { context: { pendingMessages: [{}] } }
			: pending === "another-extension" ? { continue: true } : {};
		for (let index = 0; index < 4; index++) assert.equal(await h.boundary("completed", extra), undefined);
		h.state.pending = false;
		assert.equal((await h.boundary()).continue, true);
	});
}

for (const stop of ["outcome", "signal", "settled", "agent-end"]) {
	test(`user cancellation via ${stop} never starts another turn`, async () => {
		const h = await goalHarness();
		if (stop === "signal") h.ctx.signal = AbortSignal.abort();
		if (stop === "settled") await h.emit("agent_settled", { aborted: true });
		if (stop === "agent-end") await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
		assert.equal(await h.boundary(stop === "outcome" ? "aborted" : "completed"), undefined);
		assert.equal(h.messages.length, 1);
		assert.equal(await h.ask(), undefined);
	});
}

for (const lifecycle of ["session_start", "session_tree", "session_before_tree", "session_before_switch", "session_before_fork", "session_shutdown"]) {
	test(`${lifecycle} invalidates the active goal without restarting it`, async () => {
		const h = await goalHarness();
		await h.emit(lifecycle);
		assert.equal(await h.boundary(), undefined);
		assert.equal(await h.ask(), undefined);
	});
}

test("new user input replaces the task, but extension input and steer preserve it", async () => {
	const h = await goalHarness();
	await h.emit("input", { source: "extension", text: "Continue" });
	await h.emit("input", { source: "rpc", text: "Note", streamingBehavior: "steer" });
	assert.equal((await h.ask()).block, true);
	await h.emit("input", { source: "rpc", text: "Different task" });
	assert.equal(await h.ask(), undefined);
	assert.equal(await h.boundary(), undefined);
});

test("third-party todo ownership prevents task commands and late continuation", async () => {
	const h = createTodoHarness({ ownsTodo: false });
	await h.command("todo-goal", "Build");
	assert.equal(h.messages.length, 0);
	assert.ok(h.notifications.length > 0);
	const active = await goalHarness();
	active.state.ownsTodo = false;
	assert.equal(await active.boundary(), undefined);
	assert.equal(await active.ask(), undefined);
});

test("runtimes without a safe boundary never use agent_end as a continuation fallback", async () => {
	const h = await goalHarness();
	for (let index = 0; index < 5; index++) await h.emit("agent_end", { messages: [] });
	assert.equal(h.messages.length, 1);
	assert.ok(h.notifications.some(({ text }) => /agent_before_settle|safe.*boundar/i.test(text)));
});

test("old task instructions are filtered from model context after cancellation", async () => {
	const h = await goalHarness();
	const injected = await h.emit("before_agent_start", {});
	const continuation = (await h.boundary()).entries[0];
	await h.emit("agent_settled", { aborted: true });
	const userMessage = { role: "user", content: [{ type: "text", text: "Original task" }] };
	const result = await h.emit("context", { messages: [
		userMessage, { role: "custom", ...injected.message }, { role: "custom", ...continuation },
	] });
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0], userMessage);
});

test("pending clarification is invalidated by a session change before it can start work", async () => {
	const h = createTodoHarness();
	let answer;
	h.ctx.ui.input = () => new Promise((resolve) => { answer = resolve; });
	const pending = h.command("todo-goal");
	await h.emit("session_shutdown");
	answer("A stale task");
	await pending;
	assert.equal(h.messages.length, 0);
});

test("a third-party override during clarification prevents starting and preserves the checklist", async () => {
	const h = createTodoHarness();
	await h.run({ action: "add", text: "Keep this" });
	let answer;
	h.ctx.ui.input = () => new Promise((resolve) => { answer = resolve; });
	const pending = h.command("todo-goal");
	h.state.ownsTodo = false;
	answer("New task");
	await pending;
	assert.equal(h.messages.length, 0);
	assert.equal((await h.run({ action: "list" })).details.todos[0].text, "Keep this");
});

test("task commands handle start failures without retaining an automatic continuation", async () => {
	const h = createTodoHarness();
	h.ctx.ui.input = () => { throw new Error("UI unavailable"); };
	await h.command("todo-goal");
	assert.equal(h.messages.length, 0);
	assert.ok(h.notifications.some(({ type }) => type === "error"));
	assert.equal(await h.boundary(), undefined);
});

test("a different custom run cannot inherit a paused goal's task mode", async () => {
	const h = await goalHarness();
	await h.boundary("error");
	await h.boundary("error");
	await h.boundary("error");
	assert.ok(h.notifications.some(({ type, text }) => type === "warning" && /3/.test(text)));
	assert.equal(await h.emit("before_agent_start", { messageType: "custom", message: {
		customType: "another-extension-task", content: "Different task", details: {},
	} }), undefined);
	assert.equal(await h.ask(), undefined);
	assert.equal(await h.boundary(), undefined);
});

test("an incomplete settlement payload conservatively pauses instead of continuing", async () => {
	const h = await goalHarness();
	assert.equal(await h.boundary("completed", { context: undefined }), undefined);
	assert.ok(h.notifications.some(({ type }) => type === "warning"));
	assert.equal(await h.boundary(), undefined);
});

test("rebuilding a goal checklist keeps todo IDs monotonic", async () => {
	const h = createTodoHarness();
	await h.command("todo-goal", "Implement and verify");
	for (let index = 0; index < 4; index++) await h.run({ action: "add", text: `Old ${index}` });
	for (let id = 1; id <= 3; id++) await h.run({ action: "toggle", id });
	await h.boundary();
	await h.run({ action: "clear" });
	assert.equal((await h.ask()).block, true, "clearing must not release the question lock");
	for (let index = 0; index < 4; index++) await h.run({ action: "add", text: `New ${index}` });
	const rebuilt = (await h.run({ action: "list" })).details.todos;
	assert.deepEqual(Array.from(rebuilt, (item) => item.id), [5, 6, 7, 8]);
	for (const item of rebuilt.slice(0, 3)) {
		await h.run({ action: "toggle", id: item.id });
		assert.equal((await h.boundary())?.continue, true, "unfinished goals continue");
	}
});

test("only a matching session's explicit plan pause suspends the current goal", async () => {
	const h = createTodoHarness();
	await h.command("todo-goal", "Implement");
	await h.run({ action: "add", text: "Implement" });
	h.pause("another-session");
	assert.equal((await h.boundary())?.continue, true);
	h.pause();
	assert.equal(await h.boundary(), undefined);
	assert.equal(await h.ask(), undefined, "plan mode owns clarification while the goal is suspended");
	assert.equal((await h.emit("tool_call", { toolName: "todo", input: { action: "clear" } })).block, true,
		"the suspended checklist must remain read-only");
	// A suspended goal survives an ordinary message; only a new task command replaces it.
	await h.emit("input", { source: "interactive", text: "Replace the goal" });
	assert.equal(await h.ask(), undefined, "clarification remains available to the plan turn");
	assert.equal((await h.run({ action: "list" })).details.todos.length, 1, "suspending keeps the checklist alive");
	await h.command("todo-goal", "Replace the goal");
	assert.equal(await h.emit("tool_call", { toolName: "ask_question" }), undefined);
});

test("an argument-less command can recover a previously persisted neutral goal", async () => {
	const h = createTodoHarness({ branch: [{ type: "custom_message", customType: "pi-deck-todo-task-start", content: "Inspect the parser", display: true }] });
	await h.command("todo");
	assert.equal(h.messages[0].message.content, "Inspect the parser");
});
