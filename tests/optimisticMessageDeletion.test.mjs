import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";

/**
 * 乐观删除（2026-09「删一条要等删下一条才消失」修复）：
 * - 隐藏范围与主进程 SessionFileEditor.turnSegmentMessageIds 同口径；
 * - 失败立即恢复；成功后等权威快照里这些消息消失才撤销隐藏（事件/响应乱序不闪回）。
 */

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		Date,
		Set,
		Map,
		setTimeout,
		clearTimeout,
		window: { setTimeout, clearTimeout },
	}, { filename: filePath });
	return module.exports;
}

const rules = compileModule("src/renderer/src/utils/optimisticMessageDeletion.ts");

function loadAtoms() {
	const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
	const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
	const messageFingerprint = compileModule("src/shared/messageFingerprint.ts");
	const sessionAtoms = compileModule("src/renderer/src/atoms/session-atoms.ts", {
		"../utils/agentRuntimeState": runtimeState,
		"../utils/sessionRecordIdentity": sessionRecordIdentity,
		"../../../shared/messageFingerprint": messageFingerprint,
	});
	const deletionAtoms = compileModule("src/renderer/src/atoms/message-deletion-atoms.ts", {
		"./session-atoms": sessionAtoms,
		"../utils/optimisticMessageDeletion": rules,
	});
	return { sessionAtoms, deletionAtoms };
}

function msg(id, role, extra = {}) {
	return { id, role, text: `${role}-${id}`, timestamp: 1, ...extra };
}

/** 两轮对话，第二轮前有一张压缩摘要卡 */
const conversation = [
	msg("u1", "user"),
	msg("a1", "assistant"),
	msg("t1", "tool"),
	msg("a1b", "assistant"),
	msg("card", "system"),
	msg("u2", "user"),
	msg("a2", "assistant"),
];

test("deleting a user message hides the whole turn up to the next user message", () => {
	assert.deepEqual(
		Array.from(rules.resolveOptimisticDeletionIds(conversation, "u1")),
		["u1", "a1", "t1", "a1b"],
	);
});

test("deleting an AI reply hides every reply of that turn but keeps the user message", () => {
	assert.deepEqual(
		Array.from(rules.resolveOptimisticDeletionIds(conversation, "a1b")),
		["a1", "t1", "a1b"],
	);
	assert.deepEqual(Array.from(rules.resolveOptimisticDeletionIds(conversation, "a2")), ["a2"]);
});

test("system cards and already sliding-out messages are never hidden", () => {
	const withSliding = [...conversation.slice(0, 5), msg("ghost", "user", { meta: { slidingOut: true } }), ...conversation.slice(5)];
	// 滑出中的 ghost 不能被当作轮次边界，system 卡片不属于对话条目
	assert.deepEqual(
		Array.from(rules.resolveOptimisticDeletionIds(withSliding, "t1")),
		["a1", "t1", "a1b"],
	);
	assert.equal(rules.resolveOptimisticDeletionIds(conversation, "missing").length, 0);
});

test("filter keeps the original array reference when nothing is hidden", () => {
	assert.equal(rules.filterOptimisticallyDeletedMessages(conversation, new Set()), conversation);
	assert.equal(rules.filterOptimisticallyDeletedMessages(conversation, new Set(["nope"])), conversation);
	const filtered = rules.filterOptimisticallyDeletedMessages(conversation, new Set(["u2", "a2"]));
	assert.deepEqual(filtered.map((m) => m.id), ["u1", "a1", "t1", "a1b", "card"]);
});

function seedRuntimeCache(store, sessionAtoms, messages, history) {
	store.set(sessionAtoms.cacheSessionMessagesAtom, {
		sessionId: "s1",
		source: "runtime",
		messages,
		...(history ? { history: { messages: history, nextBefore: null, exhausted: true } } : {}),
	});
}

function hiddenIds(store, deletionAtoms) {
	return Array.from(store.get(deletionAtoms.optimisticDeletedIdsBySessionIdAtomFamily("s1"))).sort();
}

test("begin hides the segment immediately, across the history prefix and the runtime window", () => {
	const { sessionAtoms, deletionAtoms } = loadAtoms();
	const store = createStore();
	// u1 轮在历史前缀，u2 轮在运行时窗口
	seedRuntimeCache(store, sessionAtoms, conversation.slice(5), conversation.slice(0, 5));
	deletionAtoms.beginOptimisticMessageDeletion(store, "s1", "u1");
	assert.deepEqual(hiddenIds(store, deletionAtoms), ["a1", "a1b", "t1", "u1"]);
	assert.equal(store.get(deletionAtoms.optimisticDeletedIdsBySessionIdAtomFamily("other")).size, 0);
});

test("a failed delete restores the hidden messages right away", () => {
	const { sessionAtoms, deletionAtoms } = loadAtoms();
	const store = createStore();
	seedRuntimeCache(store, sessionAtoms, conversation);
	const settle = deletionAtoms.beginOptimisticMessageDeletion(store, "s1", "u2");
	settle("failed");
	assert.deepEqual(hiddenIds(store, deletionAtoms), []);
});

test("a committed delete stays hidden until the authoritative snapshot drops the messages", () => {
	const { sessionAtoms, deletionAtoms } = loadAtoms();
	const store = createStore();
	seedRuntimeCache(store, sessionAtoms, conversation);
	const settle = deletionAtoms.beginOptimisticMessageDeletion(store, "s1", "u2");
	// 命令响应先到、快照未到：不能撤销隐藏，否则已删消息会闪回
	settle("committed");
	assert.deepEqual(hiddenIds(store, deletionAtoms), ["a2", "u2"]);

	// 快照到达：被删消息只剩滑出副本 → 撤销隐藏并清掉滑出副本
	seedRuntimeCache(store, sessionAtoms, [
		...conversation.slice(0, 5),
		{ ...conversation[5], meta: { slidingOut: true } },
		{ ...conversation[6], meta: { slidingOut: true } },
	]);
	assert.deepEqual(hiddenIds(store, deletionAtoms), []);
	const remaining = store.get(sessionAtoms.sessionMessagesCacheAtom).s1.messages.map((m) => m.id);
	assert.deepEqual(remaining, ["u1", "a1", "t1", "a1b", "card"]);
});

test("a committed delete settles immediately when the snapshot already arrived first", () => {
	const { sessionAtoms, deletionAtoms } = loadAtoms();
	const store = createStore();
	seedRuntimeCache(store, sessionAtoms, conversation);
	const settle = deletionAtoms.beginOptimisticMessageDeletion(store, "s1", "a2");
	seedRuntimeCache(store, sessionAtoms, conversation.slice(0, 6));
	settle("committed");
	assert.deepEqual(hiddenIds(store, deletionAtoms), []);
});
