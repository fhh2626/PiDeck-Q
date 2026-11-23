import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Load the real extension and exercise its public command handlers without a Pi process. */
function loadExtension(entries = []) {
	const commands = new Map();
	const handlers = new Map();
	const notifications = [];
	const extension = loadTsCommonJs("resources/extensions/pi-deck-plan-mode.ts");
	extension.default({
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
	});

	const ctx = {
		sessionManager: { getEntries: () => entries },
		ui: {
			setWidget() {},
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
	};
	return { commands, handlers, notifications, ctx };
}

test("plan mode registers /plan-progress instead of /todos", () => {
	const { commands } = loadExtension();

	assert.equal(typeof commands.get("plan-progress")?.handler, "function");
	assert.equal(commands.has("todos"), false, "the old /todos name must not remain as an alias");
	assert.ok(commands.has("plan"), "the plan-mode toggle remains available");
});

test("/plan-progress reports when no plan is active", async () => {
	const { commands, notifications, ctx } = loadExtension();

	await commands.get("plan-progress").handler("", ctx);

	assert.deepEqual(notifications, [{ message: "没有活跃的计划事项。", type: "info" }]);
});

test("/plan-progress shows restored step completion without changing the plan", async () => {
	const entries = [{
		type: "custom",
		customType: "pi-deck-plan-mode",
		data: {
			enabled: false,
			executing: true,
			todos: [
				{ step: 1, text: "Inspect the code", completed: true },
				{ step: 2, text: "Add regression tests", completed: false },
			],
		},
	}];
	const original = structuredClone(entries);
	const { commands, handlers, notifications, ctx } = loadExtension(entries);
	await handlers.get("session_start")({ type: "session_start" }, ctx);

	await commands.get("plan-progress").handler("", ctx);

	assert.deepEqual(notifications, [{
		message: "1. ✓ Inspect the code\n2. ○ Add regression tests",
		type: "info",
	}]);
	assert.deepEqual(entries, original);
});
