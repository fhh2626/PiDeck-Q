/**
 * 时间线滚动锚点与渲染窗口位移的规则（纯函数 + 一个薄的 DOM 命中封装）。
 *
 * 为什么单独抽出来：长会话里贴底窗口有 50 轮、单轮可含上百条工具调用。旧实现每个
 * 滚动帧都 `querySelectorAll("[data-message-id]")` 再逐行 `getBoundingClientRect()`
 * 找「视口顶部那一行」，是拖动一顿一顿的直接来源。锚点只需要 250ms 落盘一次的粒度，
 * 因此改成对视口顶部做一次命中测试：O(挂载行数) 的强制布局降为 O(1)，记录字段与语义
 * 保持不变。
 *
 * 命中测试返回行元素而不是 id：调用方还要量这一行相对视口顶的偏移，拿 id 再
 * querySelector 等于又做一次全树查找。命中测试不可用（无 document / 无 *FromPoint）
 * 或屏顶被骨架、浮层占住时返回 null，由调用方保留上一次锚点；此处禁止退回全表扫描,
 * 长会话里那等于每次都触发旧瓶颈。
 */

/** 命中探针相对视口顶部的偏移（px）。落在行间空隙/浮层时由后面的探针兜住。 */
const ANCHOR_PROBE_OFFSETS = [1, 16, 48] as const;

function anchorIdOf(node: Element): string | null {
	const id = node.getAttribute("data-message-id");
	return id ? id : null;
}

/**
 * 从命中元素向上走到滚动容器，取**最外层**带非空 `data-message-id` 的行。
 *
 * 取最外层（turn 行 / 用户气泡 / 卡片）而不是最近的嵌套工具卡，是因为锚点必须比
 * 渲染窗口的裁剪粒度更粗：嵌套卡片会被折叠卸载（阶段 A）或 `display: none` 隐藏,
 * 而隐藏节点的 getBoundingClientRect() 全零，按它对齐会把 scrollTop 算成接近 0 的
 * 垃圾值 —— 这正是「信息流跳到以前的消息」的一条真实路径。行级锚点只要该轮仍在
 * 窗口里就一定在 DOM 中，精度由 offsetTop 承担（行顶可在视口上方很多 px，恢复公式
 * 保留负值）。
 * 走到容器仍未命中返回 null（命中点可能是骨架、「显示更早」按钮或浮层）。
 */
export function findAnchorRow(hit: Element | null, timeline: Element): Element | null {
	let found: Element | null = null;
	let node: Element | null = hit;
	while (node && node !== timeline) {
		if (anchorIdOf(node) !== null) found = node;
		node = node.parentElement;
	}
	return found;
}

/** 命中栈（自顶向下）里第一个锚点行。 */
export function pickAnchorRow(hits: readonly Element[], timeline: Element): Element | null {
	for (const hit of hits) {
		const row = findAnchorRow(hit, timeline);
		if (row) return row;
	}
	return null;
}

type DocumentWithHitTest = Document & {
	elementsFromPoint?: (x: number, y: number) => Element[];
	elementFromPoint?: (x: number, y: number) => Element | null;
};

function hitsAt(doc: DocumentWithHitTest, x: number, y: number): Element[] {
	if (doc.elementsFromPoint) return doc.elementsFromPoint(x, y);
	if (doc.elementFromPoint) {
		const single = doc.elementFromPoint(x, y);
		return single ? [single] : [];
	}
	return [];
}

/**
 * DOM 侧入口：对滚动容器视口顶部逐探针命中测试，返回正在看的那一行。
 * 只读一次容器矩形，命中栈由浏览器给出，不遍历挂载行。
 */
export function resolveAnchorRow(
	timeline: Element,
	viewportTop: number,
): Element | null {
	if (typeof document === "undefined") return null;
	const doc = document as DocumentWithHitTest;
	if (!doc.elementsFromPoint && !doc.elementFromPoint) return null;
	const rect = timeline.getBoundingClientRect();
	// 水平取容器中线：贴右侧的原生滚动条槽、左缘空隙都可能有遮挡物。
	const x = rect.left + rect.width / 2;
	for (const offset of ANCHOR_PROBE_OFFSETS) {
		const y = viewportTop + offset;
		if (y > rect.bottom) break;
		const row = pickAnchorRow(hitsAt(doc, x, y), timeline);
		if (row) return row;
	}
	return null;
}

/** 锚点行的 id（无行 / 空 id 时为 null）。 */
export function anchorRowId(row: Element | null): string | null {
	return row ? anchorIdOf(row) : null;
}

/** 恢复锚点时允许逐步扩大渲染窗口的最大次数（防呆：不得无限放大窗口）。 */
export const MAX_ANCHOR_RESTORE_WIDENINGS = 12;

export type AnchorRestoreStep =
	| "restore"
	| "widen"
	| "wait-for-data"
	| "fallback-window-top";

