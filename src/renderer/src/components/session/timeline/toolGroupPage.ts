import type { ChatMessage, ToolOutcomeStatus } from "../../../../../shared/types";

/**
 * 大型工具组固定分页纯函数。
 * 每页固定 40 张卡片，杜绝数百张 DOM 同时挂载引发的卡顿。
 */

export const TOOL_GROUP_PAGE_SIZE = 40;

export interface ToolGroupPageResult {
	pageIndex: number;
	pageCount: number;
	startIndex: number;
	endIndex: number;
	canPrevious: boolean;
	canNext: boolean;
	effectiveAnchorId?: string;
}

/**
 * 计算当前工具组的分页区间与按钮状态。
 */
export function resolveToolGroupPage(
	total: number,
	requestedPageIndex = 0,
): ToolGroupPageResult {
	if (!Number.isFinite(total) || total <= 0) {
		return {
			pageIndex: 0,
			pageCount: 0,
			startIndex: 0,
			endIndex: 0,
			canPrevious: false,
			canNext: false,
		};
	}

	const pageCount = Math.ceil(total / TOOL_GROUP_PAGE_SIZE);
	const sanitizedRequested = Number.isFinite(requestedPageIndex)
		? Math.floor(requestedPageIndex)
		: 0;
	const pageIndex = Math.max(0, Math.min(sanitizedRequested, pageCount - 1));

	const startIndex = pageIndex * TOOL_GROUP_PAGE_SIZE;
	const endIndex = Math.min(total, startIndex + TOOL_GROUP_PAGE_SIZE);

	return {
		pageIndex,
		pageCount,
		startIndex,
		endIndex,
		canPrevious: pageIndex > 0,
		canNext: pageIndex < pageCount - 1,
	};
}

/**
 * 带有 anchor 身份恢复的工具组分页纯函数（计划步骤 6.5）。
 * 规则：
 * 1. 若 anchorMessageId 仍存在于当前消息列表中，以其当前物理 index 计算所在页码；
 * 2. 若 anchor 不存在，fallback 回 clamp(requestedPageIndex, 0, pageCount - 1)；
 * 3. 返回解析后的当前页首条消息 ID 作为 effectiveAnchorId。
 */
export function resolveToolGroupPageWithAnchor(
	messages: readonly ChatMessage[],
	requestedPageIndex = 0,
	anchorMessageId?: string,
): ToolGroupPageResult {
	const total = messages.length;
	let targetPageIndex = requestedPageIndex;

	if (anchorMessageId) {
		const foundIndex = messages.findIndex((m) => m.id === anchorMessageId);
		if (foundIndex !== -1) {
			targetPageIndex = Math.floor(foundIndex / TOOL_GROUP_PAGE_SIZE);
		}
	}

	const baseResult = resolveToolGroupPage(total, targetPageIndex);
	const effectiveAnchorId = messages[baseResult.startIndex]?.id;

	return {
		...baseResult,
		effectiveAnchorId,
	};
}

/**
 * 寻找最早处于 running 状态的工具所在的页码。
 * 若无 running 工具或 stopped 为 true，返回 null。
 */
export function findRunningToolPage(
	toolStatuses: readonly string[],
	stopped?: boolean,
): number | null {
	if (stopped) return null;
	const runningIndex = toolStatuses.findIndex((s) => s === "running");
	if (runningIndex === -1) return null;
	return Math.floor(runningIndex / TOOL_GROUP_PAGE_SIZE);
}

export type ToolGroupStatus = ToolOutcomeStatus | "stopped";

/**
 * 工具组状态聚合（纯函数，可单测）：stopped > running > error > unknown > done。
 *
 * unknown 必须排在 done 之前：组内只要有一条调用没有落盘结果，就不能把整组
 * 报成「完成」；也不能因为 unknown 而把组报成运行中（那些工具早已不在执行）。
 */
export function resolveToolGroupStatus(
	toolStatuses: readonly string[],
	stopped?: boolean,
): ToolGroupStatus {
	if (stopped && toolStatuses.includes("running")) return "stopped";
	if (toolStatuses.includes("running")) return "running";
	if (toolStatuses.includes("error")) return "error";
	if (toolStatuses.includes("unknown")) return "unknown";
	return "done";
}
