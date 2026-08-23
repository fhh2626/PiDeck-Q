/**
 * Live 正文挂载判定（纯函数，可单测）。
 *
 * 语义：Live 正文按 assistantMessageId 精确绑定当前 assistant 消息/骨架。
 *
 * 判定：
 * - 无会话 / 无挂载点 / 无活动流 → 不挂；
 * - 挂载点 id 与当前流式 messageId 不一致（或 streamingMessageId 尚未就绪）→ 不挂（严禁挂到旧 run）；
 * - 空文本骨架（正文走独立通道，message 文本尚未落定）→ 挂载；
 * - 流式中 / agentRunning（正文已部分落定但仍在活动）→ 保持挂载；
 * - 其余（已 settled）→ 不挂，落回容器内渲染。
 */
export function resolveLiveInterimId(input: {
	/** 所属会话 id（无会话不挂） */
	sessionId?: string;
	/** 本轮最后一条 interim 的 id（Live 挂载锚点） */
	lastInterimId?: string;
	/** 会话是否存在活动正文流（liveTextStreamingBySessionAtom 的派生位） */
	liveTextActive: boolean;
	/** 当前流式正文绑定的 assistant messageId */
	streamingMessageId?: string;
	/** 本轮最后一条 interim 的正文（空 = 骨架挂载点） */
	lastMessageText: string;
	agentRunning?: boolean;
	isStreaming?: boolean;
}): string | undefined {
	if (!input.sessionId || !input.lastInterimId) return undefined;
	if (!input.liveTextActive) return undefined;
	if (!input.streamingMessageId || input.lastInterimId !== input.streamingMessageId) {
		return undefined;
	}
	const emptySkeleton = !input.lastMessageText.trim();
	if (emptySkeleton || input.agentRunning || input.isStreaming) return input.lastInterimId;
	return undefined;
}
