import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ScanReadQueue } from "./ScanReadQueue";

/**
 * 运行记录文件 → 已解析出的会话身份，按文件 (mtimeMs, size) 失效。
 * 只保存规范化后的会话路径，从不保留原始（可能嵌套很深的）运行记录。
 */
export type SubagentRecordCache = Map<string, { mtimeMs: number; size: number; sessionFiles: readonly string[] }>;

/** Extract only session identities, never retain the original (possibly nested) run record. */
function collectSessionFiles(value: unknown, result: Set<string>, normalize: (path: string) => string): void {
	if (!value || typeof value !== "object") return;
	if ("sessionFile" in value && typeof value.sessionFile === "string" && value.sessionFile.trim()) {
		result.add(normalize(value.sessionFile.trim()));
	}
	const children: unknown[] = Object.values(value);
	for (const child of children) collectSessionFiles(child, result, normalize);
}

/**
 * Bounded asynchronous snapshot of local pi-subagents records, preserving legacy depth/layout rules.
 *
 * 扫描每轮都强制刷新快照（新建子代理会话必须及时被识别），传入 cache 时只重读
 * (mtimeMs, size) 变化的记录文件：新鲜度不变，未变化的大量历史记录不再每轮读取+解析。
 */
export async function readSubagentRecords(
	temporaryRoot: string,
	customRoot: string | undefined,
	normalize: (path: string) => string,
	queue: ScanReadQueue,
	signal?: AbortSignal,
	cache?: SubagentRecordCache,
): Promise<Set<string>> {
	const result = new Set<string>();
	/** 本轮仍存在的记录文件；完整结束后据此淘汰已删除文件的缓存条目。 */
	const seen = new Set<string>();
	const readRecord = async (path: string, readSignal: AbortSignal): Promise<void> => {
		if (!cache) {
			const text = await readFile(path, { encoding: "utf8", signal: readSignal });
			const value: unknown = JSON.parse(text);
			collectSessionFiles(value, result, normalize);
			return;
		}
		const info = await stat(path);
		seen.add(path);
		const hit = cache.get(path);
		if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
			for (const file of hit.sessionFiles) result.add(file);
			return;
		}
		try {
			const text = await readFile(path, { encoding: "utf8", signal: readSignal });
			const files = new Set<string>();
			const value: unknown = JSON.parse(text);
			collectSessionFiles(value, files, normalize);
			// 版本取自读前 stat：读取期间若又被改写，下一轮 stat 不同会再读（安全方向）。
			cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, sessionFiles: [...files] });
			for (const file of files) result.add(file);
		} catch (error) {
			// 写入中的半个 JSON 不能被缓存成「没有会话」，下一轮必须重读。
			cache.delete(path);
			throw error;
		}
	};
	const visit = async (directory: string, depth: number): Promise<void> => {
		signal?.throwIfAborted();
		if (depth < 0) return;
		try {
			const entries = await queue.run(() => readdir(directory, { withFileTypes: true }), signal);
			await Promise.all(entries.map(async (entry) => {
				const path = join(directory, entry.name);
				if (entry.isFile() && entry.name.endsWith(".json")) {
					try {
						await queue.run((readSignal) => readRecord(path, readSignal), signal);
					} catch { signal?.throwIfAborted(); }
				} else if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(path, depth - 1);
			}));
		} catch { signal?.throwIfAborted(); }
	};
	try {
		const entries = await queue.run(() => readdir(temporaryRoot, { withFileTypes: true }), signal);
		await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-subagents-"))
			.map((entry) => visit(join(temporaryRoot, entry.name), 3)));
	} catch { signal?.throwIfAborted(); }
	if (customRoot) await visit(customRoot, 3);
	// 只有完整走完一轮才淘汰（中途取消会在上面抛出），避免把未遍历到的记录误删。
	if (cache) {
		for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
	}
	return result;
}
