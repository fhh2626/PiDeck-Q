/**
 * 「assistant 声明了 toolCall、但没有对应 toolResult」的纯判定。
 *
 * 会话异常终止（进程被杀、断电、离线导入、崩溃恢复）时，JSONL 里只有 assistant
 * 的 toolCall 块，toolResult 永远不会出现。展示层必须保留这条调用记录，但绝不能
 * 声明它成功/失败/运行中——由调用方（AgentMessageProjector）用 unknown 状态落行。
 *
 * 本模块只做集合差与顺序保持，不读文件、不看展示状态，便于单测直接加载。
 */

import type { ChatMessage } from "../../shared/types";
import { normalizeToolOutcomeStatus } from "../../shared/toolOutcome";

/** Probe Sets or the active runtime's ID→name Map without copying/iterating them. */
export type ToolCallIdMembership = Pick<ReadonlySet<string>, "has">;

export type DeclaredToolCall = {
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** assistant 声明该调用的时间戳（工具卡起点兜底；不是执行耗时）。 */
	timestamp?: number;
};

/** 活动分支里所有 toolResult 的 toolCallId（跨分页/跨压缩段判定「结果存在」）。 */
export function collectToolResultIds(messages: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (Reflect.get(message, "role") !== "toolResult") continue;
		const toolCallId = Reflect.get(message, "toolCallId");
		if (typeof toolCallId === "string" && toolCallId) ids.add(toolCallId);
	}
	return ids;
}

/**
 * 按 assistant 消息下标归组「结果缺失」的调用，保持同一条 assistant 内 toolCall 的
 * 原始顺序（并行工具调用必须按声明顺序展示）。
 *
 * knownResultIds 必须包含本片之外的结果（分页其它页、压缩归档段、整条活动分支），
 * 否则老页里的调用会被误判成孤儿，凭空多出一张「未记录结果」的卡片。
 * 同一个 toolCallId 只产出一行（重复声明/重试不产生重复卡片）。
 */
export function collectMissingToolCalls(
	messages: readonly unknown[],
	knownResultIds: ReadonlySet<string>,
	branchResultIds?: ReadonlySet<string>,
): Map<number, DeclaredToolCall[]> {
	const missing = new Map<number, DeclaredToolCall[]>();
	const emitted = new Set<string>();
	messages.forEach((message, index) => {
		if (!message || typeof message !== "object") return;
		if (Reflect.get(message, "role") !== "assistant") return;
		const content = Reflect.get(message, "content");
		if (!Array.isArray(content)) return;
		const timestamp = Reflect.get(message, "timestamp");
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			if (Reflect.get(block, "type") !== "toolCall") continue;
			const id = Reflect.get(block, "id");
			if (typeof id !== "string" || !id || knownResultIds.has(id) || branchResultIds?.has(id) || emitted.has(id)) continue;
			emitted.add(id);
			const name = Reflect.get(block, "name");
			const list = missing.get(index) ?? [];
			list.push({
				toolCallId: id,
				toolName: typeof name === "string" && name ? name : "tool",
				// pi 把工具参数放在 assistant.content 的 toolCall 块里（arguments 为准，
				// input 兼容部分 provider 的写法）。
				args: Reflect.get(block, "arguments") ?? Reflect.get(block, "input"),
				...(typeof timestamp === "number" ? { timestamp } : {}),
			});
			missing.set(index, list);
		}
	});
	return missing;
}

/**
 * A file snapshot with no result is weaker evidence than an observed execution.
 * Match by Pi toolCallId, not time: long subagents update long after declaration.
 * Keep the historical position/source metadata and the observed row's identity.
 * Explicit history mutations can bypass this protection at the caller boundary.
 */
export function preserveObservedToolOutcomes(
	history: ChatMessage[], current: readonly ChatMessage[],
	activeToolCallIds?: ToolCallIdMembership,
): ChatMessage[] {
	if (!current.length || !history.some((message) => message.role === "tool" && message.meta?.status === "unknown")) return history;
	const observed = new Map<string, ChatMessage>();
	for (const message of current) {
		const id = message.meta?.toolCallId;
		const status = normalizeToolOutcomeStatus(message.meta?.status);
		if (message.role !== "tool" || typeof id !== "string" || !id || status === "unknown") continue;
		// A cached start is not proof of a surviving execution after exit/restart.
		if (status === "running" && !activeToolCallIds?.has(id)) continue;
		const previous = observed.get(id);
		if (previous && status === "running" && normalizeToolOutcomeStatus(previous.meta?.status) !== "running") continue;
		observed.set(id, message);
	}
	if (!observed.size) return history;
	let changed = false;
	const merged = history.map((message) => {
		const id = message.meta?.toolCallId;
		if (message.role !== "tool" || message.meta?.status !== "unknown" || typeof id !== "string") return message;
		const actual = observed.get(id);
		if (!actual) return message;
		changed = true;
		return { ...message, ...actual, meta: { ...message.meta, ...actual.meta } };
	});
	return changed ? merged : history;
}
