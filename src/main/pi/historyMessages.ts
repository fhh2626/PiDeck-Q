import type { ChatMessage } from "../../shared/types";
import { messageFingerprint } from "../../shared/messageFingerprint";
import { preserveObservedToolOutcomes, type ToolCallIdMembership } from "./missingToolResultCalls";

export { messageFingerprint } from "../../shared/messageFingerprint";

/** Runtime evidence and explicit history edits have different authority over missing results. */
type HistoryToolOutcomeContext = {
	activeToolCallIds?: ToolCallIdMembership;
	preserveObservedOutcomes?: boolean;
};

/**
 * 消息内容指纹：跨「运行期事件身份（randomUUID）」与「文件投影身份
 * （agentId-history-entryId）」匹配同一 pi 消息的唯一可靠手段——
 * 两条通道的 ChatMessage.id 永不相同（事件消息无 pi id 可用），
 * 但同一条 pi 消息的正文内容一致。
 *
 * 指纹组成（按角色区分）：
 * - tool：meta.toolCallId（两通道同源，pi 的 toolCallId；text 不可靠——
 *   运行期带 ▶/✓ 前缀、投影带 ✓/✗ 前缀，且随执行状态变化）；
 * - user/assistant/system/error：role + text + thinking + 图片签名
 *   （图片签名 = mimeType + data 长度 + 首尾采样，避免大 base64 全量参与比较）。
 */


/**
 * 指纹匹配只允许在投影「尾部窗口」内进行：加载期间新发的消息若已落盘，
 * 其文件副本必然位于投影末尾（最近写入）；头部/中部的同文本旧消息不可能是
 * 「双份」。否则高频同文本消息（「继续」「好」）会被误判为历史双份而丢弃
 * （2026-12 回归修复：preserved 消息真实丢失）。
 */
const FINGERPRINT_MATCH_TAIL = 32;

/**
 * 时间容差：同一条 pi 消息的投影副本（落盘记录）与运行期事件副本携带的
 * timestamp 同源（都是 pi 消息时间戳），应几乎相等；超过该值视为不同消息。
 */
const FINGERPRINT_MATCH_TIME_TOLERANCE_MS = 5_000;

/**
 * 后台加载历史消息完成后，把加载期间新增的实时消息接回历史尾部。
 * 大会话 get_messages 可能很慢；用户在等待期间发送的消息不能被历史结果覆盖。
 *
 * 去重语义（修复双份回归）：投影结果（get_messages 快照）与运行期缓存
 * （事件流/乐观写入）可能包含「同一条 pi 消息的两个副本」——快照晚于消息
 * 落盘时投影含完整版（带 entryId），运行期缓存里还有事件版（randomUUID）。
 * 旧实现只按 ChatMessage.id 去重（两通道 id 永不相同）→ 双份进入渲染层，
 * 被用户消息切分到上下两个 run（「中间回复在上一轮/下一轮都显现」）。
 *
 * 现在按「内容指纹」一一消耗匹配：preserved（加载期间新增）消息与投影消息
 * 指纹相同 → 视为同一条，丢弃运行期副本（以投影为准：位置正确、带 entryId）；
 * 指纹不匹配 → 真正未落盘的进行中消息，保留在尾部等待事件流继续 upsert。
 */
