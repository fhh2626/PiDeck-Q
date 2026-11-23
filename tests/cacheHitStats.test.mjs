import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ── 类型与接线契约 ──

test("AgentRuntimeState 携带平均命中率与样本数字段", () => {
	const source = readFileSync("src/shared/types/agent.ts", "utf8");
	assert.match(source, /cacheHitAveragePercent\?: number \| null/);
	assert.match(source, /cacheHitSampleCount\?: number/);
});

test("SessionStatus 优先使用主进程平均，快照历史仅作回退", () => {
	const source = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	assert.match(source, /state\.cacheHitAveragePercent/);
	assert.match(source, /cacheHitSampleCount/);
	// 头部 cache chip 展示会话平均命中率，不再只显示最后一次
	assert.match(source, /averageCacheHit != null/);
	assert.match(source, /averageCacheHit\.toFixed\(1\)/);
	// 会话费用展示与 CNY 换算已移除
	assert.doesNotMatch(source, /cost-chip/);
	assert.doesNotMatch(source, /USD_TO_CNY_RATE/);
	assert.doesNotMatch(source, /ctx\.detail\.cost/);
});
