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

export type PlainStreamParagraph = {
	frozen: string;
	live: string;
};

export type PlainStreamParagraphsResult = {
	paragraphs: PlainStreamParagraph[];
	frozen: string[];
	live: string[];
};

export type IncrementalStreamSplitter = {
	split(text: string, split: number): PlainStreamParagraphsResult;
	reset(): void;
};

/**
 * 创建针对流式纯文本的增量段落分段器。
 *
 * 核心机制（对齐计划步骤 B）：
 * - 在 4096 字符冻结步进区间内，已闭合的冻结段落对象保持对象引用不变；
 * - 冻结前缀内部退过末尾连续的 `\n` 得到 scanEnd，新追加增量只对 `text.slice(scanEnd)`
 *   运行空白行正则，保证跨 split 边界的换行符（如前半个 `\n` + 后半个 `\n`）能被准确识别为同一分隔符；
 * - split 变化、文本缩短或前缀发生改写时自动失效重建；
 * - 输出结果在任何文本/边界情况下均与基础纯函数 splitPlainStreamParagraphs 严格一致。
 */
export function createIncrementalStreamParagraphsSplitter(): IncrementalStreamSplitter {
	let cachedSplit = -1;
	let cachedPrefix = "";
	let cachedScanEnd = 0;
	let cachedCompletedParagraphs: PlainStreamParagraph[] = [];
	let cachedTailPrefix: { start: number } | null = null;

	function invalidate(text: string, split: number, safeFrozenEnd: number) {
		cachedSplit = split;
		cachedPrefix = text.slice(0, safeFrozenEnd);

		// 从 split 边界向前退过末尾连续的 \n，避免将未闭合的分隔符当成段落结尾
		let scanEnd = safeFrozenEnd;
		while (scanEnd > 0 && text.charCodeAt(scanEnd - 1) === 10 /* '\n' */) {
			scanEnd--;
		}
		cachedScanEnd = scanEnd;

		// 对 0..scanEnd 范围运行分段，提取已闭合段落与未闭合尾部前缀
		cachedCompletedParagraphs = [];
		cachedTailPrefix = null;

		if (scanEnd === 0) {
			return;
		}

		const prefixScanText = text.slice(0, scanEnd);
		const separatorRegex = /\n{2,}/g;
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = separatorRegex.exec(prefixScanText)) !== null) {
			const start = lastIndex;
			const end = match.index;
			if (end > start) {
				const frozenLen = Math.max(0, Math.min(end, safeFrozenEnd) - start);
				cachedCompletedParagraphs.push({
					frozen: text.slice(start, start + frozenLen),
					live: text.slice(start + frozenLen, end),
				});
			}
			lastIndex = separatorRegex.lastIndex;
		}

		if (lastIndex < scanEnd) {
			// 在 scanEnd 处仍有文字尚未遇到闭合的 \n{2,}，记录其起始位置
			cachedTailPrefix = { start: lastIndex };
		}
	}

	function reset() {
		cachedSplit = -1;
		cachedPrefix = "";
		cachedScanEnd = 0;
		cachedCompletedParagraphs = [];
		cachedTailPrefix = null;
	}

	return {
		reset,
		split(text: string, split: number): PlainStreamParagraphsResult {
			if (!text) {
				reset();
				return { paragraphs: [], frozen: [], live: [] };
			}

			// 当没有冻结前缀（split === 0 或文本尚未达到 split）时，无稳定冻结前缀，直接走基础分段
			if (split <= 0 || text.length < split) {
				reset();
				return splitPlainStreamParagraphs(text, split);
			}

			// 缓存失效检测：split 发生跳变，或前缀被改写
			if (
				cachedSplit !== split ||
				cachedPrefix.length !== split ||
				!text.startsWith(cachedPrefix)
			) {
				invalidate(text, split, split);
			}

			// 如果 scanEnd === 0，退化为基础分段
			if (cachedScanEnd === 0) {
				return splitPlainStreamParagraphs(text, split);
			}

			// 复用已完成的冻结段落对象引用
			const paragraphs: PlainStreamParagraph[] = [...cachedCompletedParagraphs];

			// 仅对 text.slice(cachedScanEnd) 进行尾部扫描
			const suffix = text.slice(cachedScanEnd);
			const separatorRegex = /\n{2,}/g;
			let lastSuffixIndex = 0;
			let match: RegExpExecArray | null;
			let first = true;

			while ((match = separatorRegex.exec(suffix)) !== null) {
				const end = cachedScanEnd + match.index;
				let start: number;

				if (first && cachedTailPrefix) {
					start = cachedTailPrefix.start;
				} else {
					start = cachedScanEnd + lastSuffixIndex;
				}
				first = false;

				if (end > start) {
					const frozenLen = Math.max(0, Math.min(end, split) - start);
					paragraphs.push({
						frozen: text.slice(start, start + frozenLen),
						live: text.slice(start + frozenLen, end),
					});
				}
				lastSuffixIndex = separatorRegex.lastIndex;
			}

			const end = text.length;
			let start: number;
			if (first && cachedTailPrefix) {
				start = cachedTailPrefix.start;
			} else {
				start = cachedScanEnd + lastSuffixIndex;
			}

			if (end > start) {
				const frozenLen = Math.max(0, Math.min(end, split) - start);
				paragraphs.push({
					frozen: text.slice(start, start + frozenLen),
					live: text.slice(start + frozenLen, end),
				});
			}

			const frozen = paragraphs
				.filter((p) => p.frozen.length > 0 && p.live.length === 0)
				.map((p) => p.frozen);
			const live = paragraphs
				.filter((p) => p.live.length > 0)
				.map((p) => (p.frozen ? p.frozen + p.live : p.live));

			return { paragraphs, frozen, live };
		},
	};
}

/** 流式纯文本按 Markdown 空白行（\n{2,}）分段，并精确划分每个段落内的冻结与活动切片。 */
export function splitPlainStreamParagraphs(text: string, frozenEnd: number): PlainStreamParagraphsResult {
	if (!text) {
		return { paragraphs: [], frozen: [], live: [] };
	}
	const safeFrozenEnd = Math.max(0, Math.min(text.length, frozenEnd));
	const paragraphs: PlainStreamParagraph[] = [];
	const separatorRegex = /\n{2,}/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = separatorRegex.exec(text)) !== null) {
		const start = lastIndex;
		const end = match.index;
		if (end > start) {
			const frozenLen = Math.max(0, Math.min(end, safeFrozenEnd) - start);
			paragraphs.push({
				frozen: text.slice(start, start + frozenLen),
				live: text.slice(start + frozenLen, end),
			});
		}
		lastIndex = separatorRegex.lastIndex;
	}

	if (lastIndex < text.length) {
		const start = lastIndex;
		const end = text.length;
		const frozenLen = Math.max(0, Math.min(end, safeFrozenEnd) - start);
		paragraphs.push({
			frozen: text.slice(start, start + frozenLen),
			live: text.slice(start + frozenLen, end),
		});
	}

	const frozen = paragraphs
		.filter((p) => p.frozen.length > 0 && p.live.length === 0)
		.map((p) => p.frozen);
	const live = paragraphs
		.filter((p) => p.live.length > 0)
		.map((p) => (p.frozen ? p.frozen + p.live : p.live));

	return { paragraphs, frozen, live };
}