/**
 * 锚点行没在 DOM 里时怎么办（两种看起来一样、结果不同的「找不到」）：
 * - 消息仍在数据里、只是被渲染窗口裁掉（用户先「显示更早」扩窗看到第 5 轮，切回时
 *   窗口已重置为尾部 50 轮）→ widen：扩窗找回它再精确对齐。猜位置就是「信息流跳到
 *   以前的消息」的来源。
 * - 消息确实已不在数据里（期间被压缩/删除）或扩窗已到上限 → 贴窗口顶部：窗口是
 *   尾部 N 轮，锚点不在窗口里只能意味着它比窗口最旧一行更旧，贴顶差几轮、贴底差
 *   几十轮；顶部「显示更早」仍可继续上溯。
 */
export function resolveAnchorRestore(input: {
	/** 锚点行已挂载且可见（矩形非全零）。 */
	rowMounted: boolean;
	/** 会话数据是否已落地（空数组 = 还在加载，不能当作「锚点已被清理」）。 */
	dataLoaded: boolean;
	stillInData: boolean;
	widenings: number;
}): AnchorRestoreStep {
	if (input.rowMounted) return "restore";
	// 数据还没到（会话切换后的骨架屏期）：既不能扩窗（窗口与数据无关，只会白白多挂
	// DOM）也不能贴顶（把用户钉在窗口顶部就是「跳到以前的消息」），等数据落地后重试。
	if (!input.dataLoaded) return "wait-for-data";
	if (input.widenings >= MAX_ANCHOR_RESTORE_WIDENINGS) return "fallback-window-top";
	return input.stillInData ? "widen" : "fallback-window-top";
}

/**
 * 锚点 id 是否仍在已加载数据里。
 *
 * 行级锚点 id 来自 turn 行 / 用户气泡 / 卡片：run 行的 id 就是本轮首条消息的 id
 * （groupToolMessages 的 runStableId），因此直接比消息 id 就能区分「被窗口裁掉」
 * 与「已被清理」。
 */
export function anchorRowStillInData(
	anchorMessageId: string,
	messages: readonly { id: string }[],
): boolean {
	if (!anchorMessageId) return false;
	return messages.some((message) => message.id === anchorMessageId);
}

/** 渲染窗口补偿的输入（都是本帧可直接量到的量，不带组件依赖）。 */
export type TimelineWindowShiftInput = {
	/** 有未消费的历史前插锚点：同一帧既前插数据又扩窗时只允许补偿一次。 */
	hasPendingHistoryAnchor: boolean;
	/** 本帧窗口轮数与上帧不同（「显示更早」/ 预算切换）。 */
	turnsChanged: boolean;
	/** scrollHeight 变化量，正为变高、负为变短。 */
	heightDelta: number;
	/** 贴底跟随：生长补偿交由 stick-to-bottom 引擎。 */
	following: boolean;
	/** 上帧确实在窗口化裁切中（否则无从判断顶部被裁）。 */
	hadWindowedRows: boolean;
};

export type TimelineWindowAction =
	| "defer-to-history-anchor"
	| "refresh-baseline"
	| "grow-compensation"
	| "shrink-compensation"
	| "none";

/**
 * 渲染窗口变化后应该怎么修正滚动位置（纯策略，组件只负责执行）。
 *
 * 旧实现只处理变高。变短不补偿是真实缺陷：非跟底时 Agent 又跑完一轮、或条目预算
 * 使顶部整轮被裁掉，scrollTop 原地不变就等于视口并到了另一批内容上（表现为跳动）。
 *
 * 优先级不可交换：
 * 1. 有未消费的历史前插锚点 → 本帧由 controller 补偿，窗口 effect 让位（否则双补）。
 * 2. 跟底中或上帧未裁切 → 不插手动 scrollTop。
 * 3. 变短 → 按锚点行对齐（高度差不再适用：被裁掉的量不等于插入量）。
 * 4. 变高且窗口轮数变化 → 纯「显示更早」展开，加高度差。
 */
export function resolveTimelineWindowShift(
	input: TimelineWindowShiftInput,
): TimelineWindowAction {
	if (input.hasPendingHistoryAnchor) {
		return input.turnsChanged ? "defer-to-history-anchor" : "refresh-baseline";
	}
	if (input.following || !input.hadWindowedRows) return "none";
	if (input.heightDelta < 0) return "shrink-compensation";
	if (input.heightDelta > 0 && input.turnsChanged) return "grow-compensation";
	return "none";
}

/**
 * 列表被裁短（顶部整轮被移除）后，让锚点行仍停在视口里原来的位置。
 *
 * 行顶在内容中的位置减去「行顶相对视口顶的偏移」就是新的 scrollTop。顶部内容被
 * 移除时行顶会变小，补偿后视口内容不动；结果为负说明该行已顶到视口上方，夹到 0。
 */
export function scrollTopForRetainedRow(
	rowTopInContent: number,
	rowOffsetInsideViewport: number,
): number {
	if (!Number.isFinite(rowTopInContent) || !Number.isFinite(rowOffsetInsideViewport)) return 0;
	return Math.max(0, rowTopInContent - rowOffsetInsideViewport);
}
