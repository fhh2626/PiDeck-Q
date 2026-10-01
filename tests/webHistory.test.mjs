import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	hasMoreWebHistory,
	canRequestWebHistoryPage,
	applyWebHistoryTailPage,
	applyWebHistoryOlderPage,
	decideHistoryApply,
	needsWebHistoryTopUp,
} = loadTsCommonJs("src/renderer/src/web/webHistory.ts");

test("web history stays loadable before the first page arrives", () => {
	assert.equal(hasMoreWebHistory({ loaded: false, catalogMessageCount: 180 }), true);
	assert.equal(hasMoreWebHistory({ loaded: false, catalogMessageCount: 0 }), false);
	assert.equal(hasMoreWebHistory({ loaded: false }), true);
});

test("web history stays loadable after a failed first page", () => {
	assert.equal(hasMoreWebHistory({
		loaded: false,
		catalogMessageCount: 80,
		meta: { total: 0, nextBefore: null, status: "error" },
	}), true);
});

test("web history uses nextBefore once the first page is ready", () => {
	assert.equal(hasMoreWebHistory({
		loaded: true,
		catalogMessageCount: 180,
		meta: { total: 180, nextBefore: 80, status: "ready" },
	}), true);
	assert.equal(hasMoreWebHistory({
		loaded: true,
		catalogMessageCount: 40,
		meta: { total: 40, nextBefore: null, status: "ready" },
	}), false);
});

test("new web sessions with an empty ready cursor do not show load more", () => {
	assert.equal(hasMoreWebHistory({
		loaded: true,
		catalogMessageCount: 0,
		meta: { total: 0, nextBefore: null, status: "ready" },
	}), false);
});

test("web history request stays allowed when streaming marked the session loaded first", () => {
	assert.equal(canRequestWebHistoryPage({ loaded: false }), true);
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
		meta: { total: 0, nextBefore: null, status: "error" },
	}), true);
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
		meta: { total: 180, nextBefore: 80, status: "ready" },
	}), true);
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
	}), true, "streaming may mark loaded before the first page returns");
	assert.equal(canRequestWebHistoryPage({
		loaded: true,
		meta: { total: 12, nextBefore: null, status: "ready" },
	}), false);
});

test("a successful tail page initializes the older-history frontier", () => {
	const meta = applyWebHistoryTailPage(undefined, {
		total: 120,
		nextBefore: 70,
		nextBeforeEntryId: "e70",
		indexVersion: "1:2",
	});
	assert.equal(meta.nextBefore, 70);
	assert.equal(meta.nextBeforeEntryId, "e70");
	assert.equal(meta.status, "ready");
});

test("a later tail repair does not reset an advanced older-history frontier", () => {
	// 用户已向前翻到 e40；此时 SSE 异常重建尾部权威基线：新尾页头不得把游标拽回去，
	// 否则已加载的更早页会被重复遍历。
	const advanced = { total: 120, nextBefore: 40, nextBeforeEntryId: "e40", indexVersion: "1:2", status: "ready" };
	const repaired = applyWebHistoryTailPage(advanced, {
		total: 122,
		nextBefore: 72,
		nextBeforeEntryId: "e72",
		indexVersion: "1:3",
	});
	assert.equal(repaired.nextBefore, 40);
	assert.equal(repaired.nextBeforeEntryId, "e40");
});

test("a later tail repair does not reopen an exhausted older-history frontier", () => {
	// 用户已成功翻到历史最顶端（nextBefore=null, status=ready）；
	// 此时 SSE 异常重建尾部权威基线：新尾页的非空游标不得把已到顶的边界重新打开，
	// 否则「加载更多」会重新遍历用户已读过的更早页。
	const exhausted = { total: 120, nextBefore: null, status: "ready" };
	const repaired = applyWebHistoryTailPage(exhausted, {
		total: 122,
		nextBefore: 72,
		nextBeforeEntryId: "e72",
		indexVersion: "1:3",
	});
	assert.equal(repaired.nextBefore, null, "已到顶的边界必须保留，不得被新尾页的非空游标覆盖");
	assert.equal(repaired.nextBeforeEntryId, undefined, "不得重新挂上游标 entryId");
	assert.equal(repaired.status, "ready");
	assert.equal(hasMoreWebHistory({ loaded: true, meta: repaired }), false);
});