export function mergeHistoryWithPreservedMessages(
	historyMessages: ChatMessage[],
	currentMessages: ChatMessage[],
	preserveMessagesAfter?: number,
	toolOutcomes?: HistoryToolOutcomeContext,
): ChatMessage[] {
	if (!preserveMessagesAfter) return historyMessages;
	if (toolOutcomes?.preserveObservedOutcomes !== false) {
		historyMessages = preserveObservedToolOutcomes(historyMessages, currentMessages, toolOutcomes?.activeToolCallIds);
	}
	// 投影侧指纹预索引（fingerprint → 未消耗下标队列）：大会话投影几千条时避免
	// 对每条 preserved 做全表扫描（O(p×n) → O(p + n)），后台加载完成不卡主线程。
	const fingerprintToHistoryIndices = new Map<string, number[]>();
	historyMessages.forEach((historyMessage, index) => {
		const fingerprint = messageFingerprint(historyMessage);
		const indices = fingerprintToHistoryIndices.get(fingerprint);
		if (indices) indices.push(index);
		else fingerprintToHistoryIndices.set(fingerprint, [index]);
	});
	const consumedHistory = new Set<number>();
	const preservedMessages = currentMessages.filter((message) => {
		if (
			message.timestamp < preserveMessagesAfter ||
			message.meta?.historyLoading === true
		) {
			return false;
		}
		const fingerprint = messageFingerprint(message);
		const candidates = fingerprintToHistoryIndices.get(fingerprint);
		if (!candidates) return true;
		// Exact Pi tool identity does not need a time/tail heuristic: a long call's
		// declaration, live row and result can be minutes apart but remain one card.
		if (message.role === "tool" && typeof message.meta?.toolCallId === "string" && message.meta.toolCallId) return false;
		// 只允许匹配投影尾部窗口内的副本（见 FINGERPRINT_MATCH_TAIL 注释）；
		// 且时间须在容差内（同一条消息两通道 timestamp 同源）。两者都满足
		// 才消耗：既避免双份，又不误删加载期间真实新增的同文本消息。
		const tailStart = Math.max(0, historyMessages.length - FINGERPRINT_MATCH_TAIL);
		const timeTolerantCandidates = candidates.filter(
			(index) =>
				index >= tailStart &&
				Math.abs((historyMessages[index].timestamp ?? 0) - (message.timestamp ?? 0)) <=
					FINGERPRINT_MATCH_TIME_TOLERANCE_MS,
		);
		// 从最新往旧一一消耗（投影尾部即最近写入，先消耗最近的），避免错配删多。
		for (let i = timeTolerantCandidates.length - 1; i >= 0; i--) {
			const historyIndex = timeTolerantCandidates[i];
			if (!consumedHistory.has(historyIndex)) {
				consumedHistory.add(historyIndex);
				return false;
			}
		}
		return true;
	});
	return preservedMessages.length > 0
		? [...historyMessages, ...preservedMessages]
		: historyMessages;
}

/**
 * 压缩/重连重载时保护「已发出但尚未被 pi 投影」的尾部 user 消息。
 *
 * get_messages 是「发起时」的快照：用户刚发出的 prompt 可能还没进 pi 的消息
 * 列表（压缩进行中、进程刚重连、prompt 尚未被 pi 消费）。它既不是被压缩掉的
 * 历史（不该进 history/slideOut），也不在投影里；若在这里丢掉，下一次全量
 * flush 会让渲染层把它当成被压缩的旧消息滑出，底部因此少一行并被向上夹取——
 * 表现为「发送瞬间信息流回滚到上一条消息」。
 *
 * 只保护 user：assistant/tool 的尾部残缺由流式事件与 rebindInFlightMessages
 * 负责；编辑/删除/重发走 preserveHistory=false，不经过本函数。
 *
 * 边界用「从尾部倒序扫描，遇到第一条已被投影覆盖的消息就停」而非时间比较：
 * 投影时间戳可能来自文件、也可能由投影器回退成 Date.now()，时间先后不可靠；
 * 而压缩总是保留最近若干轮，所以「尾部连续未落盘的 user」就是尚未被 pi 消费
 * 的发送，更旧的未覆盖 user 属于压缩归档段，由 history/slideOut 通道处理。
 *
 * 去重必须比边界更严：投影里最后一条 user 才是「刚发出那条」的候选副本。
 * 若它与尾部副本同文、且时间戳不比副本更早（pi 排队处理会让副本时间戳
 * 更晚，例如排队等工具结束才落盘），就说明本次发送已经落盘，只是 id 没被
 * stabilizeReloadedMessageIds 稳定化；再保留一份会出现两条同文 user。
 * 反之，投影最后一条 user 更早则是上一轮的同文消息（例如连发「继续」），
 * 尾部那段仍必须保留。
 */
