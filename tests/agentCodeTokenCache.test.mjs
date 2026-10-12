/**
 * agentCodeTokenCache 单测 —— 高亮缓存的容量策略（内存策略的回归保护）。
 *
 * 策略：逐条 LRU 淘汰 + 估算字节预算，而不是「满 200 条整体清空」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cacheTokens,
	getCachedTokens,
	tokenCacheSize,
	tokenCacheEstimatedBytes,
	MAX_TOKEN_CACHE_ENTRIES,
	MAX_TOKEN_CACHE_ESTIMATED_BYTES,
	MAX_TOKEN_CACHE_ENTRY_ESTIMATED_BYTES,
} from "../src/renderer/src/components/agents/agentCodeTokenCache.ts";

/** 构造指定 token 数量的高亮行，用于可控地撑起估算字节。 */
function lines(tokens, size = 1) {
	return [
		Array.from({ length: tokens }, (_, i) => ({
			content: "x".repeat(size),
			offset: i,
		})),
	];
}

test("cacheTokens 写入后可读回", () => {
	const value = lines(1);
	cacheTokens("json\u0000{}", value);
	assert.equal(getCachedTokens("json\u0000{}"), value);
});

test("未命中的 key 返回 undefined（调用方走完整高亮）", () => {
	assert.equal(getCachedTokens("nope\u0000nothing"), undefined);
});

test("超过条目上限时逐条淘汰，缓存不无限增长（防 JS 堆泄漏）", () => {
	const total = MAX_TOKEN_CACHE_ENTRIES * 2;
	for (let i = 0; i < total; i++) cacheTokens(`k-${i}`, lines(1));
	assert.ok(
		tokenCacheSize() <= MAX_TOKEN_CACHE_ENTRIES,
		`size=${tokenCacheSize()} 超过上限 ${MAX_TOKEN_CACHE_ENTRIES}`,
	);
	// 最新条目必须可读；最早条目应已被逐条淘汰。
	assert.ok(getCachedTokens(`k-${total - 1}`));
	assert.equal(getCachedTokens("k-0"), undefined);
});

test("逐条淘汰保住在用条目：最近读过的老条目不会被新写入挤掉", () => {
	// 灌满到上限，再反复读取早期条目使其成为最近使用。
	for (let i = 0; i < MAX_TOKEN_CACHE_ENTRIES; i++) cacheTokens(`k-${i}`, lines(1));
	const hot = `k-0`;
	assert.ok(getCachedTokens(hot));
	// 写入少量新条目，只会淘汰最久未使用的那些。
	for (let i = 0; i < 5; i++) {
		cacheTokens(`new-${i}`, lines(1));
	}
	assert.ok(
		getCachedTokens(hot),
		"命中的热条目必须在淘汰后仍然存活（不是整体清空）",
	);
	assert.equal(getCachedTokens(`k-1`), undefined, "最久未使用的条目应被淘汰");
});

test("重复写入同一个 key 不会重复计数", () => {
	const before = tokenCacheSize();
	cacheTokens("dup", lines(1));
	const afterFirst = tokenCacheSize();
	cacheTokens("dup", lines(1));
	assert.equal(tokenCacheSize(), afterFirst);
	// 满容量时插入会触发淘汰，但写入的 key 必须仍然可读。
	assert.ok(getCachedTokens("dup"));
	assert.ok(before <= MAX_TOKEN_CACHE_ENTRIES);
});

test("字节预算兜底：条目数未超上限也会因总字节超预算而淘汰", () => {
	// 每条大约 1MB（256KB 内容 → 每 token 64 + 2*len），远小于单条上限 4MB，
	// 但 32 条就会超过 16MB 总预算。
	const chunk = lines(1, 400 * 1024);
	for (let i = 0; i < 40; i++) cacheTokens(`big-${i}`, chunk);
	assert.ok(
		tokenCacheEstimatedBytes() <= MAX_TOKEN_CACHE_ESTIMATED_BYTES,
		`bytes=${tokenCacheEstimatedBytes()} 超过预算 ${MAX_TOKEN_CACHE_ESTIMATED_BYTES}`,
	);
	assert.ok(tokenCacheSize() < 40, "必须发生淘汰，而不是全部留存");
	assert.ok(getCachedTokens("big-39"), "最新条目仍应可读");
});

test("单条超过单条上限时不缓存，且不会挤掉已有条目", () => {
	cacheTokens("small", lines(1));
	const keep = getCachedTokens("small");
	const oversized = [
		Array.from(
			{ length: Math.ceil(MAX_TOKEN_CACHE_ENTRY_ESTIMATED_BYTES / 2) + 16 },
			(_, i) => ({ content: "y", offset: i }),
		),
	];
	cacheTokens("huge", oversized);
	assert.equal(getCachedTokens("huge"), undefined, "超大单条不得写入缓存");
	assert.equal(getCachedTokens("small"), keep, "已有条目不应被超大单条挤掉");
	assert.equal(tokenCacheEstimatedBytes() > 0, true);
});

test("写入同一个 key 两次时字节账目不重复累计", () => {
	cacheTokens("swap", lines(1, 1024));
	const first = tokenCacheEstimatedBytes();
	cacheTokens("swap", lines(1, 1024));
	assert.equal(tokenCacheEstimatedBytes(), first);
});
