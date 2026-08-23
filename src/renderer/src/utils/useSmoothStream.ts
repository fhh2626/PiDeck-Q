import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useSmoothStream - 流式文本平滑渲染 Hook（逐字打字机）。
 *
 * 将高频推送的完整文本转化为平滑的逐字渲染效果（参考 Cherry Studio / Proma 实现）：
 *
 * 核心机制：
 * 1. 内容变化时用 startsWith 判断追加，增量经 Intl.Segmenter 拆为字符粒度入队
 *    （Intl.Segmenter 正确处理中文/日文/韩文等多字节字符）；
 * 2. requestAnimationFrame 驱动渲染循环；
 * 3. 每帧动态计算渲染字符数：队列长时快速追赶（/divisor），短时慢速浮现；
 * 4. 流结束后加速但渐进排空队列（不一次性 dump，避免跳动）。
 *
 * 设计说明：
 * - 只影响"展示"；权威文本在 atom/父组件中不受影响（复制/导出仍拿全文）。
 * - 纯 hook，不依赖任何 UI 库；与 timeline/turn 领域模型解耦。
 *
 * 性能注意（Pideck 特有）：streamdown 每次解析的是完整文本，逐字渐显会把解析频率
 * 提到 rAF 级别；若界面卡顿，调大 minDelay（如 24/33ms）或降低 divisor。
 */

interface UseSmoothStreamOptions {
	/** 原始流式内容（每次 chunk 累积后的完整文本） */
	content: string;
	/** 是否正在流式输出中 */
	isStreaming: boolean;
	/**
	 * 禁用平滑（折叠态用）：直接同步返回 content，不启动 rAF 打字机。
	 * 折叠态内容不可见，逐字推进是纯浪费；展开瞬间以全文呈现（与打字机追平后的观感一致）。
	 */
	disabled?: boolean;
	/** 每帧最小间隔（ms）。默认 8ms（~120Hz 屏平滑），长文本自动上调 */
	minDelay?: number;
	/** 渲染速率除数：队列剩余 / divisor = 本帧渲染字符数（流式中） */
	streamingDivisor?: number;
	/** 流结束后的排空除数（加速但渐进，不 dump） */
	drainDivisor?: number;
	/** 每帧最大步进字符数（流式中） */
	maxStepPerFrame?: number;
	/** 每帧最大排空步进字符数（流结束后） */
	maxDrainStepPerFrame?: number;
}

interface UseSmoothStreamReturn {
	/** 平滑后的显示内容 */
	displayedContent: string;
}

/** 多语言字符分割器（正确处理中文、日文等多字节字符） */
const segmenter = new Intl.Segmenter([
	"en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "de-DE", "fr-FR", "es-ES", "pt-PT", "ru-RU",
]);

/**
 * 流式空转停帧阈值（ms）：队列空且超过该时长没有新 delta（流式通道卡死/中断、
 * run 状态未正确收尾）时停掉 60fps rAF 空转，避免烧 CPU；新 delta 到达时
 * content effect 会重新唤醒打字机。
 */
const IDLE_STOP_MS = 3000;

function segmentText(text: string): string[] {
	return Array.from(segmenter.segment(text)).map((s) => s.segment);
}

/**
 * 头部索引队列：长时间流式下避免 Array.splice(0, n) 的线性搬移成本。
 * 消费只推进 head 指针，偶尔（head 越过 4096 且已消费过半）整体前移回收，
 * 摊还 O(1) 入队/出队，回答越长队列越大时越明显地省成本。
 */
type StreamQueue = {
	items: string[];
	head: number;
};

function queueLength(queue: StreamQueue): number {
	return queue.items.length - queue.head;
}

function clearQueue(queue: StreamQueue) {
	queue.items = [];
	queue.head = 0;
}

function pushQueue(queue: StreamQueue, chars: string[]) {
	queue.items.push(...chars);
}

