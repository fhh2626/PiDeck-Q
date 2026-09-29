/**
 * Web 时间线「最近 N 轮对话」显示窗口（2026-12 统一 50 轮）。
 *
 * 一轮 = 一条用户消息开启，直到下一条用户消息之前都属于该轮：助手正文、
 * 思考、工具调用、系统/摘要卡片都在轮内。工具调用与工具组不额外占轮数，
 * 展开/折叠也不改变窗口边界；当前尚未得到回复的用户提问同样算一轮。
 *
 * 本模块只做展示切片：
 * - 不删除、不去重、不修改底层消息（缓存与 useChat 仍是权威数据）。
 * - 必须在工具分组之前调用（分组后是卡片数，不是对话轮数）。
 * - 角色识别复用 webMessageMetadata 的 uiMessageRole（历史转换会把
 *   tool/system 映射成 UI role=assistant，只看 role 会数错）。
 */
import type { UIMessage } from "ai";
import { uiMessageRole } from "./webMessageMetadata";

/** 贴底/上滚的基础显示窗口轮数（与桌面端 TIMELINE_MOUNTED_TURN_LIMIT 对齐）。 */
export const WEB_TIMELINE_TURN_LIMIT = 50;
/** 展示已加载更早内容时每次展开的轮数（不发起网络请求）。 */
export const WEB_TIMELINE_TURN_EXPAND_STEP = 10;

/** 是否为开启一轮的用户提问。 */
function isUserTurnMessage(message: UIMessage): boolean {
	try {
		return uiMessageRole(message) === "user";
	} catch {
		// 元数据损坏不应让整条时间线崩溃：保守视为非轮次起点（不切断已有窗口）
		return false;
	}
}

/** 统计 UIMessage 序列中的用户轮数。 */
export function countWebTurns(messages: readonly UIMessage[]): number {
	let turns = 0;
	for (const message of messages) {
		if (isUserTurnMessage(message)) turns += 1;
	}
	return turns;
}

/**
 * 从尾部保留最多 turnLimit 个用户轮次。
 * - 不足上限：原样返回（引用不变，便于 memo）；首个用户之前的前置内容
 *   （开场系统卡片等）不属于任何轮次，不得在未隐藏轮次时被切掉。
 * - 超过上限：从倒数第 turnLimit 条用户提问处切开，轮内内容整体保留。
 * - 没有任何用户起点（纯系统/助手历史）：原样返回，不按条目数量擅自截断；
 *   这类数据的体量由历史分页与传输预算负责。
 */
export function selectWebTurnWindow(
	messages: readonly UIMessage[],
	turnLimit: number,
): {
	visibleMessages: UIMessage[];
	hiddenTurnCount: number;
	hasHiddenMessages: boolean;
} {
	const totalTurns = countWebTurns(messages);
	if (turnLimit <= 0 || messages.length === 0 || totalTurns <= turnLimit) {
		return {
			visibleMessages: messages as UIMessage[],
			hiddenTurnCount: 0,
			hasHiddenMessages: false,
		};
	}
	let start = -1;
	let turnsSeen = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (!isUserTurnMessage(messages[index])) continue;
		turnsSeen += 1;
		if (turnsSeen >= turnLimit) {
			start = index;
			break;
		}
	}
	if (start <= 0) {
		return {
			visibleMessages: messages as UIMessage[],
			hiddenTurnCount: 0,
			hasHiddenMessages: false,
		};
	}
	const visibleMessages = (messages as UIMessage[]).slice(start);
	return {
		visibleMessages,
		hiddenTurnCount: totalTurns - countWebTurns(visibleMessages),
		hasHiddenMessages: true,
	};
}
