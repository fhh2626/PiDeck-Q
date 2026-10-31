import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * pi-deck-todo 的会话恢复、自动重置与模型提示。
 *
 * 恢复必须沿当前分支读取最后一条快照：getEntries() 是整棵树的追加顺序，
 * 其他分支后写入的快照会盖住当前分支。
 *
 * 清理策略：收尾时不清，列表保留到用户下一次提交指令；该轮 input（非扩展注入、
 * 非 steer/followUp）统一重置。运行中插话属于当前这一轮，不能提前清空。
 */

function loadExtensionModule() {
	return loadTsCommonJs("resources/extensions/pi-deck-todo.ts", {
		stubs: {
			"@earendil-works/pi-ai": {
				StringEnum: (values) => ({ enum: values }),
			},
			"typebox": {
				Type: {
					Object: (shape) => shape,
					Optional: (schema) => schema,
					String: () => ({}),
					Number: () => ({}),
				},
			},
		},
	});
}

function entry(id, parentId, extra = {}) {
	return { id, parentId, timestamp: "2026-10-08T00:00:00.000Z", ...extra };
}

function todoEntry(id, parentId, text, done) {
	return entry(id, parentId, {
		type: "custom",
		customType: "pi-deck-todo",
		data: { todos: [{ id: 1, text, done }], nextId: 2 },
	});
}

/** 跨 realm 比较前转成主 realm 的纯数据；undefined 表示 widget 被清除。 */
function toPlain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadExtension({ sourcePath = "resources/extensions/pi-deck-todo.ts" } = {}) {
	const tools = [];
	const handlers = new Map();
	const entries = [];
	const api = {
		registerTool(definition) {
			tools.push(definition);
		},
		registerCommand() {},
		on(event, handler) {
			handlers.set(event, handler);
		},
		getAllTools() {
			return tools.map((definition) => ({
				name: definition.name,
				sourceInfo: { path: sourcePath },
			}));
		},
		appendEntry(type, data) {
			// 故意存引用：若 persistState 不拷贝，后续 mutation 会改写历史快照，测试必须能发现。
			entries.push({ type, data });
		},
	};
	loadExtensionModule().default(api);
	return { tools, handlers, entries };
}

function widgetContext(sessionManager) {
	const widgets = [];
	return {
		widgets,
		ctx: {
			sessionManager,
			ui: {
				setWidget(_key, lines) {
					widgets.push(lines);
				},
				notify() {},
			},
		},
	};
}

/** 把 todo 工具与 widget 上下文绑成一个最小执行器。 */
function todoRunner(extension, sessionManager = { getBranch: () => [] }) {
	const todo = extension.tools.find((definition) => definition.name === "todo");
	const { widgets, ctx } = widgetContext(sessionManager);
	return {
		widgets,
		ctx,
		run: (params) => todo.execute("call-1", params, undefined, undefined, ctx),
		submitUserMessage: (source = "rpc", streamingBehavior) =>
			extension.handlers.get("input")({ type: "input", text: "下一条指令", source, ...(streamingBehavior ? { streamingBehavior } : {}) }, ctx),
	};
}

test("branch restore uses the current branch snapshot, not a newer snapshot from another branch", async () => {
	const { handlers } = loadExtension();
	const branch = [
		entry("root", null, { type: "message" }),
		todoEntry("todo-a", "root", "branch A", false),
		entry("leaf-a", "todo-a", { type: "message" }),
	];
	const { widgets, ctx } = widgetContext({
		getEntries() {
			throw new Error("todo restore must not scan the whole session tree");
		},
		getBranch() {
			return branch;
		},
	});

	await handlers.get("session_tree")({ type: "session_tree" }, ctx);

	assert.deepEqual(JSON.parse(JSON.stringify(widgets.at(-1))), ["☐ #1 branch A"]);
});

test("switching to a branch without its own snapshot does not adopt another branch's later snapshot", async () => {
	const { handlers } = loadExtension();
	const currentBranch = [
		entry("root", null, { type: "message" }),
		entry("leaf-empty", "root", { type: "message" }),
	];
	const wholeTree = [
		...currentBranch,
		todoEntry("todo-other", "root", "other branch", true),
	];
	const { widgets, ctx } = widgetContext({
		getEntries() {
			return wholeTree;
		},
		getBranch() {
			return currentBranch;
		},
	});

	await handlers.get("session_start")({ type: "session_start" }, ctx);

	assert.deepEqual(JSON.parse(JSON.stringify(widgets)), [null]);
});

test("model guidelines keep completed items until the user explicitly clears them", () => {
	const { tools } = loadExtension();
	const todo = tools.find((definition) => definition.name === "todo");
	const guidelines = todo.promptGuidelines.join("\n");

	assert.doesNotMatch(guidelines, /clear when finished/i);
	assert.match(guidelines, /completed items/i);
	assert.match(guidelines, /explicitly asks to clear/i);
	assert.match(guidelines, /resets automatically at the next user instruction/i);
});