function takeQueue(queue: StreamQueue, count: number): string[] {
	const end = Math.min(queue.head + count, queue.items.length);
	const result = queue.items.slice(queue.head, end);
	queue.head = end;

	// head 增长到 4096 以上且已消费过半时整体前移回收，避免 items 无限增长
	if (queue.head > 4096 && queue.head * 2 >= queue.items.length) {
		queue.items = queue.items.slice(queue.head);
		queue.head = 0;
	}

	return result;
}

export function useSmoothStream({
	content,
	isStreaming,
	disabled = false,
	minDelay = 24,
	streamingDivisor = 4,
	drainDivisor = 3,
	maxStepPerFrame = 3,
	maxDrainStepPerFrame = 8,
}: UseSmoothStreamOptions): UseSmoothStreamReturn {
	const [displayedContent, setDisplayedContent] = useState(content);

	// 长文本降频（2026-08 内存/CPU 治理）：每帧 DOM 更新（文本节点替换 → layout）
	// 成本随文本长度增长，逐字 60fps 会把主线程排满 → IPC 消息积压 → 渲染进程
	// 原生内存 GB 级爬升。按长度分级降频：8K 内保持打字机手感；8K+ 降到 16ms
	// （~37fps）；64K+ 降到 33ms（~30fps）。步进上限同步放大，保证排空速率
	// （step×fps）始终高于 LLM 输出速率（100-300 字/s），队列不会越积越长。
	// 调用方显式传入的参数仍是下限之上的覆盖（Math.max 取大）。
	const effectiveMinDelay = Math.max(
		minDelay,
		content.length > 64_000 ? 33 : content.length > 8_000 ? 16 : 8,
	);
	const effectiveMaxStepPerFrame = Math.max(maxStepPerFrame, content.length > 8_000 ? 12 : 6);

	const chunkQueueRef = useRef<StreamQueue>({ items: [], head: 0 });
	// rAF ID
	const rafRef = useRef<number | null>(null);
	// 已渲染到 UI 的文本
	const displayedRef = useRef(content);
	// 上一次收到的完整内容（用于计算 delta）
	const prevContentRef = useRef(content);
	// 上次渲染时间
	const lastRenderTimeRef = useRef(0);
	// 流是否结束
	const streamDoneRef = useRef(!isStreaming);
	streamDoneRef.current = !isStreaming;
	// 最近一次内容变更时刻：空转停帧判定用（见 renderLoop 空队列分支）
	const lastChunkAtRef = useRef(performance.now());
	// 稳定引用 renderLoop：content effect 需要重启打字机，但 renderLoop 声明在后
	// （TDZ），且引用稳定，不参与 effect 依赖。
	const renderLoopRef = useRef<(currentTime: number) => void>(() => {});

	// 内容变化：计算 delta 并入队
	useEffect(() => {
		const prevContent = prevContentRef.current;
		const newContent = content;
		if (newContent === prevContent) return;

		// 折叠态（disabled）：只追平 prevContent 引用，不 push chunk 不 setState，
		// 内容不可见时连「增量入队 + 重渲染」都省掉。
		if (disabled) {
			prevContentRef.current = newContent;
			displayedRef.current = newContent;
			return;
		}

		const isAppend = newContent.startsWith(prevContent);
		if (isAppend) {
			// 正常流式追加：增量拆字符入队
			const delta = newContent.slice(prevContent.length);
			if (delta) {
				const chars = segmentText(delta);
				pushQueue(chunkQueueRef.current, chars);
				// 空转停帧后新 delta 到达：重启打字机
				if (!rafRef.current) renderLoopRef.current(performance.now());
			}
		} else {
			// 内容重置（切换消息/编辑等场景）：清空队列直接同步
			clearQueue(chunkQueueRef.current);
			displayedRef.current = newContent;
			setDisplayedContent(newContent);
		}
		prevContentRef.current = newContent;
		lastChunkAtRef.current = performance.now();
	}, [content, disabled]);

	// 非流式状态安全网：确保最终内容一致，但不立即 dump 队列（让 rAF 自然排空）
	useEffect(() => {
		if (isStreaming) return;
		if (rafRef.current) return; // rAF 仍在运行：让队列自然排空
		if (queueLength(chunkQueueRef.current) > 0) {
			displayedRef.current += chunkQueueRef.current.items.slice(chunkQueueRef.current.head).join("");
			clearQueue(chunkQueueRef.current);
		}
		if (displayedRef.current !== content) {
			displayedRef.current = content;
		}
		setDisplayedContent(displayedRef.current);
	}, [isStreaming, content]);

	// 渲染循环
	const renderLoop = useCallback(
		(currentTime: number) => {
			const queue = chunkQueueRef.current;
			if (queueLength(queue) === 0) {
				if (streamDoneRef.current) {
					// 流结束 + 队列空：同步最终内容并停止
					if (displayedRef.current !== prevContentRef.current) {
						displayedRef.current = prevContentRef.current;
						setDisplayedContent(displayedRef.current);
					}
					rafRef.current = null;
					return;
				}
				// 流式仍在但无新内容：超过空转阈值（IDLE_STOP_MS 无新 delta）则停帧，
				// 防止 run 卡死/通道中断时 60fps 空转烧 CPU；新 delta 到达时
				// content effect 会经 renderLoopRef 重新唤醒。
				if (performance.now() - lastChunkAtRef.current > IDLE_STOP_MS) {
					rafRef.current = null;
					return;
				}
				// 正常等待下一批 delta：保持挂帧
				rafRef.current = requestAnimationFrame(renderLoop);
				return;
			}

			if (currentTime - lastRenderTimeRef.current < effectiveMinDelay) {
				rafRef.current = requestAnimationFrame(renderLoop);
				return;
			}
			lastRenderTimeRef.current = currentTime;

			// 动态计算本帧渲染字符数：流中 /streamingDivisor 保持深缓冲（丝滑），
			// 结束后 /drainDivisor 加速排空
			// 步进上限：长文本 delta 堆积或 LLM 突发爆发时封顶，避免单帧 innerHTML
			// 插入巨大字符串把主线程吃满；队列堆积时加大 maxStep 保证不滞后
			const divisor = streamDoneRef.current ? drainDivisor : streamingDivisor;
			const maxStep = streamDoneRef.current ? maxDrainStepPerFrame : effectiveMaxStepPerFrame;
			const count = Math.min(Math.max(1, Math.floor(queueLength(queue) / divisor)), maxStep);
			const chars = takeQueue(queue, count);
			displayedRef.current += chars.join("");
			setDisplayedContent(displayedRef.current);

			if (queueLength(queue) > 0 || !streamDoneRef.current) {
				rafRef.current = requestAnimationFrame(renderLoop);
			} else {
				// 队列刚排空 + 流已结束：同步最终内容并停止
				if (displayedRef.current !== prevContentRef.current) {
					displayedRef.current = prevContentRef.current;
					setDisplayedContent(displayedRef.current);
				}
				rafRef.current = null;
			}
		},
		[effectiveMinDelay, effectiveMaxStepPerFrame, streamingDivisor, drainDivisor, maxDrainStepPerFrame],
	);
	renderLoopRef.current = renderLoop;

	// 启动/重启渲染循环（流结束后也继续运行直到队列排空）
	useEffect(() => {
		if (disabled) return; // 折叠态：不启动 rAF，避免不可见内容逐字推进
		if ((isStreaming || queueLength(chunkQueueRef.current) > 0) && !rafRef.current) {
			rafRef.current = requestAnimationFrame(renderLoop);
		}
		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [isStreaming, renderLoop, disabled]);

	// disabled：同步返回最新内容（展开瞬间全文立现，与打字机追平后观感一致）
	if (disabled) return { displayedContent: content };

	return { displayedContent };
}
