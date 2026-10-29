import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTimelineRowModel,
	computeTimelineGeometry,
	findVisibleRowRange,
	buildTimelineRenderPlan,
	resolveAnchorScrollTop,
	calculateListOrigin,
} from "../src/renderer/src/components/session/timeline/virtualTimelineGeometry.ts";

function makeRun(id, subMessageIds = []) {
	return {
		kind: "agent-run",
		id,
		items: subMessageIds.map((mid) => ({
			kind: "message",
			message: { id: mid, role: "assistant", text: "tool result", timestamp: 1 },
		})),
		startedAt: 1,
		endedAt: 2,
	};
}

function makeUserMsg(id) {
	return {
		kind: "message",
		message: {
			id,
			agentId: "agent",
			role: "user",
			text: "hello",
			timestamp: 1,
		},
	};
}

test("buildTimelineRowModel filters floating-failure and askQuestion, maps messageIds correctly", () => {
	const items = [
		makeUserMsg("m1"),
		{
			kind: "message",
			message: {
				id: "err-float",
				role: "error",
				meta: { i18nKey: "diagnostic.retryScheduled" },
				text: "retrying",
			},
		},
		{
			kind: "message",
			message: {
				id: "sys-ask",
				role: "system",
				meta: { type: "askQuestion" },
				text: "question?",
			},
		},
		makeRun("r1", ["sub-1", "sub-2"]),
	];

	const model = buildTimelineRowModel(items);
	assert.equal(model.rows.length, 2, "floating-failure 与 askQuestion 必须被过滤掉");
	assert.equal(model.rows[0].key, "message:m1");
	assert.equal(model.rows[1].key, "run:r1");

	assert.equal(model.rowKeyByMessageId.get("m1"), "message:m1");
	assert.equal(model.rowKeyByMessageId.get("r1"), "run:r1");
	assert.equal(model.rowKeyByMessageId.get("sub-1"), "run:r1");
	assert.equal(model.rowKeyByMessageId.get("sub-2"), "run:r1");

	assert.equal(model.lastAgentRunKey, "run:r1");
	assert.equal(model.latestItemKey, "run:r1");
});

test("buildTimelineRowModel: 组合包含旧run、最新run和尾部用户消息时，lastAgentRunKey唯一指向最新run", () => {
	const items = [
		makeRun("run-old", ["sub-old"]),
		makeRun("run-new", ["sub-new"]),
		makeUserMsg("user-tail"),
	];

	const model = buildTimelineRowModel(items);
	assert.equal(model.rows.length, 3);
	assert.equal(model.lastAgentRunKey, "run:run-new", "只有最后一个 agent-run 是 lastAgentRunKey");
	assert.equal(model.latestItemKey, "message:user-tail", "最后一个条目是尾部用户消息");
	assert.equal(model.rows[0].sourceIndex, 0);
	assert.equal(model.rows[1].sourceIndex, 1);
	assert.equal(model.rows[2].sourceIndex, 2);
});

test("buildTimelineRowModel: 权威 17 个 floating failure 全部过滤，而诊断卡片（agentStartFailed / runtimeError）保留成行", () => {
	const canonical17 = [
		"diagnostic.requestFailed",
		"diagnostic.requestFailedAfterRetries",
		"diagnostic.requestFailedUnknown",
		"diagnostic.requestFailedUnknownAfterRetries",
		"diagnostic.agentStopped",
		"diagnostic.promptRejected",
		"diagnostic.promptDeliveryUnknown",
		"diagnostic.commandFailed",
		"diagnostic.commandDeliveryUnknown",
		"diagnostic.commandCancelled",
		"diagnostic.processReconnectFailed",
		"diagnostic.historyLoadFailed",
		"diagnostic.extensionError",
		"diagnostic.retryScheduled",
		"diagnostic.retryScheduledAfterDelay",
		"diagnostic.retrySucceeded",
		"diagnostic.retryFailed",
	];

	for (const key of canonical17) {
		const items = [
			{
				kind: "message",
				message: { id: `err-${key}`, role: "error", meta: { i18nKey: key }, text: "msg" },
			},
		];
		const model = buildTimelineRowModel(items);
		assert.equal(model.rows.length, 0, `key: ${key} 必须被过滤掉不渲染顶层行`);
	}

	// 启动失败与运行时诊断卡片保留
	const diagnostics = [
		{
			kind: "message",
			message: { id: "diag-start", role: "error", meta: { i18nKey: "diagnostic.agentStartFailed" }, text: "start err" },
		},
		{
			kind: "message",
			message: { id: "diag-runtime", role: "error", meta: { i18nKey: "diagnostic.runtimeError" }, text: "runtime err" },
		},
	];
	const diagModel = buildTimelineRowModel(diagnostics);
	assert.equal(diagModel.rows.length, 2, "agentStartFailed 与 runtimeError 必须保留诊断卡片成行！");
});

