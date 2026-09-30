import type { ChatMessage } from "../../../shared/types";

/**
 * 乐观删除的纯规则（2026-09「删一条要等下一次删除才消失」修复）。
 *
 * 背景：删除在主进程要走「定位 → 改写 JSONL → switch_session → 重读 get_messages」，
 * 大会话实测约 3 秒，期间时间线毫无变化；用户以为没删掉、接着删下一条时上一条才消失。
 * 渲染层在确认删除后立即隐藏「将被删除的那一段」，成功后由后端快照接管，失败再恢复。
 *
 * 隐藏范围必须与主进程 SessionFileEditor.turnSegmentMessageIds 同口径，否则会出现
 * 「先藏多了、快照到达后又冒出来」或「藏少了、剩半轮」的闪动：
 * - 目标是 user 消息：从该 user 起，到下一条 user 之前（整轮）；
 * - 目标是其它消息：从本轮 user 之后，到下一条 user 之前（本轮全部回复，保留 user）；
 * - system 行（压缩/分支摘要卡）不是对话条目，主进程不会删，这里也不藏。
 */
export function resolveOptimisticDeletionIds(
	messages: readonly ChatMessage[],
	targetId: string,
): string[] {
	// 已在滑出动画中的旧消息不属于当前对话，跳过以免把它们当作轮次边界
	const conversation = messages.filter((message) => message.meta?.slidingOut !== true);
	const targetIndex = conversation.findIndex((message) => message.id === targetId);
	if (targetIndex < 0) return [];

	let start = targetIndex;
	if (conversation[targetIndex].role !== "user") {
		start = 0;
		for (let index = targetIndex - 1; index >= 0; index -= 1) {
			if (conversation[index].role === "user") {
				start = index + 1;
				break;
			}
		}
	}

	let end = conversation.length;
	for (let index = start + 1; index < conversation.length; index += 1) {
		if (conversation[index].role === "user") {
			end = index;
			break;
		}
	}

	return conversation
		.slice(start, end)
		.filter((message) => message.role !== "system")
		.map((message) => message.id);
}

/** 过滤掉被乐观隐藏的消息；无需隐藏时返回原数组引用，避免下游 memo 失效。 */
export function filterOptimisticallyDeletedMessages(
	messages: ChatMessage[],
	hiddenIds: ReadonlySet<string> | undefined,
): ChatMessage[] {
	if (!hiddenIds || hiddenIds.size === 0) return messages;
	if (!messages.some((message) => hiddenIds.has(message.id))) return messages;
	return messages.filter((message) => !hiddenIds.has(message.id));
}

/**
 * 删除成功后，隐藏记录何时可以撤掉：被隐藏的 id 已不在权威数据里
 * （或只剩滑出动画中的旧副本）。事件流与命令响应走不同通道、到达顺序不定，
 * 因此不能在命令返回时立刻撤销隐藏，否则快照晚到会让已删消息闪回一下。
 */
export function isOptimisticDeletionSettled(
	messages: readonly ChatMessage[],
	hiddenIds: readonly string[],
): boolean {
	const pending = new Set(hiddenIds);
	return !messages.some((message) => pending.has(message.id) && message.meta?.slidingOut !== true);
}
