import { fileChangeToDiffLines } from "../TimelineFormat";
import type { FileDiffLine, FileDiffLineSource } from "../../agents/file-diff";

/**
 * 单个文件修改的「惰性行数据源」。
 *
 * 为什么要有这一层：TurnFileChanges 会给一轮里的每个改动文件都挂一个 FileDiff，
 * 而完整行数组（拆全文 + 每行一个对象）在长会话里相当可观。收起时不展开正文，
 * 也就没人需要这些行——把构造推迟到真正展开的那一刻。
 *
 * 计数不拆行：只逐字符数 `\n`，与 fileChangeToDiffLines 的行语义完全一致
 * （空的新内容仍算 1 行；空旧内容不产生 removed 行）。这样文件名行上的
 * `+n / −n` 不需要先构造行数组就能显示。
 */

/** 统计文本行数：与 split("\n").length 等价，但不分配中间数组。 */
function countLines(text: string): number {
	let count = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\n") count += 1;
	}
	return count;
}

export function createTurnFileDiffSource(entry: {
	originalContent: string;
	content: string;
}): FileDiffLineSource {
	// 捕获字符串快照：后续 entry 对象被替换也不影响本 source 的内容。
	const originalContent = entry.originalContent;
	const content = entry.content;
	const hasOld = originalContent.length > 0;
	// 惰性缓存：构造一次后复用同一数组引用（React 依赖比较因此稳定）。
	let cached: FileDiffLine[] | undefined;
	return {
		additions: countLines(content),
		deletions: hasOld ? countLines(originalContent) : 0,
		getLines: () => {
			if (!cached) cached = fileChangeToDiffLines({ originalContent, content });
			return cached;
		},
	};
}
