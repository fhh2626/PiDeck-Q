import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	anchorRowId,
	anchorRowStillInData,
	findAnchorRow,
	pickAnchorRow,
	resolveAnchorRestore,
	resolveAnchorRow,
	resolveTimelineWindowShift,
	scrollTopForRetainedRow,
} from "../src/renderer/src/hooks/timelineScrollAnchor.ts";

/**
 * 长会话拖动治理：锚点行必须用命中测试定位，不能每帧遍历全部挂载行。
 * 用最小化的元素替身（只需 getAttribute / parentElement）验证向上查找规则。
 */

function fakeNode(id, parent = null) {
	return {
		__id: id,
		getAttribute(name) {
			return name === "data-message-id" ? (id ?? null) : null;
		},
		parentElement: parent,
	};
}

test("the row itself carrying data-message-id is the anchor", () => {
	const timeline = fakeNode(null);
	const row = fakeNode("run-7", timeline);
	assert.equal(findAnchorRow(row, timeline), row);
	assert.equal(anchorRowId(findAnchorRow(row, timeline)), "run-7");
});

test("a deep child resolves to its nearest id-bearing ancestor", () => {
	const timeline = fakeNode(null);
	const row = fakeNode("msg-3", timeline);
	const inner = fakeNode(null, fakeNode(null, row));
	assert.equal(anchorRowId(findAnchorRow(inner, timeline)), "msg-3");
});

test("walking past the scroll container stops the search", () => {
	const timeline = fakeNode(null);
	// 命中元素不属于该容器（父链里既没有锚点也碰不到容器）：不得给出锚点。
	const unrelatedParent = fakeNode(null, null);
	const unrelated = fakeNode(null, unrelatedParent);
	assert.equal(findAnchorRow(unrelated, timeline), null);
	// 容器自身没有 id，命中容器不产生锚点。
	assert.equal(findAnchorRow(timeline, timeline), null);
});

test("an empty data-message-id is not an anchor", () => {
	const timeline = fakeNode(null);
	const empty = fakeNode("", timeline);
	assert.equal(findAnchorRow(empty, timeline), null);
	assert.equal(anchorRowId(findAnchorRow(empty, timeline)), null);
});

test("the first hit stack entry that maps to a row wins", () => {
	const timeline = fakeNode(null);
	const row = fakeNode("run-9", timeline);
	const overlay = fakeNode(null, timeline);
	assert.equal(pickAnchorRow([overlay, row], timeline), row);
	assert.equal(pickAnchorRow([overlay], timeline), null);
	assert.equal(pickAnchorRow([], timeline), null);
});

test("nested id-bearing rows resolve to the outer turn row, not the inner card", () => {
	// 阶段 A 会卸载折叠正文里的工具卡：锚点粒度必须与窗口裁剪粒度（整轮）一致，
	// 否则保存的锚点会在下一帧就不存在，恢复时只能猜位置。
	const timeline = fakeNode(null);
	const turnRow = fakeNode("run-1", timeline);
	const toolCard = fakeNode("tool-42", turnRow);
	const deep = fakeNode(null, toolCard);
	assert.equal(anchorRowId(findAnchorRow(deep, timeline)), "run-1");
});

test("anchor resolution needs a hit-test API instead of scanning every row", () => {
	// 无 document 命中测试能力时必须返回 null（调用方保留上一次锚点），
	// 不允许退回全表扫描 —— 那正是长会话拖动的瓶颈。
	const timeline = fakeNode(null);
	timeline.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, bottom: 100 });
	assert.equal(resolveAnchorRow(timeline, 0), null);
});

// 锚点行不在 DOM 里的处置：「被渲染窗口裁掉」、「确实已从数据消失」和「数据还没到」
// 必须分开——贴顶/贴底都是猜，猜错就是「信息流跳到以前的消息」。
const rowVisible = { rowMounted: true, dataLoaded: true };
const rowMissing = { rowMounted: false, dataLoaded: true };

test("a mounted anchor row is aligned exactly, whatever else is true", () => {
	assert.equal(resolveAnchorRestore({ ...rowVisible, stillInData: true, widenings: 0 }), "restore");
	// 可见性优先于数据判定：行在眼前就不该去扩窗或贴顶。
	assert.equal(resolveAnchorRestore({ ...rowVisible, stillInData: false, widenings: 99 }), "restore");
});

test("a missing anchor still in data widens the render window instead of guessing a position", () => {
	assert.equal(resolveAnchorRestore({ ...rowMissing, stillInData: true, widenings: 0 }), "widen");
	assert.equal(resolveAnchorRestore({ ...rowMissing, stillInData: true, widenings: 11 }), "widen");
});

