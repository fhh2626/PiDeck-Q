import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * pi-deck-todo 的会话恢复与模型提示。
 *
 * 恢复必须沿当前分支读取最后一条快照：getEntries() 是整棵树的追加顺序，
 * 其他分支后写入的快照会盖住当前分支。完成项应保留，直到用户明确要求清空。
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

function loadExtension() {
	const tools = [];
	const handlers = new Map();
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
				sourceInfo: { path: "resources/extensions/pi-deck-todo.ts" },
			}));
		},
		appendEntry() {},
	};
	loadExtensionModule().default(api);
	return { tools, handlers };
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
});
