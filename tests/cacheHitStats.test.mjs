import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 会话缓存命中率统计（cacheHitStats）：latest = 最后一条 assistant 消息，
 * average = 全部 assistant 消息的平均（「当前会话平均缓存率」）。
 */

function loadCacheHitStats() {
	const source = readFileSync("src/main/pi/cacheHitStats.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "cacheHitStats.ts",
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "cacheHitStats.ts" });
	return sandbox.exports;
}

/** 构造一条 assistant 消息 JSONL；usage 缺省时不给 usage 字段 */
function assistantLine(overrides = {}) {
	const usage = overrides.usage === undefined
		? { input: 100, cacheRead: 50, cacheWrite: 50 }
		: overrides.usage;
	return JSON.stringify({
		type: "message",
		id: `e${overrides.id ?? 1}`,
		parentId: null,
		timestamp: "2026-08-02T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			...(usage ? { usage } : {}),
		},
	});
}

function userLine() {
	return JSON.stringify({
		type: "message",
		id: "u1",
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
}

const json = (value) => JSON.stringify(value);

test("computeCacheHitStats: 空文件/无样本返回 undefined", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	assert.equal(json(computeCacheHitStats("")), json({ latest: undefined, average: undefined, sampleCount: 0, messageChars: 0 }));
	// 只有 user 消息与无 usage 的 assistant 消息：无样本（字符数仍统计）
	const noUsage = `${userLine()}\n${assistantLine({ usage: null })}\n`;
	const stats = computeCacheHitStats(noUsage);
	assert.equal(json(stats), json({ latest: undefined, average: undefined, sampleCount: 0, messageChars: 4 }));
});

test("computeCacheHitStats: 单条消息 latest === average", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	// cacheRead 50 / (100 + 50 + 50) = 25%
	const stats = computeCacheHitStats(assistantLine());
	assert.equal(stats.sampleCount, 1);
	assert.equal(stats.latest, 25);
	assert.equal(stats.average, 25);
});

test("computeCacheHitStats: 多条消息取平均，latest 取最后一条", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const line1 = assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }); // 50%
	const line2 = assistantLine({ id: 2, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }); // 0%
	const line3 = assistantLine({ id: 3, usage: { input: 100, cacheRead: 75, cacheWrite: 25 } }); // 37.5%
	// 中间夹 user 消息与坏行，不应影响统计
	const raw = [line1, userLine(), "not-json{{{", line2, userLine(), line3].join("\n");
	const stats = computeCacheHitStats(raw);
	assert.equal(stats.sampleCount, 3);
	assert.equal(stats.latest, 37.5);
	assert.equal(stats.average, (50 + 0 + 37.5) / 3);
});

test("computeCacheHitStats: 无有效 token 的 usage 跳过", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const raw = [
		assistantLine({ id: 1, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
		assistantLine({ id: 2, usage: { input: 100, cacheRead: 25, cacheWrite: 75 } }), // 12.5%
	].join("\n");
	const stats = computeCacheHitStats(raw);
	assert.equal(stats.sampleCount, 1);
	assert.equal(stats.latest, 12.5);
	assert.equal(stats.average, 12.5);
});

test("hitRateFromUsage: 口径为 cacheRead / (input + cacheRead + cacheWrite)", () => {
	const { hitRateFromUsage } = loadCacheHitStats();
	assert.equal(hitRateFromUsage(undefined), undefined);
	assert.equal(hitRateFromUsage({}), undefined);
	assert.equal(hitRateFromUsage({ input: 100, cacheRead: 50, cacheWrite: 50 }), 25);
});

test("computeCacheHitStats: messageChars 统计全部消息文本（含裸 text 字段与坏行容忍）", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	// assistantLine 的 content 是 [{type:"text",text:"ok"}]（2 字符），userLine 是 "hi"（2 字符）
	const raw = [
		assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }),
		userLine(),
		// 兼容裸 text 字段消息（content 数组缺失时按 text 计数）
		JSON.stringify({ type: "message", id: "u2", parentId: null, message: { role: "user", text: "hello 世界" } }),
		"not-json{{{",
	].join("\n");
	const stats = computeCacheHitStats(raw);
	// ok(2) + hi(2) + "hello 世界"(8，含空格) = 12；坏行不计数不中断
	assert.equal(stats.messageChars, 12);
	assert.equal(stats.sampleCount, 1);
});