test("a finished round keeps its items until the next user instruction", async () => {
	const extension = loadExtension();
	const { run, widgets, submitUserMessage } = todoRunner(extension);

	await run({ action: "add", text: "改接口" });
	await run({ action: "add", text: "补测试" });
	await run({ action: "toggle", id: 1 });
	await run({ action: "toggle", id: 2 });

	assert.deepEqual(toPlain(widgets.at(-1)), ["☑ #1 改接口", "☑ #2 补测试"], "收尾时不得清空");

	await submitUserMessage();

	assert.equal(widgets.at(-1), undefined, "新一轮指令应隐藏 widget");
	assert.deepEqual(toPlain(extension.entries.at(-1).data), { todos: [], nextId: 1 }, "空快照要落盘供分支恢复");
});

test("an unfinished round is cleared by the next user instruction", async () => {
	const extension = loadExtension();
	const { run, widgets, submitUserMessage } = todoRunner(extension);

	await run({ action: "add", text: "改接口" });
	await run({ action: "add", text: "补测试" });
	await run({ action: "toggle", id: 1 });

	await submitUserMessage();

	assert.equal(widgets.at(-1), undefined, "未完成项也随新指令清空，不再跨轮累积");
	assert.deepEqual(toPlain(extension.entries.at(-1).data), { todos: [], nextId: 1 });
});

test("a mid-run steer or follow-up does not clear the list", async () => {
	const extension = loadExtension();
	const { run, widgets, submitUserMessage } = todoRunner(extension);

	await run({ action: "add", text: "改接口" });
	await run({ action: "toggle", id: 1 });
	const snapshotCount = extension.entries.length;
	const widgetCount = widgets.length;

	// steer/followUp 是运行中插话，仍属于当前这一轮，不能当作“下一条指令”。
	await submitUserMessage("rpc", "steer");
	await submitUserMessage("rpc", "followUp");

	assert.equal(extension.entries.length, snapshotCount, "插话不应写入重置快照");
	assert.equal(widgets.length, widgetCount, "插话不应刷新 widget");
	assert.deepEqual(toPlain(widgets.at(-1)), ["☑ #1 改接口"]);
});

test("an empty list does not write a redundant snapshot", async () => {
	const extension = loadExtension();
	const { widgets, submitUserMessage } = todoRunner(extension);

	await submitUserMessage();

	assert.equal(extension.entries.length, 0);
	assert.equal(widgets.length, 0);
});

test("each snapshot keeps the list as it was when written", async () => {
	const extension = loadExtension();
	const { run } = todoRunner(extension);

	await run({ action: "add", text: "改接口" });
	await run({ action: "add", text: "补测试" });
	await run({ action: "toggle", id: 1 });

	// 后续 add/toggle 不能改写更早的快照，否则分支恢复会拿到未来状态。
	assert.equal(extension.entries[0].data.todos.length, 1, "第一条快照应仍只有 1 项");
	assert.equal(extension.entries[0].data.todos[0].done, false, "后续 toggle 不能回写第一条快照");
	assert.equal(extension.entries[1].data.todos.length, 2);
	assert.equal(extension.entries[1].data.todos[0].done, false);
	assert.equal(extension.entries.at(-1).data.todos[0].done, true);
});

test("extension-injected input does not reset a finished round", async () => {
	const extension = loadExtension();
	const { run, widgets, submitUserMessage } = todoRunner(extension);

	await run({ action: "add", text: "改接口" });
	await run({ action: "toggle", id: 1 });
	const widgetCount = widgets.length;

	// 扩展注入的消息（source=extension）不是用户新指令，不能把上一轮完成记录清掉。
	await submitUserMessage("extension");

	assert.equal(widgets.length, widgetCount);
	assert.deepEqual(toPlain(widgets.at(-1)), ["☑ #1 改接口"]);
});

test("the first user message hydrates the branch before resetting", async () => {
	const extension = loadExtension();
	const branch = [
		entry("root", null, { type: "message" }),
		todoEntry("todo-done", "root", "上一轮任务", true),
		entry("leaf", "todo-done", { type: "message" }),
	];
	// 故意不触发 session_start，模拟首条消息先于会话启动到达。
	const { widgets, submitUserMessage } = todoRunner(extension, { getBranch: () => branch });

	await submitUserMessage();

	assert.equal(widgets.at(-1), undefined, "应先按当前分支补齐状态，再清空");
	assert.deepEqual(toPlain(extension.entries.at(-1).data), { todos: [], nextId: 1 });
});

test("yielding to a third-party todo extension disables input reset", async () => {
	const extension = loadExtension({ sourcePath: "node_modules/rpiv-todo/index.ts" });
	const { run, ctx, widgets, submitUserMessage } = todoRunner(extension);
	await extension.handlers.get("session_start")({ type: "session_start" }, ctx);

	await run({ action: "add", text: "改接口" });
	await run({ action: "toggle", id: 1 });
	const snapshotCount = extension.entries.length;

	await submitUserMessage();

	assert.equal(extension.entries.length, snapshotCount, "让位后不接管状态，也就不写快照");
	assert.deepEqual(toPlain(widgets.at(-1)), ["☑ #1 改接口"]);
});
