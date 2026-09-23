/**
 * MarkdownStream 渲染策略（纯函数，无 React 依赖，可单测）。
 *
 * 背景（2026-08 内存/CPU 治理）：
 * - 流式期间若消息「不可冻结」（未闭合代码围栏 / 内容块 ≤ 2 个，
 *   IncrementalMarkdownFrontier 返回 prefixEnd=0），Streamdown 会退化为
 *   每帧全量解析 + 全量 DOM 重建——大代码块流式输出时 GC 追不上，
 *   渲染进程原生内存持续爬升（实测可达 200-450MB/min）。
 * - settle 后整篇全量渲染（高亮逐 token span）会把超大代码块的 DOM
 *   永久留在时间线里（GB 级）。
 * 两个阈值分别把这两条路径拉回轻量渲染。
 */

/** 流式超长兜底阈值：marked 解析成本随累积文本线性增长（实测 30K≈2.3ms/帧），
 * 超过后流式期间整体回退纯文本，settle 后再全量渲染。
 * 2026-08 内存治理后恢复 40K：冻结前缀走 memo（边界不动零重解析）、增量重扫
 * O(delta)、尾部只留最后一块，>40K 的冻结路径每帧成本已与文本长度无关；
 * 40K 上限只兜底「回退纯文本」路径的 layout 成本（该路径由 split-plain 把
 * 每帧变更限制在 ≤4K 文本节点）。 */
export const STREAM_LIGHT_MAX_CHARS = 40_000;

/** 流式不可冻结兜底阈值：prefixEnd=0（未闭合围栏等）时每帧都是全量重渲染，
 * 超过该小阈值即回退纯文本；更小的消息每帧全量渲染成本可忽略，保持富渲染。 */
export const STREAM_UNFREEZABLE_MIN_CHARS = 8_000;

/** settle 全量渲染内容上限：超过后保持轻量插件（无逐 token 高亮/mermaid），
 * 防止超大代码块一次渲染留下 GB 级 DOM。 */
export const SETTLE_FULL_MAX_CHARS = 150_000;

export function shouldRenderStreamPlain(input: {
	isStreaming: boolean;
	textLength: number;
	/** 冻结切分结果：undefined = 未运行（超长跳过扫描）；0 = 不可冻结 */
	prefixEnd: number | undefined;
}): boolean {
	if (!input.isStreaming) return false;
	// 整体超长：无条件纯文本（现有兜底契约）
	if (input.textLength > STREAM_LIGHT_MAX_CHARS) return true;
	// 不可冻结且超过小阈值：每帧全量重渲染的代价不值得，流式期纯文本
	return input.prefixEnd === 0 && input.textLength > STREAM_UNFREEZABLE_MIN_CHARS;
}

export function shouldKeepLightOnSettle(textLength: number): boolean {
	return textLength > SETTLE_FULL_MAX_CHARS;
}

/** 流式纯文本按 Markdown 空白行分段，同时保留 4K 冻结前缀。 */
export function splitPlainStreamParagraphs(text: string, frozenEnd: number): {
	frozen: string[];
	live: string[];
} {
	const safeFrozenEnd = Math.max(0, Math.min(text.length, frozenEnd));
	const splitParagraphs = (value: string): string[] => value.split(/\n{2,}/);
	const frozen = safeFrozenEnd === 0
		? []
		: splitParagraphs(text.slice(0, safeFrozenEnd)).filter((paragraph) => paragraph.length > 0);
	const live = splitParagraphs(text.slice(safeFrozenEnd));
	const boundaryInsideParagraph = safeFrozenEnd > 0 && !/\n{2,}$/.test(text.slice(0, safeFrozenEnd));
	if (boundaryInsideParagraph && frozen.length > 0) {
		const continuation = live[0] ?? "";
		const newlineAt = continuation.indexOf("\n");
		const sameParagraph = newlineAt === -1 ? continuation : continuation.slice(0, newlineAt);
		frozen[frozen.length - 1] = (frozen[frozen.length - 1] + sameParagraph).replace(/\n+$/, "");
		live[0] = newlineAt === -1 ? "" : continuation.slice(newlineAt + 1).replace(/^\n+/, "");
		if (!live[0]) live.shift();
	}
	return { frozen, live };
}
