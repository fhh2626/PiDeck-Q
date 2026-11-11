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
	assert.deepEqual([...h.commands.keys()].sort(), ["todo", "todo-goal"]);
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
	assert.match(content(await h.boundary()), /Fix the parser and test it/);
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
	assert.match(content(result), /list|todo/i);
});

test("unfinished goals continue with the original goal and only unfinished items", async () => {
	const h = await goalHarness();
	await h.run({ action: "toggle", id: 1 });
	const result = await h.boundary();
	assert.equal(result.continue, true);
	assert.match(content(result), /Fix the parser and test it/);
	assert.match(content(result), /#2.*Test parser/);
	assert.doesNotMatch(content(result), /#1.*Fix parser/);
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

test("three consecutive no-progress boundaries pause instead of looping forever", async () => {
	const h = await goalHarness();
	assert.equal((await h.boundary()).continue, true);
	assert.equal((await h.boundary()).continue, true);
	assert.equal(await h.boundary(), undefined);
	assert.equal(await h.boundary(), undefined);
	assert.ok(h.notifications.some(({ text }) => /3|three/i.test(text)));
});

test("newly completed items reset the no-progress streak", async () => {
	const h = await goalHarness();
	await h.boundary();
	await h.boundary();
	await h.run({ action: "toggle", id: 1 });
	assert.equal((await h.boundary()).continue, true);
	assert.equal((await h.boundary()).continue, true);
	assert.equal((await h.boundary()).continue, true);
	assert.equal(await h.boundary(), undefined);
});

test("repeated toggles and additions cannot fake progress and bypass the fuse", async () => {
	const h = await goalHarness();
	await h.run({ action: "toggle", id: 1 });
	await h.boundary();
	for (let index = 0; index < 3; index++) {
		await h.run({ action: "toggle", id: 1 });
		await h.run({ action: "toggle", id: 1 });
		await h.run({ action: "add", text: `Extra ${index}` });
		const result = await h.boundary();
		assert.equal(result?.continue, index < 2 ? true : undefined);
	}
});

test("recoverable final errors are bounded by the same three-failure fuse", async () => {
	const h = await goalHarness();
	assert.equal((await h.boundary("error")).continue, true);
	assert.equal((await h.boundary("error")).continue, true);
	assert.equal(await h.boundary("error"), undefined);
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
	await h.boundary();
	await h.boundary();
	await h.boundary();
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

test("explicitly rebuilding a goal checklist does not mistake new completed items for old IDs", async () => {
	const h = createTodoHarness();
	await h.command("todo-goal", "Implement and verify");
	for (let index = 0; index < 4; index++) await h.run({ action: "add", text: `Old ${index}` });
	for (let id = 1; id <= 3; id++) await h.run({ action: "toggle", id });
	await h.boundary();
	await h.run({ action: "clear" });
	assert.equal((await h.ask()).block, true, "clearing must not release the question lock");
	for (let index = 0; index < 4; index++) await h.run({ action: "add", text: `New ${index}` });
	const rebuilt = (await h.run({ action: "list" })).details.todos;
	for (const item of rebuilt.slice(0, 3)) {
		await h.run({ action: "toggle", id: item.id });
		assert.equal((await h.boundary())?.continue, true, "each newly completed item is real progress");
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
	assert.equal((await h.emit("tool_call", { toolName: "ask_question" }))?.block, true, "pausing does not reset the task's question lock");
	await h.emit("input", { source: "interactive", text: "A new task" });
	assert.equal(await h.emit("tool_call", { toolName: "ask_question" }), undefined);
});

test("an argument-less command can recover a previously persisted neutral goal", async () => {
	const h = createTodoHarness({ branch: [{ type: "custom_message", customType: "pi-deck-todo-task-start", content: "Inspect the parser", display: true }] });
	await h.command("todo");
	assert.equal(h.messages[0].message.content, "Inspect the parser");
});