// ── 文件级缓存读取器（性能：避免高频 getRuntimeState 反复读文件+parse）──

test("createCacheHitStatsReader: 文件未变化时命中缓存，不再读文件", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	let readCount = 0;
	let statCount = 0;
	const meta = { size: 100, mtimeMs: 1000 };
	const reader = createCacheHitStatsReader({
		readFile: async () => { readCount += 1; return assistantLine(); },
		stat: async () => { statCount += 1; return meta; },
	});
	const first = await reader("s1.jsonl");
	assert.equal(readCount, 1);
	assert.equal(first.average, 25);
	// 再次读取：size/mtime 未变 → 缓存命中，不读文件
	const second = await reader("s1.jsonl");
	assert.equal(readCount, 1);
	assert.equal(second.average, 25);
});

test("createCacheHitStatsReader: 文件变化后重新解析", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	let size = 100;
	let content = assistantLine();
	const reader = createCacheHitStatsReader({
		readFile: async () => content,
		stat: async () => ({ size, mtimeMs: size }),
	});
	await reader("s1.jsonl");
	// 会话新增一条消息：size/mtime 变化 → 重读重算
	size = 200;
	content = [
		assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }), // 50%
		assistantLine({ id: 2, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }), // 0%
	].join("\n");
	const updated = await reader("s1.jsonl");
	assert.equal(updated.sampleCount, 2);
	assert.equal(updated.average, 25);
	assert.equal(updated.latest, 0);
});

test("createCacheHitStatsReader: 不同会话各自缓存互不干扰", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const contents = new Map([
		["a.jsonl", assistantLine({ id: 1, usage: { input: 100, cacheRead: 50, cacheWrite: 50 } })], // 25%
		["b.jsonl", assistantLine({ id: 2, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } })], // 50%
	]);
	const reader = createCacheHitStatsReader({
		readFile: async (p) => contents.get(p) ?? "",
		stat: async (p) => ({ size: contents.get(p)?.length ?? 0, mtimeMs: 1 }),
	});
	const a = await reader("a.jsonl");
	const b = await reader("b.jsonl");
	const a2 = await reader("a.jsonl"); // 命中缓存
	assert.equal(a.average, 25);
	assert.equal(b.average, 50);
	assert.equal(a2.average, 25);
});

test("createCacheHitStatsReader: 文件不可读返回空统计且不缓存", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const reader = createCacheHitStatsReader({
		readFile: async () => { throw new Error("ENOENT"); },
		stat: async () => { throw new Error("ENOENT"); },
	});
	const result = await reader("missing.jsonl");
	assert.equal(result.sampleCount, 0);
	assert.equal(result.average, undefined);
});

// ── 类型与接线契约 ──

test("AgentRuntimeState 携带平均命中率与样本数字段", () => {
	const source = readFileSync("src/shared/types/agent.ts", "utf8");
	assert.match(source, /cacheHitAveragePercent\?: number \| null/);
	assert.match(source, /cacheHitSampleCount\?: number/);
});

test("AgentManager getRuntimeState 返回平均命中率（读取会话文件统计）", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /getSessionCacheHitStats/);
	assert.match(source, /cacheHitAveragePercent/);
	assert.match(source, /cacheHitSampleCount: fileHitStats\.sampleCount/);
	// 旧的「只读最后一条」实现已移除
	assert.doesNotMatch(source, /getLatestCacheMessageHitRate/);
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