test("a failed first page is still re-established by a fresh tail page", () => {
	// 首屏失败（status=error）时，尾页刷新必须重新建立游标——
	// 不能因「保留当前边界」而把失败状态永久卡死。
	const failed = { total: 120, nextBefore: null, status: "error" };
	const repaired = applyWebHistoryTailPage(failed, {
		total: 122,
		nextBefore: 72,
		nextBeforeEntryId: "e72",
		indexVersion: "1:3",
	});
	assert.equal(repaired.nextBefore, 72);
	assert.equal(repaired.status, "ready");
});

test("a successful older page advances the frontier from the server cursors", () => {
	const current = { total: 120, nextBefore: 70, nextBeforeEntryId: "e70", status: "ready" };
	const older = { total: 120, nextBefore: 64, nextBeforeEntryId: "e64", status: "ready" };
	const next = applyWebHistoryOlderPage(current, older);
	assert.equal(next.nextBefore, 64);
	assert.equal(next.nextBeforeEntryId, "e64");
});

test("a failed older page keeps the previous cursor so the retry can continue", () => {
	const current = { total: 120, nextBefore: 70, nextBeforeEntryId: "e70", status: "ready" };
	const failed = applyWebHistoryOlderPage(current, null);
	assert.equal(failed.nextBefore, 70);
	assert.equal(failed.nextBeforeEntryId, "e70");
	assert.equal(failed.status, "error");
});

test("an empty page with an advancing cursor is still a successful older page", () => {
	// 投影可能跳过整页原始条目：空消息不能当成到顶，游标前进就继续可翻。
	const next = applyWebHistoryOlderPage(
		{ total: 120, nextBefore: 70, status: "ready" },
		{ total: 120, nextBefore: 60, status: "ready" },
	);
	assert.equal(next.nextBefore, 60);
	assert.equal(hasMoreWebHistory({ loaded: true, meta: next }), true);
});

test("a stale older page that does not advance the cursor stops the frontier", () => {
	// 服务器返回未前进的游标（历史被外部改写/锚点失效）：不得无限重复请求同一页。
	const next = applyWebHistoryOlderPage(
		{ total: 120, nextBefore: 70, nextBeforeEntryId: "e70", status: "ready" },
		{ total: 120, nextBefore: 70, nextBeforeEntryId: "e70", status: "ready" },
	);
	assert.equal(next.status, "error");
	assert.equal(next.nextBefore, 70, "保留旧游标便于用户手动重试");
});


test("decideHistoryApply applies when the session is active and idle", () => {
	assert.equal(decideHistoryApply(true, false), "apply");
});

test("decideHistoryApply defers while the active session is streaming", () => {
	assert.equal(decideHistoryApply(true, true), "defer");
});

test("decideHistoryApply skips when the session is no longer active", () => {
	assert.equal(decideHistoryApply(false, false), "skip");
	assert.equal(decideHistoryApply(false, true), "skip");
});

// ── W2：首屏历史在流式期间到达时必须延后应用（源码结构约束） ──

test("WebChatApp defers the first history page while streaming and re-injects it afterwards", () => {
	const source = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	// 回调必须走纯函数判定，而不是手写 if
	assert.match(source, /decideHistoryApply\(/);
	// 延后登记 + 补注入后清理，两处都要有
	assert.match(source, /deferredHistoryApplyRef\.current\.add\(/);
	assert.match(source, /deferredHistoryApplyRef\.current\.delete\(/);
	// 补注入 effect 必须在流结束后用缓存整体替换
	assert.match(
		source,
		/if \(!activeSessionId \|\| chatStreaming\) return;[\s\S]{0,400}setMessages\(cached\)/,
	);
});