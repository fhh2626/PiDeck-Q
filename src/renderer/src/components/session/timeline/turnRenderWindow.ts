/**
 * 时间线 turn 挂载窗口：控制「画多少 TurnRow」。
 * - 贴底跟随：只挂尾部 N 轮（TIMELINE_MOUNTED_TURN_LIMIT），流式期间 DOM 最小。
 * - 上滚查看历史：挂尾部大窗口（TIMELINE_SCROLLED_TURN_LIMIT + 用户逐步展开），
 *   并在窗口前留「显示更早」按钮 —— 历史全量挂载是渲染进程内存峰值/黑屏的来源
 *   （2026-08 治理：此前上滚 = 取消跟随 = 全量放开，大会话可一次挂载近千条消息）。
 * 与消息分页（100 条）/ 主进程轮次缓存（12 轮）正交——只决定「渲染多少」。
 */

/** 贴底时最多挂载的 agent-run 轮数（2026-11 轮次模型：10 → 3，与激活下发窗口对齐）。 */
export const TIMELINE_MOUNTED_TURN_LIMIT = 3;
/** 上滚查看历史时的基础渲染窗口轮数（2026-08 黑屏治理新增）。 */
export const TIMELINE_SCROLLED_TURN_LIMIT = 15;
/** 「显示更早」按钮每次展开的轮数步长。 */
export const TIMELINE_WINDOW_EXPAND_STEP = 10;
/** 上滚窗口的展示条目预算：单轮超大（一轮内上百条工具调用）时按轮截断仍会挂载海量 DOM，
 *  按条目数兜底截断（截断点取整轮边界，不切碎 run）。贴底窗口不设此限（折叠态 DOM 可控）。 */
export const TIMELINE_SCROLLED_MAX_ITEMS = 200;

export function countAgentRunItems(items: ReadonlyArray<{ kind: string }>): number {
	let count = 0;
	for (const item of items) {
		if (item.kind === "agent-run") count += 1;
	}
	return count;
}

/**
 * 从尾部保留最多 maxTurns 个 agent-run，并带上从首个保留 run 起的全部条目
 * （run 之间的 system/compaction 等附属消息一并保留）。
 * maxItems（可选）：展示条目总预算（run 按内部 items 数计，普通条目按 1 计），
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
		// run 的 DOM 规模由其内部展示条目（思考/工具组/消息）决定，按 items.length 计重；
		// 空 items 的 run（理论边界）至少计 1，避免权重为 0 导致预算失效。
		// 预算检查先于轮数检查：超预算时当前 run 也排除（cutFrom），轮数上限才完整保留。
		weight += Array.isArray(item.items) ? Math.max(1, item.items.length) : 1;
		if (maxItems !== undefined && weight > maxItems) {
			return cutFrom(items, index);
		}
		if (runs >= maxTurns) {
			return index === 0 ? (items as T[]) : items.slice(index);
		}
	}
	return items as T[];
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
 * windowTurns 由调用方按跟随态决定（贴底 3 轮 / 上滚 15+展开轮）；
 * 与旧签名（following 参与判定）不同：非贴底同样裁剪，只是窗口更大。
 */
export function shouldWindowTimelineTurns(
	agentRunCount: number,
	windowTurns: number,
): boolean {
	return windowTurns > 0 && agentRunCount > windowTurns;
}

/** 按窗口轮数决定展示列表；未裁剪时返回原数组引用。maxItems 为上滚窗口的条目预算。 */
export function selectTimelineTurnWindow<T extends { kind: string } & { items?: readonly unknown[] }>(
	items: readonly T[],
	windowTurns: number,
	maxItems?: number,
): T[] {
	return resolveTimelineTurnWindow(items, windowTurns, maxItems).displayItems;
}

/** 同时返回实际渲染内容和「是否仍有更早内容被隐藏」。
 * 轮数超限与条目预算超限都会让 windowActive 为真，供「显示更早」按钮使用。 */
export function resolveTimelineTurnWindow<T extends { kind: string } & { items?: readonly unknown[] }>(
	items: readonly T[],
	windowTurns: number,
	maxItems?: number,
): { displayItems: T[]; windowActive: boolean } {
	const displayItems = sliceLastAgentRuns(items, windowTurns, maxItems);
	return {
		displayItems,
		windowActive: displayItems.length < items.length,
	};
}
