import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("pi-subagents 在 running 阶段就下发 sessionFile（否则侧栏运行中永远没有条目）", () => {
	// 跨仓契约：PiDeck 的 tracker 按 sessionFile 登记运行态，而扩展的 partial 快照
	// 只是 {...result} 展开。如果 result.sessionFile 只在收尾时赋值，运行期的每一次
	// tool_execution_update 都会被 extractSubagentRunUpdates 丢掉——表现为子代理跑的时候
	// 不点灯、结束后才从终态帧学到一次 completed（用户报告的正是这个顺序）。
	const source = readFileSync(
		"resources/extensions/pideck-q-subagents/src/runs/foreground/execution.ts",
		"utf8",
	);
	const literalStart = source.indexOf("const result: SingleResult = withRunContext({");
	assert.ok(literalStart > 0, "找不到初始 result 字面量");
	const literalEnd = source.indexOf("}, options.context);", literalStart);
	assert.ok(literalEnd > literalStart, "找不到初始 result 字面量的结尾");
	assert.match(
		source.slice(literalStart, literalEnd),
		/sessionFile: options\.sessionFile/,
		"初始 result 必须带上子会话路径，partial 快照才能透出运行中的子会话来",
	);

	// 快照函数必须保留该字段：snapshotStreamResult（onUpdate 用的流式快照）
	// 基于 snapshotResult，而后者靠 {...result} 展开，不是白名单拷贝。
	const snapshotStart = source.indexOf("function snapshotResult(");
	assert.ok(snapshotStart > 0);
	assert.match(source.slice(snapshotStart, snapshotStart + 400), /\.\.\.result,/);
	const streamStart = source.indexOf("function snapshotStreamResult(");
	assert.ok(streamStart > 0);
	assert.match(source.slice(streamStart, streamStart + 200), /snapshotResult\(result, progress\)/);
});
