/**
 * agentCodeTokenCache —— shiki 代码高亮结果的进程内缓存（独立模块便于单测）。
 *
 * 为什么有上限：一条高亮结果可达数十 KB，长会话中代码块不断累积，
 * 无限 Map 会让渲染进程 JS 堆只涨不缩。高亮是廉价可重算的，
 * 淘汰只损失一次重算，不损失正确性（内存换时间的天平在这里应偏向内存）。
 *
 * 为什么是「逐条 LRU + 字节预算」而不是「满 200 就整体清空」：
 * 整体清空会让正在看的那个代码块也被丢掉，接着又立刻重算同一批最热的条目，
 * 形成抖动。逐条淘汰按最近最少使用序回收，热条目（当前可见的代码块）能留下。
 * 条数上限管不住单条体积，所以同时用估算字节数兜底。
 */

export interface AgentCodeToken {
	content: string;
	offset: number;
	light?: string;
	dark?: string;
}

export type AgentCodeTokenLines = AgentCodeToken[][];

/** 缓存条目数上限：超过后按最近最少使用逐条淘汰。 */
export const MAX_TOKEN_CACHE_ENTRIES = 200;
/** 缓存估算总字节上限：条数少但单条很大的场景由它兜底。 */
export const MAX_TOKEN_CACHE_ESTIMATED_BYTES = 16 * 1024 * 1024;
/** 单条估算字节上限：超过则不缓存（避免一条就挤掉整个缓存）。 */
export const MAX_TOKEN_CACHE_ENTRY_ESTIMATED_BYTES = 4 * 1024 * 1024;

interface CacheEntry {
	lines: AgentCodeTokenLines;
	estimatedBytes: number;
}

// Map 的插入顺序就是 LRU 序：命中后重新 set 到末尾，淘汰时取第一个 key。
const tokenCache = new Map<string, CacheEntry>();
let estimatedBytesTotal = 0;

/**
 * 估算一条高亮结果的常驻内存。
 *
 * 只求量级正确、计算廉价（每次写入都要算）：字符串按 UTF-16 码元 2 字节，
 * 每个 token 对象本身的固定开销按 64 字节估，每个 token 数组/行按 24 字节估。
 */
function estimateBytes(key: string, lines: AgentCodeTokenLines): number {
	let tokenBytes = 0;
	for (const line of lines) {
		for (const token of line) {
			tokenBytes +=
				64 +
				token.content.length * 2 +
				(token.light?.length ?? 0) * 2 +
				(token.dark?.length ?? 0) * 2;
		}
	}
	return key.length * 2 + lines.length * 24 + tokenBytes;
}

/** 淘汰最久未使用的条目，直到条数与字节数都回到预算内。 */
function evictToBudget(): void {
	while (
		tokenCache.size > MAX_TOKEN_CACHE_ENTRIES ||
		estimatedBytesTotal > MAX_TOKEN_CACHE_ESTIMATED_BYTES
	) {
		const oldest = tokenCache.keys().next();
		if (oldest.done) return;
		dropEntry(oldest.value);
	}
}

function dropEntry(key: string): void {
	const entry = tokenCache.get(key);
	if (!entry) return;
	tokenCache.delete(key);
	estimatedBytesTotal -= entry.estimatedBytes;
}

/** 写入缓存；超预算时逐条淘汰最久未使用的条目（可重算，不损失正确性）。 */
export function cacheTokens(key: string, lines: AgentCodeTokenLines): void {
	const estimatedBytes = estimateBytes(key, lines);
	// 单条就超过整块预算时不缓存：否则它会把整个缓存挤空且下次仍然命中不了。
	if (estimatedBytes > MAX_TOKEN_CACHE_ENTRY_ESTIMATED_BYTES) {
		dropEntry(key);
		return;
	}
	dropEntry(key);
	tokenCache.set(key, { lines, estimatedBytes });
	estimatedBytesTotal += estimatedBytes;
	evictToBudget();
}

/** 读取缓存；命中时刷新 LRU 位置，未命中返回 undefined（调用方走完整高亮流程）。 */
export function getCachedTokens(key: string): AgentCodeTokenLines | undefined {
	const entry = tokenCache.get(key);
	if (!entry) return undefined;
	// 重新插入到末尾 = 标记为最近使用。
	tokenCache.delete(key);
	tokenCache.set(key, entry);
	return entry.lines;
}

/** 当前缓存条目数（诊断用，不参与业务判断）。 */
export function tokenCacheSize(): number {
	return tokenCache.size;
}

/** 当前缓存估算字节数（诊断用，不参与业务判断）。 */
export function tokenCacheEstimatedBytes(): number {
	return estimatedBytesTotal;
}