test("an anchor gone from data falls back to the window top", () => {
	assert.equal(resolveAnchorRestore({ ...rowMissing, stillInData: false, widenings: 0 }), "fallback-window-top");
	// 空 id（保存前被删除 / 数据不一致）不得驱动无限扩窗。
	assert.equal(resolveAnchorRestore({ ...rowMissing, stillInData: false, widenings: 11 }), "fallback-window-top");
});

test("widening is capped so a broken anchor cannot grow the window forever", () => {
	assert.equal(resolveAnchorRestore({ ...rowMissing, stillInData: true, widenings: 12 }), "fallback-window-top");
	assert.equal(resolveAnchorRestore({ ...rowMissing, stillInData: true, widenings: 99 }), "fallback-window-top");
});

test("unread data waits instead of pretending the anchor is gone", () => {
	// 会话切换首帧数据未落地：空消息数组不等于「已被压缩删除」。
	// 此时贴顶会把用户钉在窗口顶部；扩窗也找不回不存在的消息，只会白白多挂 DOM。
	assert.equal(
		resolveAnchorRestore({ rowMounted: false, dataLoaded: false, stillInData: false, widenings: 0 }),
		"wait-for-data",
	);
});

test("anchor membership checks message ids, not runtime card ids", () => {
	const messages = [{ id: "msg-1" }, { id: "msg-2" }];
	assert.equal(anchorRowStillInData("msg-2", messages), true);
	assert.equal(anchorRowStillInData("card-9", messages), false);
	assert.equal(anchorRowStillInData("", messages), false);
	assert.equal(anchorRowStillInData("msg-1", []), false);
});

// 渲染窗口变化后的补偿决策：旧实现只有「变高 + 轮数变化」一条分支，变短不补偿是真实缺陷。
test("a pending history anchor owns the frame so compensation happens only once", () => {
	const base = { following: false, hadWindowedRows: true, hasPendingHistoryAnchor: true };
	// 前插帧（轮数同时变化）：窗口 effect 让位,controller 补一次。
	assert.equal(resolveTimelineWindowShift({ ...base, turnsChanged: true, heightDelta: 500 }), "defer-to-history-anchor");
	// 等待期间的普通帧：只刷基线，否则这段增高会被当成前插高度差。
	assert.equal(resolveTimelineWindowShift({ ...base, turnsChanged: false, heightDelta: 500 }), "refresh-baseline");
	assert.equal(resolveTimelineWindowShift({ ...base, turnsChanged: false, heightDelta: -300 }), "refresh-baseline");
});

test("bottom-following and unwindowed frames never write scrollTop by hand", () => {
	// 贴底时生长补偿由 stick-to-bottom 引擎负责,手动写 scrollTop 会把用户拽离底部。
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: true, heightDelta: 500, following: true, hadWindowedRows: true,
	}), "none");
	// 上帧未裁切（全量在窗口里）：没有顶部被裁的位移,无从补偿。
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: true, heightDelta: 500, following: false, hadWindowedRows: false,
	}), "none");
});

test("a taller window after 「显示更早」 grows scrollTop by the height delta", () => {
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: true, heightDelta: 500, following: false, hadWindowedRows: true,
	}), "grow-compensation");
	// 高度没变（内容重排/流式增高落在别处）：不补偿。
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: true, heightDelta: 0, following: false, hadWindowedRows: true,
	}), "none");
	// 变高但不是轮数变化（数据/流式内容自己长高）：不归窗口 effect 管。
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: false, heightDelta: 500, following: false, hadWindowedRows: true,
	}), "none");
});

test("a shorter window realigns the anchor row instead of the height delta", () => {
	// 顶部整轮被裁掉：被裁的量不等于插入量,按高度差补偿等于什么也没补。
	// 轮数是否变化都要补：条目预算收紧只改条目数、不改轮数。
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: true, heightDelta: -300, following: false, hadWindowedRows: true,
	}), "shrink-compensation");
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: false, heightDelta: -300, following: false, hadWindowedRows: true,
	}), "shrink-compensation");
	// 贴底时依然交给引擎。
	assert.equal(resolveTimelineWindowShift({
		hasPendingHistoryAnchor: false, turnsChanged: false, heightDelta: -300, following: true, hadWindowedRows: true,
	}), "none");
});

test("a shrinking list keeps the row under the viewport top in place", () => {
	assert.equal(scrollTopForRetainedRow(500, 20), 480);
	// 行顶已在视口上方（负偏移）：视口顶部仍压在这一行上，落点比行顶更靠后。
	assert.equal(scrollTopForRetainedRow(300, -40), 340);
	assert.equal(scrollTopForRetainedRow(10, 900), 0);
	assert.equal(scrollTopForRetainedRow(Number.NaN, 20), 0);
});


// ── 接线契约（阶段 C/D）────────────────────────────────────────────────
// 纯策略写在上面；这组只锁「组件与 controller 真的用了它」，
// 以及旧的全表扫描 / 猜位置实现不许回来。

