/**
 * 时间线 turn 挂载窗口：控制「画多少 TurnRow」。
 * - 贴底跟随：只挂尾部 N 轮（TIMELINE_MOUNTED_TURN_LIMIT），流式期间 DOM 最小。
 * - 上滚查看历史：挂尾部大窗口（TIMELINE_SCROLLED_TURN_LIMIT + 用户逐步展开），
 *   并在窗口前留「显示更早」按钮 —— 历史全量挂载是渲染进程内存峰值/黑屏的来源
 *   （2026-08 治理：此前上滚 = 取消跟随 = 全量放开，大会话可一次挂载近千条消息）。
 *   条目预算（maxItems）对贴底与上滚同时生效，避免贴底时单轮海量工具把 DOM 撑满。
 * 与消息分页（100 条）/ 主进程轮次缓存（50 轮）正交——只决定「渲染多少」。
 *
 * 轮次定义（2026-12 统一 50 轮）：一条用户消息开启一轮，其后直到下一条用户
 * 消息的全部内容（助手正文/思考/工具/系统卡片）都属于该轮。工具与工具组不额外
 * 占轮数，展开折叠也不改变窗口边界。
 */

/** 贴底时最多挂载的用户轮数（2026-12 3→20→50，与激活下发窗口对齐）。 */
export const TIMELINE_MOUNTED_TURN_LIMIT = 50;
/** 上滚查看历史时的基础渲染窗口轮数（2026-12 15→20→50，与贴底窗口对齐，避免上滚突然缩窗）。 */
export const TIMELINE_SCROLLED_TURN_LIMIT = 50;
/** 「显示更早」按钮每次展开的轮数步长。 */
export const TIMELINE_WINDOW_EXPAND_STEP = 10;
/** 上滚窗口的展示条目预算：单轮超大（一轮内上百条工具调用）时按轮截断仍会挂载海量 DOM，
 *  按条目数兜底截断（截断点取整轮边界，不切碎 run）。贴底同样使用调用方传入的
 *  maxItems（controller 持有该预算，贴底时为基础值）；只剩最新一轮仍超预算时整轮保留，
 *  该轮的体积由折叠正文卸载（shouldMountProcessBody）承担。 */
export const TIMELINE_SCROLLED_MAX_ITEMS = 200;

export function countAgentRunItems(items: ReadonlyArray<{ kind: string }>): number {
	let count = 0;
	for (const item of items) {
		if (item.kind === "agent-run") count += 1;
	}
	return count;
}

/** 顶层条目中的用户提问数 = 对话轮数（轮次起点约定与主进程 trim/分页一致）。 */
export function countUserTurnItems(
	items: ReadonlyArray<{ kind: string } & { items?: readonly unknown[] }>,
): number {
	let count = 0;
	for (const item of items) {
		if (isUserMessageItem(item)) count += 1;
	}
	return count;
}

/**
 * 从尾部保留最多 maxTurns 个用户轮次（对话窗口，2026-12 统一 50 轮）。
 * 与 sliceLastAgentRuns 的区别：轮次按 user 提问计数，而不是按 agent-run 计数，
 * 因此「50 个已答轮次 + 1 条未回复的新提问」仍算 51 轮，只保留其中最近 50 轮；
 * 工具/系统卡片/思考分组都不额外占轮数，也不会把一条提问与它的回答分开。
 * maxItems（可选）：展示条目总预算，超预算时以完整用户轮次为单位丢弃最旧轮次
 * （只剩最新一轮仍超预算时整轮保留，至少让用户看到最新内容）。
 * 不足上限时原样返回（引用不变，便于 memo）。
 */
export function sliceLastUserTurns<T extends { kind: string } & { items?: readonly unknown[] }>(
	items: readonly T[],
	maxTurns: number,
	maxItems?: number,
): T[] {
	if (maxTurns <= 0 || items.length === 0) return items as T[];
	// 恰好等于（或低于）轮次上限时：未超限，前置内容（压缩摘要卡等）不属于任何轮次，
	// 不得被裁掉——只有真正超过上限才需要从尾部切开。
	// 例外：条目预算（maxItems）仍是独立安全阀，超预算时继续走下面的预算裁切，
	// 不能因「未超轮数」的早退而绕过它。
	if (countUserTurnItems(items) <= maxTurns &&
		(maxItems === undefined || items.length <= maxItems)) {
		return items as T[];
	}
	let start = -1;
	let turnsSeen = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (!isUserMessageItem(items[index])) continue;
		turnsSeen += 1;
		if (turnsSeen >= maxTurns) {
			start = index;
			break;
		}
	}
	// 无任何用户提问（纯系统/助手历史）：无法按轮次裁剪，只按条目预算兜底防海量 DOM
	if (start < 0) {
		if (maxItems === undefined || items.length <= maxItems) return items as T[];
		return items.slice(items.length - maxItems);
	}
	if (maxItems === undefined) {
		return start === 0 ? (items as T[]) : items.slice(start);
	}
	// 条目预算：逐轮向后移动窗口起点，落在用户提问上（不切碎轮次、不留孤立回答）
	let budgetStart = start;
	while (items.length - budgetStart > maxItems) {
		const nextTurnStart = nextUserTurnIndex(items, budgetStart);
		if (nextTurnStart < 0) break;
		budgetStart = nextTurnStart;
	}
	return budgetStart === 0 ? (items as T[]) : items.slice(budgetStart);
}

/** 从 from 之后寻找下一条用户提问的下标；不存在返回 -1。 */
function nextUserTurnIndex(
	items: ReadonlyArray<{ kind: string } & { items?: readonly unknown[] }>,
	from: number,
): number {
	for (let index = from + 1; index < items.length; index += 1) {
		if (isUserMessageItem(items[index])) return index;
	}
	return -1;
}