export function preserveUnprojectedTrailingUserMessages(
	projectedMessages: ChatMessage[],
	currentMessages: ChatMessage[],
): ChatMessage[] {
	if (currentMessages.length === 0) return projectedMessages;
	// 空投影是「历史不在」的权威（新会话/会话被清空）：不在这里复活旧 user，
	// 加载期间新增/变更的消息由 reapplyMessagesChangedDuringLoad 负责。
	if (projectedMessages.length === 0) return projectedMessages;
	// 投影侧指纹索引：同一条 pi 消息的投影副本与运行期副本正文一致、时间同源。
	const projectedFingerprints = new Map<string, number[]>();
	let lastProjectedUser: ChatMessage | undefined;
	projectedMessages.forEach((message, index) => {
		const fingerprint = messageFingerprint(message);
		const indices = projectedFingerprints.get(fingerprint);
		if (indices) indices.push(index);
		else projectedFingerprints.set(fingerprint, [index]);
		if (message.role === "user") lastProjectedUser = message;
	});
	const isProjected = (message: ChatMessage): boolean => {
		const candidates = projectedFingerprints.get(messageFingerprint(message));
		if (!candidates) return false;
		return candidates.some(
			(index) =>
				Math.abs(
					(projectedMessages[index].timestamp ?? 0) - (message.timestamp ?? 0),
				) <= FINGERPRINT_MATCH_TIME_TOLERANCE_MS,
		);
	};
	// 这条尾部 user 是否已经以另一份身份落盘（见上方注释）。
	// 比较不带容差：运行期副本的 timestamp 是 addMessage 写入时刻，一定早于 pi
	// 落盘时刻（同一台机器同一时钟），所以“投影最后一条 user 不比它早”就是同一
	// 条发送；带容差会把几秒内连发的同文 prompt 误判成已落盘。
	const lastProjectedUserFingerprint = lastProjectedUser
		? messageFingerprint(lastProjectedUser)
		: undefined;
	const lastProjectedUserTimestamp = lastProjectedUser?.timestamp ?? 0;
	const isAlreadyPersisted = (message: ChatMessage): boolean =>
		lastProjectedUserFingerprint !== undefined &&
		messageFingerprint(message) === lastProjectedUserFingerprint &&
		lastProjectedUserTimestamp >= (message.timestamp ?? 0);
	const kept: ChatMessage[] = [];
	// 必须找到一条已被投影覆盖的消息作为边界，否则无法区分「未落盘的发送」
	// 与「压缩归档段」；找不到就不猜，交给 history/slideOut 通道处理。
	let boundedByProjection = false;
	for (let index = currentMessages.length - 1; index >= 0; index -= 1) {
		const message = currentMessages[index];
		// 遇到已被投影覆盖的消息就停：压缩总是保留最近若干轮，所以更旧的
		// 未覆盖 user 属于归档段，由 history/slideOut 通道处理。
		if (isProjected(message)) {
			boundedByProjection = true;
			break;
		}
		if (message.role !== "user") continue;
		if (message.meta?.historyLoading === true) continue;
		// 已经落盘的发送不重复保留（详见上方注释）。用 continue 而不是 break：
		// 只跳过这条，继续向前找边界；它前面的新 prompt 仍确定可以保留。
		if (isAlreadyPersisted(message)) continue;
		kept.unshift(message);
	}
	if (!boundedByProjection) return projectedMessages;
	return kept.length > 0 ? [...projectedMessages, ...kept] : projectedMessages;
}

/**
 * 重载后投影消息身份稳定化。事件通道（randomUUID id）与文件投影通道
 * （agentId-history-entryId id）对同一条 pi 消息的 id 永不相同；压缩/attach
 * 重连等场景 loadMessages 会用投影整体替换运行期缓存，若直接替换，渲染层
 * React key 全部变化 → 已渲染消息全部 remount → 回答入场/settle 动画重放
 * （视觉上「回复又被加载了一遍」）。
 *
 * 本函数按内容指纹把投影消息的 id 重写为旧缓存中同一条消息的 id（时间容差内、
 * 一一消耗，规则与 mergeHistoryWithPreservedMessages 一致），保留投影的
 * entryId 等 meta；无旧匹配的新消息（如压缩摘要卡）保持投影 id。
 *
 * 幂等：旧缓存已是投影版时，指纹匹配到的是同 id，重写无副作用。
 */