test("computeTimelineGeometry applies gap between rows and omits gap after the last row", () => {
	const rows = [
		{ key: "r1", anchorId: "r1", item: makeRun("r1"), sourceIndex: 0, messageIds: ["r1"] },
		{ key: "r2", anchorId: "r2", item: makeRun("r2"), sourceIndex: 1, messageIds: ["r2"] },
		{ key: "r3", anchorId: "r3", item: makeRun("r3"), sourceIndex: 2, messageIds: ["r3"] },
	];

	const measured = new Map([
		["r1", 100],
		["r2", 200],
		["r3", 300],
	]);

	const gap = 12;
	const geom = computeTimelineGeometry(rows, measured, gap);

	// r1: 100 + gap 12 -> 112
	// r2: 200 + gap 12 -> 324
	// r3 (last): 300 + gap 0 -> 624
	assert.deepEqual(Array.from(geom.prefixOffsets), [0, 112, 324, 624]);
	assert.equal(geom.totalHeight, 624);
});

test("buildTimelineRenderPlan interleaves visible range and discrete pins with correct spacers", () => {
	const count = 30;
	const rows = [];
	const measured = new Map();
	for (let i = 0; i < count; i += 1) {
		const key = `row-${i}`;
		rows.push({ key, anchorId: key, item: makeRun(key), sourceIndex: i, messageIds: [key] });
		measured.set(key, 100);
	}

	const gap = 12;
	const geom = computeTimelineGeometry(rows, measured, gap);

	// 可见区间 [10, 13)，pin 第 2 行和第 19 行
	const visibleRange = { startIndex: 10, endIndex: 13 };
	const pinnedKeys = new Set(["row-2", "row-19"]);

	const plan = buildTimelineRenderPlan(geom, visibleRange, pinnedKeys);

	// 预期计划结构:
	// 1. spacer [0, 2)
	// 2. row 2
	// 3. spacer [3, 10)
	// 4. row 10
	// 5. row 11
	// 6. row 12
	// 7. spacer [13, 19)
	// 8. row 19
	// 9. spacer [20, 30)
	const kinds = plan.map((p) => (p.kind === "row" ? `row-${p.rowIndex}` : `spacer-[${p.startIndex},${p.endIndex})`));
	assert.deepEqual(kinds, [
		"spacer-[0,2)",
		"row-2",
		"spacer-[3,10)",
		"row-10",
		"row-11",
		"row-12",
		"spacer-[13,19)",
		"row-19",
		"spacer-[20,30)",
	]);

	// 守恒性检验：所有 spacer 高度 + 所有行的高度及 gapAfter 严格等于 totalHeight
	let sum = 0;
	for (const p of plan) {
		if (p.kind === "spacer") {
			sum += p.height;
		} else {
			const h = geom.heights[p.rowIndex];
			sum += h + p.gapAfter;
		}
	}
	assert.equal(sum, geom.totalHeight, "总高必须严格守恒");
});

test("resolveAnchorScrollTop handles positive and negative offsetTop with listOrigin", () => {
	const rows = [
		{ key: "r1", anchorId: "r1", item: makeRun("r1"), sourceIndex: 0, messageIds: ["r1"] },
		{ key: "r2", anchorId: "r2", item: makeRun("r2"), sourceIndex: 1, messageIds: ["r2"] },
	];
	const measured = new Map([
		["r1", 100],
		["r2", 200],
	]);
	const geom = computeTimelineGeometry(rows, measured, 12);
	// r2 起始点为 100 + 12 = 112
	const listOrigin = 84;

	// offsetTop = +20 (行顶在视口下方 20px) => targetScrollTop = 84 + 112 - 20 = 176
	const topPos = resolveAnchorScrollTop(geom, 1, 20, listOrigin);
	assert.equal(topPos, 176);

	// offsetTop = -20 (行顶在视口上方 20px) => targetScrollTop = 84 + 112 - (-20) = 216
	const topNeg = resolveAnchorScrollTop(geom, 1, -20, listOrigin);
	assert.equal(topNeg, 216);
});