/**
 * 从尾部保留最多 maxTurns 个 agent-run，并带上从首个保留 run 起的全部条目
 * （run 之间的 system/compaction 等附属消息一并保留）。
 * maxItems（可选）：展示条目总预算（每个 agent-run 固定计 1，普通条目也计 1），
 * 超预算时同样从该处截断 —— 两者都保证不切碎 run（当前 run 完整保留）。
 * 不足上限时原样返回（引用不变，便于 memo）。
 */
export function sliceLastAgentRuns<T extends { kind: string } & { items?: readonly unknown[] }>(
	items: readonly T[],
	maxTurns: number,
	maxItems?: number,
): T[] {
	if (maxTurns <= 0 || items.length === 0) return items as T[];
	let runs = 0;
	let weight = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind !== "agent-run") {
			// 非 run 条目（消息/诊断卡片）：只占 1 个条目预算，不计轮数
			weight += 1;
			if (maxItems !== undefined && weight > maxItems) {
				return cutFrom(items, index);
			}
			continue;
		}
		runs += 1;
		// 一个 agent-run 在时间线上是一个顶层条目。工具组展开只改变组内 DOM，
		// 不能改变历史窗口边界，因此内部工具调用不参与条目预算。
		weight += 1;
		if (maxItems !== undefined && weight > maxItems) {
			return cutFrom(items, index);
		}
		if (runs >= maxTurns) {
			// system 提问卡片可能夹在用户提问与回答之间；仅跨越这类非摘要卡片。
			// 压缩/分支摘要是真实轮次边界，不得跨越并错配更早的用户提问。
			let questionIndex = index - 1;
			while (questionIndex >= 0 && isNonBoundarySystemMessageItem(items[questionIndex])) {
				questionIndex -= 1;
			}
			if (questionIndex >= 0 && isUserMessageItem(items[questionIndex])) {
				// weight 已包含当前 run 到末尾的所有顶层条目；补入提问和中间卡片
				// 若超出上滚条目预算，舍弃当前 run，从下一轮起保留，避免孤立回答。
				if (maxItems !== undefined && weight + index - questionIndex > maxItems) {
					return cutFrom(items, index);
				}
				return items.slice(questionIndex);
			}
			return index === 0 ? (items as T[]) : items.slice(index);
		}
	}
	return items as T[];
}

/**
 * 顶层条目是否为「触发某 run 的用户提问」（kind=message 且 message.role=user）。
 * 泛型 T 只声明 kind，message 字段按运行时结构收窄（对应 groupToolMessages 产出的
 * MessageItem 形状）。仅在渲染窗口切片起点使用，不影响分组逻辑。
 */
function isUserMessageItem(item: { kind: string } & { items?: readonly unknown[] } | undefined): boolean {
	if (!item || item.kind !== "message") return false;
	const message = (item as { message?: { role?: unknown } }).message;
	return message?.role === "user";
}

/** 非摘要 system 卡片可出现在用户提问与回答之间；摘要必须阻断回溯。 */
function isNonBoundarySystemMessageItem(item: { kind: string } & { items?: readonly unknown[] } | undefined): boolean {
	if (!item || item.kind !== "message") return false;
	const message = (item as { message?: { role?: unknown; meta?: { type?: unknown } } }).message;
	return message?.role === "system" &&
		message.meta?.type !== "compaction" && message.meta?.type !== "branchSummary";
}

/**
 * 从 index 之后开始保留（排除使预算超限的当前条目）。
 * 尾部仅剩当前条目时退化为保留它——空窗口比超一点预算更糟（用户看不到任何内容）。
 */
function cutFrom<T>(items: readonly T[], index: number): T[] {
	const cutStart = index + 1;
	return cutStart >= items.length ? (items.slice(index) as T[]) : items.slice(cutStart);
}

/**
 * 是否对渲染列表启用 turn 窗口裁剪。
 * windowTurns 由调用方按跟随态决定（贴底 50 轮 / 上滚 50+展开轮）；
 * 与旧签名（following 参与判定）不同：非贴底同样裁剪，只是窗口更大。
 */
export function shouldWindowTimelineTurns(
	agentRunCount: number,
	windowTurns: number,
): boolean {
	return windowTurns > 0 && agentRunCount > windowTurns;
}

/** 按窗口轮数决定展示列表；未裁剪时返回原数组引用。maxItems 为条目预算（贴底与上滚共用）。 */
export function selectTimelineTurnWindow<T extends { kind: string } & { items?: readonly unknown[] }>(
	items: readonly T[],
	windowTurns: number,
	maxItems?: number,
): T[] {
	return resolveTimelineTurnWindow(items, windowTurns, maxItems).displayItems;
}

/** 同时返回实际渲染内容和「是否仍有更早内容被隐藏」。
 * 轮数超限与条目预算超限都会让 windowActive 为真，并分别提供 hiddenTurnCount 与 hiddenItemCount，
 * 供「显示更早」按钮使用（hiddenTurnCount 是隐藏的用户轮数，不是 agent-run 数）。 */
export function resolveTimelineTurnWindow<T extends { kind: string } & { items?: readonly unknown[] }>(
	items: readonly T[],
	windowTurns: number,
	maxItems?: number,
): {
	displayItems: T[];
	windowActive: boolean;
	hiddenTurnCount: number;
	hiddenItemCount: number;
} {
	const displayItems = sliceLastUserTurns(items, windowTurns, maxItems);
	const totalTurns = countUserTurnItems(items);
	const displayTurns = countUserTurnItems(displayItems);
	return {
		displayItems,
		windowActive: displayItems.length < items.length,
		hiddenTurnCount: Math.max(0, totalTurns - displayTurns),
		hiddenItemCount: Math.max(0, items.length - displayItems.length),
	};
}
