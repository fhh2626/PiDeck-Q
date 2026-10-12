import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 只需冲突匹配相关符号；内置清单用空数组即可（本文件只测关键字表）。 */
const loaded = loadTsCommonJs("src/main/extensions/ExtensionManager.ts", {
	stubs: {
		"./builtInExtensions": { BUILT_IN_EXTENSIONS: [], isBuiltInExtensionName: () => false },
		// 删除走系统回收站统一入口；本测试不触达删除路径，提供 noop stub 即可。
		"../fs/trash": { trashPath: async () => {} },
		"../logging/sharedLogger": { getAppLogger: () => null },
	},
});
const extensionNameMatches = loaded.extensionNameMatches;
const BUILT_IN_CONFLICT_KEYWORDS = loaded.BUILT_IN_CONFLICT_KEYWORDS;

test("only todo / plan / ask / webfetch / subagents built-ins participate in conflict detection", () => {
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS.length, 5);
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[0][0], "pi-deck-todo.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[0][1], "todo");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[1][0], "pi-deck-plan-mode.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[1][1], "plan");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[2][0], "pideck-q-ask-question.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[2][1], "ask");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[3][0], "pideck-q-webfetch.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[3][1], "webfetch");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[4][0], "pideck-q-subagents.ts");
	assert.equal(BUILT_IN_CONFLICT_KEYWORDS[4][1], "subagents");
});

test("names containing webfetch conflict with system webfetch keyword", () => {
	assert.equal(extensionNameMatches("npm:@pi-lab/webfetch", "webfetch"), true);
	assert.equal(extensionNameMatches("webfetch.ts", "webfetch"), true);
});

test("names containing subagents conflict with system subagents keyword", () => {
	assert.equal(extensionNameMatches("npm:pi-subagents", "subagents"), true);
	assert.equal(extensionNameMatches("subagents.ts", "subagents"), true);
});

test("names containing todo conflict with system todo keyword", () => {
	assert.equal(extensionNameMatches("npm:todo", "todo"), true);
	assert.equal(extensionNameMatches("todo.ts", "todo"), true);
	assert.equal(extensionNameMatches("npm:@juicesharp/rpiv-todo", "todo"), true);
	assert.equal(extensionNameMatches("npm:my-todo-helper", "todo"), true);
});

test("names containing plan conflict with system plan keyword", () => {
	assert.equal(extensionNameMatches("npm:plan-mode", "plan"), true);
	assert.equal(extensionNameMatches("foo-plan-mode.ts", "plan"), true);
	assert.equal(extensionNameMatches("npm:my-plan-helper", "plan"), true);
});

test("names containing ask conflict with system ask keyword", () => {
	assert.equal(extensionNameMatches("npm:ask-question", "ask"), true);
	assert.equal(extensionNameMatches("ask-question.ts", "ask"), true);
	assert.equal(extensionNameMatches("npm:@juicesharp/rpiv-ask-user-question", "ask"), true);
	assert.equal(extensionNameMatches("npm:my-ask-helper", "ask"), true);
});

test("unrelated packages do not match todo/plan/ask keywords", () => {
	// 本次 bug：context-mode 与 plan-mode 不冲突
	assert.equal(extensionNameMatches("npm:context-mode", "plan"), false);
	assert.equal(extensionNameMatches("context-mode", "todo"), false);
	assert.equal(extensionNameMatches("npm:context-mode", "ask"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "plan"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "todo"), false);
	assert.equal(extensionNameMatches("npm:pi-web-access", "ask"), false);
});