const controllerSource = readFileSync(
	"src/renderer/src/hooks/useSessionTimelineController.ts",
	"utf8",
);
const timelineSource = readFileSync(
	"src/renderer/src/components/session/SessionMessageTimeline.tsx",
	"utf8",
);

test("the scroll hot path never scans every mounted row", () => {
	// 拖动卡顿根因：每帧 querySelectorAll('[data-message-id]') 再逐行量矩形。
	// 锚点读取必须走 timelineScrollAnchor 的命中测试。
	const readBody = controllerSource.slice(
		controllerSource.indexOf("const readCurrentAnchor"),
		controllerSource.indexOf("const persistCurrentAnchor"),
	);
	assert.ok(readBody.length > 0, "readCurrentAnchor missing");
	assert.doesNotMatch(readBody, /querySelectorAll/);
	assert.match(readBody, /resolveAnchorRow\(timeline, viewportRect\.top\)/);
	// 负偏移语义不得被截断（截断会让恢复位置整体偏下）。
	assert.match(readBody, /offsetTop: rect\.top - viewportRect\.top,/);
});

test("anchor restore widens the window instead of guessing a position", () => {
	const restoreBody = controllerSource.slice(
		controllerSource.indexOf("const attemptAnchorRestore"),
		controllerSource.indexOf("const peekViewportAnchor"),
	);
	assert.ok(restoreBody.length > 0, "attemptAnchorRestore missing");
	// 隐藏节点（矩形全零）必须当未挂载，否则按全零矩形算出的 scrollTop 是垃圾值。
	assert.match(restoreBody, /rowBox\.height > 0 \|\| rowBox\.width > 0/);
	// 「数据未落地」不能当作「锚点已被删除」，否则会把用户钉在窗口顶部。
	assert.match(restoreBody, /dataLoaded: cachedEntry !== undefined/);
	// 被窗口裁掉：扩窗找回，而不是就地猜位置。
	assert.match(restoreBody, /step === "widen"[\s\S]{0,200}anchorWideningsRef\.current \+= 1;[\s\S]{0,80}expandWindow\(\);/);
	// 兜底贴顶只允许发生在 widen 判定之后。
	assert.match(restoreBody, /expandWindow\(\);[\s\S]{0,900}timeline\.scrollTop = 0;/);
	// 失败后不得把找不到的锚点写回：切走会再次落盘，下次进入重复扩窗再贴顶。
	const fallbackBody = restoreBody.slice(restoreBody.lastIndexOf("timeline.scrollTop = 0"));
	assert.match(restoreBody, /currentAnchorRef\.current = null;/);
	assert.doesNotMatch(fallbackBody, /currentAnchorRef\.current = anchor/);
	// 位置没变不派发 scroll 时，抑制标记必须清掉，不能吞掉下一次用户滚到顶。
	assert.match(restoreBody, /timeline\.scrollTop === before[\s\S]{0,80}programmaticScrollRef\.current = false;/);
	assert.match(restoreBody, /requestAnimationFrame\([\s\S]{0,160}programmaticScrollRef\.current = false;/);
	// 上一版计划的错误修法：锚点缺失时贴底部（窗口是尾部 N 轮，贴底差几十轮）。
	assert.doesNotMatch(controllerSource, /scrollTopWhenAnchorMissing/);
	// 恢复尝试必须在会话切换时清掉，不给旧会话留残留。
	assert.match(controllerSource, /pendingAnchorRestoreRef\.current = undefined;\n\s*anchorWideningsRef\.current = 0;/);
});

test("a shorter render window realigns the anchor row rather than the height delta", () => {
	// 变短不补偿 = 视口并到另一批内容上（表现为突然跳走）。
	assert.match(timelineSource, /resolveTimelineWindowShift\(\{/);
	assert.match(timelineSource, /controller\.peekViewportAnchor\(\)/);
	assert.match(timelineSource, /shiftAction === "shrink-compensation"/);
	assert.match(timelineSource, /scrollTopForRetainedRow\(/);
	// 变高分支与「前插帧让位」的既有语义必须原样保留（同一帧只补一次）。
	assert.match(timelineSource, /timeline\.scrollTop \+ \(nextHeight - prev\.height\)/);
	assert.match(timelineSource, /hasPendingHistoryAnchor: controller\.hasPendingLoadMoreAnchor/);
	// 锚点行不可见时不得写 scrollTop（不猜位置）。
	const shrinkBody = timelineSource.slice(
		timelineSource.indexOf('shiftAction === "shrink-compensation"'),
		timelineSource.indexOf('"defer-to-history-anchor"'),
	);
	assert.ok(shrinkBody.length > 0, "shrink branch missing");
	assert.match(shrinkBody, /rowRect\.height > 0 \|\| rowRect\.width > 0/);
});