export function stabilizeReloadedMessageIds(
	previousMessages: ChatMessage[],
	projectedMessages: ChatMessage[],
	toolOutcomes?: HistoryToolOutcomeContext,
): ChatMessage[] {
	if (toolOutcomes?.preserveObservedOutcomes !== false) {
		projectedMessages = preserveObservedToolOutcomes(projectedMessages, previousMessages, toolOutcomes?.activeToolCallIds);
	}
	if (previousMessages.length === 0 || projectedMessages.length === 0) {
		return projectedMessages;
	}
	// 指纹 → 旧缓存下标队列（同文本高频消息如连发「继续」会共享一个指纹）
	const fingerprintToPrevIndices = new Map<string, number[]>();
	previousMessages.forEach((message, index) => {
		const fingerprint = messageFingerprint(message);
		const indices = fingerprintToPrevIndices.get(fingerprint);
		if (indices) indices.push(index);
		else fingerprintToPrevIndices.set(fingerprint, [index]);
	});
	const consumed = new Set<number>();
	return projectedMessages.map((message) => {
		const fingerprint = messageFingerprint(message);
		const candidates = fingerprintToPrevIndices.get(fingerprint);
		if (!candidates) return message;
		// 从最旧往最新一一消耗，保持投影与旧缓存的顺序对应（同文本消息
		// 如连发「继续」按出现顺序各匹配各的，避免交错串位）
		for (let i = 0; i < candidates.length; i++) {
			const prevIndex = candidates[i];
			if (consumed.has(prevIndex)) continue;
			const prev = previousMessages[prevIndex];
			const exactToolIdentity = message.role === "tool" && typeof message.meta?.toolCallId === "string" && Boolean(message.meta.toolCallId);
			if (
				!exactToolIdentity &&
				Math.abs((prev.timestamp ?? 0) - (message.timestamp ?? 0)) >
				FINGERPRINT_MATCH_TIME_TOLERANCE_MS
			) {
				continue;
			}
			consumed.add(prevIndex);
			return carryOptimisticUserMetadata(prev, { ...message, id: prev.id });
		}
		return message;
	});
}

/**
 * 投影消息替换 host 乐观 user 行时保留 renderer 的发送身份与投递语义。
 * 这样 renderer 侧即使尚未收到原乐观消息，也能按 requestId 精确配对，
 * 虚拟列表也能沿用旧行实测高度，不会因投影 id 改变而滑出/跳变；
 * streamingBehavior 则让重载后的 steer/followUp 标签不丢失。
 */
function carryOptimisticUserMetadata(previous: ChatMessage, projected: ChatMessage): ChatMessage {
	const requestId = previous.meta?.optimisticRequestId;
	const streamingBehavior = previous.meta?.streamingBehavior;
	const hasRequestId = typeof requestId === "string" && requestId.length > 0;
	const hasDeliveryLabel =
		streamingBehavior === "steer" || streamingBehavior === "followUp";
	if (!hasRequestId && !hasDeliveryLabel) return projected;

	const meta = { ...(projected.meta ?? {}) };
	// 投影若已携带另一个发送身份，以投影为准；正常文件投影不会带该字段。
	let requestIdCarried = false;
	if (hasRequestId) {
		const projectedRequestId = meta.optimisticRequestId;
		const projectedHasDifferentRequest =
			typeof projectedRequestId === "string" &&
			projectedRequestId.length > 0 &&
			projectedRequestId !== requestId;
		if (!projectedHasDifferentRequest) {
			meta.optimisticRequestId = requestId;
			requestIdCarried = true;
		}
	}
	// 投递标签只在同一条发送身份被接续时保留，避免同文本指纹误配把 steer
	// 标签复制到另一条用户消息上。
	if (
		hasDeliveryLabel &&
		requestIdCarried &&
		meta.streamingBehavior !== "steer" &&
		meta.streamingBehavior !== "followUp"
	) {
		meta.streamingBehavior = streamingBehavior;
	}
	return { ...projected, meta };
}
