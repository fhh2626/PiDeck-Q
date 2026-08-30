/**
 * WebEventStream — pi RPC 事件 → AI SDK v5 UIMessageStream SSE 帧 翻译器。
 *
 * 背景：PiDeck Web 服务前端原来是 600ms 轮询 /api/state，回复期间没有任何流式反馈。
 * 本模块把主进程收到的 pi agent 事件（agent_start / message_update / tool_execution_* / agent_end）
 * 翻译成 AI SDK v5 的 UIMessageStream 线协议（data: {json}\n\n 帧 + [DONE] 终止），
 * 后端按该协议输出 SSE，前端可先用 vanilla fetch 消费实现打字机效果（A1），
 * 后续升级 React + useChat 时（A2）协议无需改动，直接复用同一端点。
 *
 * 协议参考：https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 * 需要设置响应头 x-vercel-ai-ui-message-stream: v1 才能被 useChat 识别。
 */

/** AI SDK UIMessageStream 单个 SSE 帧（data: 后的 JSON 对象）。 */
export type UiMessageStreamFrame = Record<string, unknown>;

/** 事件来源 agentId → 目标 sessionId 的路由函数，由装配方注入。 */
export type AgentToSessionRouter = (agentId: string) => string | undefined;

/** SSE 帧写出函数；返回 false 表示连接已失效（对方已断开）。 */
export type SseWriter = (frame: UiMessageStreamFrame) => boolean;

/** 单个 pi 事件（与 AgentManager.handlePiEvent 收到的结构一致）。 */
export type PiEvent = {
	type?: string;
	// message_start / message_end / message_update 顶层字段
	message?: Record<string, unknown>;
	assistantMessageEvent?: Record<string, unknown>;
	// tool_execution_*
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	isError?: boolean;
	// agent_end
	stopReason?: string;
	error?: unknown;
};

/** 事件流翻译器：维护消息级游标（text/reasoning/tool 块是否已开启），逐事件产出帧。 */
export class PiEventToUiMessageStream {
	private textBlockId: string | null = null;
	private reasoningBlockId: string | null = null;
	private hasReasoningDelta = false;
	private currentMessageId: string | null = null;
	private readonly startedToolCallIds = new Set<string>();
	private readonly finishedToolCallIds = new Set<string>();
	private lastStartedToolCallId: string | null = null;
	private finished = false;

	/**
	 * 翻译单个 pi 事件为 0..n 个 UIMessageStream 帧。
	 * 返回空数组表示该事件不需要输出（例如 user 消息、无需展示的辅助事件）。
	 */
	push(event: PiEvent): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		const type = event.type;

		// 消息开始：assistant 消息是流式回复的起点，AI SDK 用它开启一条 UI 消息。
		if (type === "message_start") {
			const role = event.message?.role;
			if (role === "assistant" && !this.finished) {
				if (!this.currentMessageId) {
					this.currentMessageId = String(
						(event.message?.id as string | undefined) ?? `msg_${Date.now()}`,
					);
					frames.push({ type: "start", messageId: this.currentMessageId });
				} else {
					// 工具循环的下一跳：同一条 UI 消息里开新 step，不要再发 start 拆气泡。
					frames.push({ type: "start-step" });
				}
			}
			return frames;
		}

		// 消息更新：文本/思考增量都在 assistantMessageEvent 里。
		if (type === "message_update" && event.assistantMessageEvent) {
			return this.handleAssistantMessageEvent(event.assistantMessageEvent);
		}

		// 工具执行（pi 在 RPC 模式下还会发顶层 tool_execution_start/end）。
		if (type === "tool_execution_start") {
			return this.startTool(event);
		}
		if (type === "tool_execution_end") {
			return this.endTool(event);
		}

		// agent_end 只是本轮 LLM 步结束：后面常接 tool_execution / 下一轮 message_start。
		// 这里关流会让手机端工具卡在 input-available，useChat 标成失败且后续正文丢失。
		// 真失败才收尾；正常结束等 agent_settled。
		if (type === "agent_end") {
			if (event.error !== undefined) return this.finishMessage(event);
			return frames;
		}

		// agent_settled 是 Pi 最终稳定点；部分版本不会把 agent_end 作为外部流的最后事件。
		if (type === "agent_settled") {
			return this.finishMessage(event);
		}

		// 其余事件（agent_start / tool_execution_start 之前的辅助事件等）不直接产生 UI 帧。
		return frames;
	}

	/** 主动结束当前流（连接断开 / 超时兜底时调用）。 */
	finish(): UiMessageStreamFrame[] {
		return this.finishMessage({});
	}

	/** 是否已发出 finish 帧。 */
	isFinished(): boolean {
		return this.finished;
	}

	private handleAssistantMessageEvent(
		ev: Record<string, unknown>,
	): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		const eventType = ev.type;

		// 文本：AI SDK 需要 start/delta/end 三件套；首次 delta 前自动补 text-start。
		if (eventType === "text_start" || eventType === "text_delta" || eventType === "text_end") {
			const delta = String(ev.delta ?? ev.text ?? "");
			if (!this.textBlockId) {
				this.textBlockId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				frames.push({ type: "text-start", id: this.textBlockId });
			}
			if (eventType === "text_delta" && delta) {
				frames.push({ type: "text-delta", id: this.textBlockId, delta });
			}
			if (eventType === "text_end" && this.textBlockId) {
				frames.push({ type: "text-end", id: this.textBlockId });
				this.textBlockId = null;
			}
			return frames;
		}

		// 思考：同样 start/delta/end；thinking_end 可能带完整 content（已含全部增量）。
		if (eventType === "thinking_delta" || eventType === "thinking_end") {
			const delta = String(ev.delta ?? ev.thinking ?? "");
			const finalContent = eventType === "thinking_end"
				? String(ev.content ?? "")
				: "";
			if (!this.reasoningBlockId) {
				this.reasoningBlockId = `reasoning_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				this.hasReasoningDelta = false;
				frames.push({ type: "reasoning-start", id: this.reasoningBlockId });
			}
			if (eventType === "thinking_delta" && delta) {
				this.hasReasoningDelta = true;
				frames.push({ type: "reasoning-delta", id: this.reasoningBlockId, delta });
			}
			if (eventType === "thinking_end") {
				// 仅在未收到任何流式增量时用完整 content 兜底；否则重复追加会让思考显示两遍。
				if (!this.hasReasoningDelta && finalContent) {
					frames.push({ type: "reasoning-delta", id: this.reasoningBlockId, delta: finalContent });
				}
				frames.push({ type: "reasoning-end", id: this.reasoningBlockId });
				this.reasoningBlockId = null;
				this.hasReasoningDelta = false;
			}
			return frames;
		}

		// 工具调用（message_update 路径：toolcall_start / toolcall_end）。
		if (eventType === "toolcall_start") {
			const toolCall = ev.toolCall as Record<string, unknown> | undefined;
			if (toolCall && typeof toolCall.id === "string" && typeof toolCall.name === "string") {
				frames.push(...this.ensureToolStarted(toolCall.id, toolCall.name, toolCall.input ?? {}));
			}
			return frames;
		}
		if (eventType === "toolcall_end") {
			const toolCall = ev.toolCall as Record<string, unknown> | undefined;
			const rawId = typeof toolCall?.id === "string" ? toolCall.id : undefined;
			const toolName = typeof toolCall?.name === "string" ? toolCall.name : "tool";
			const toolCallId = this.resolveToolCallId(rawId, toolName);
			if (!toolCallId) return frames;
			frames.push(...this.finishTool(toolCallId, toolName, toolCall?.input ?? {}, false));
			return frames;
		}

		// message_update 的 done：这一条 assistant 文本/思考结束，不是整轮 run 结束。
		// 工具调用回合随后还有 tool_execution_* 和下一轮 message_start，绝不能在这里关 SSE。
		if (eventType === "done") {
			return this.closeOpenBlocks();
		}

		return frames;
	}

	private startTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolCallId = this.resolveToolCallId(event.toolCallId, toolName);
		if (!toolCallId) return [];
		return this.ensureToolStarted(toolCallId, toolName, event.args ?? {});
	}

	private endTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolCallId = this.resolveToolCallId(event.toolCallId, toolName);
		if (!toolCallId) return [];
		return this.finishTool(toolCallId, toolName, event.args ?? {}, event.isError === true);
	}

	/** 无 ID 的 start/end 共用最近一张工具卡，避免合成 ID 对不上后把 end 丢掉。 */
	private resolveToolCallId(rawId: string | undefined, toolName: string): string | undefined {
		if (typeof rawId === "string" && rawId.trim()) return rawId;
		if (this.lastStartedToolCallId) return this.lastStartedToolCallId;
		if (!toolName) return undefined;
		return `tool_${toolName}_${Date.now()}`;
	}

	/** 同一 toolCallId 只开一次 input 帧，避免 end 早到时 useChat 抛错关流。 */
	private ensureToolStarted(
		toolCallId: string,
		toolName: string,
		input: unknown,
	): UiMessageStreamFrame[] {
		this.lastStartedToolCallId = toolCallId;
		if (this.startedToolCallIds.has(toolCallId)) return [];
		this.startedToolCallIds.add(toolCallId);
		return [
			{ type: "tool-input-start", toolCallId, toolName },
			{ type: "tool-input-available", toolCallId, toolName, input },
		];
	}

	private finishTool(
		toolCallId: string,
		toolName: string,
		input: unknown,
		isError: boolean,
	): UiMessageStreamFrame[] {
		const frames = this.ensureToolStarted(toolCallId, toolName, input);
		if (this.finishedToolCallIds.has(toolCallId)) return frames;
		this.finishedToolCallIds.add(toolCallId);
		frames.push(isError
			? { type: "tool-output-error", toolCallId, errorText: "Tool failed" }
			: { type: "tool-output-available", toolCallId, output: {} },
		);
		return frames;
	}

	/** 只关当前 text/reasoning 块，不结束整条 SSE。 */
	private closeOpenBlocks(): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		if (this.textBlockId) {
			frames.push({ type: "text-end", id: this.textBlockId });
			this.textBlockId = null;
		}
		if (this.reasoningBlockId) {
			frames.push({ type: "reasoning-end", id: this.reasoningBlockId });
			this.reasoningBlockId = null;
			this.hasReasoningDelta = false;
		}
		return frames;
	}

	private finishMessage(event: PiEvent): UiMessageStreamFrame[] {
		if (this.finished) return [];
		this.finished = true;
		const frames = this.closeOpenBlocks();
		// start/end ID 对不上时，收尾把未完成的工具卡关掉，避免一直转圈。
		for (const toolCallId of this.startedToolCallIds) {
			if (this.finishedToolCallIds.has(toolCallId)) continue;
			this.finishedToolCallIds.add(toolCallId);
			frames.push({ type: "tool-output-available", toolCallId, output: {} });
		}
		if (event.error !== undefined) {
			const errorText = typeof event.error === "string"
				? event.error
				: "Agent 运行失败";
			frames.push({ type: "error", errorText });
		}
		frames.push({ type: "finish" });
		return frames;
	}
}

/** SSE 协议固定头，useChat 依赖它识别 UIMessageStream。 */
export const UI_MESSAGE_STREAM_HEADER = "x-vercel-ai-ui-message-stream";

/** 把单条 SSE 帧序列化为 wire 格式（data: {json}\n\n）。 */
export function serializeSseFrame(frame: UiMessageStreamFrame): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}

/** [DONE] 终止标记。 */
export const SSE_DONE = "data: [DONE]\n\n";

/**
 * 每个 session 一条活跃流的连接状态。
 * 持有翻译器 + 写出函数，连接关闭后标记 dead 并停止写出。
 */
export type SessionStreamEntry = {
	sessionId: string;
	adapter: PiEventToUiMessageStream;
	/** 写出原始 wire 文本（含 data: 前缀）；返回是否成功。 */
	writeRaw: (wire: string) => boolean;
	closed: boolean;
	onFinish?: () => void;
};

/**
 * WebEventStreamRouter — 管理「sessionId → SSE 连接」并接收全量 pi 事件按 agentId 路由。
 * 用法：
 *   1. subscribe 时创建 entry，写响应头并注册到 sessionStreams
 *   2. 全局只订阅一次 pi 事件源，事件到达后按 agentId→sessionId 路由到对应 entry
 *   3. 连接断开（response close）时 remove，最后一个连接断开时取消全局订阅
 */
export class WebEventStreamRouter {
	private readonly sessionStreams = new Map<string, Set<SessionStreamEntry>>();
	private unsubscribePi: (() => void) | null = null;

	constructor(private readonly resolveSession: AgentToSessionRouter) {}

	/** 注册一个 session 的 SSE 连接。返回关闭函数。 */
	add(
		sessionId: string,
		writeRaw: (wire: string) => boolean,
		onClose: () => void,
		onFinish?: () => void,
	): () => void {
		const entry: SessionStreamEntry = {
			sessionId,
			adapter: new PiEventToUiMessageStream(),
			writeRaw,
			closed: false,
			onFinish,
		};
		let set = this.sessionStreams.get(sessionId);
		if (!set) {
			set = new Set();
			this.sessionStreams.set(sessionId, set);
		}
		set.add(entry);

		const close = () => {
			if (entry.closed) return;
			entry.closed = true;
			set?.delete(entry);
			if (set && set.size === 0) this.sessionStreams.delete(sessionId);
			onClose();
		};
		return close;
	}

	/** 供后端绑定：从 pi 事件源订阅全量事件（应只订阅一次）。 */
	bindPiSource(subscribe: ((handler: (agentId: string, event: PiEvent) => void) => () => void) | undefined): void {
		this.unsubscribePi?.();
		if (!subscribe) {
			// 装配方未提供订阅器（例如测试/受限环境）：不订阅也不抛错，路由器保持空闲。
			this.unsubscribePi = null;
			return;
		}
		this.unsubscribePi = subscribe((agentId, event) => this.onPiEvent(agentId, event));
	}

	/** 解绑 pi 事件源（服务停止时调用）。 */
	unbindPiSource(): void {
		this.unsubscribePi?.();
		this.unsubscribePi = null;
	}

	private onPiEvent(agentId: string, event: PiEvent): void {
		const sessionId = this.resolveSession(agentId);
		if (!sessionId) return;
		const set = this.sessionStreams.get(sessionId);
		if (!set || set.size === 0) return;

		for (const entry of set) {
			if (entry.closed) continue;
			const frames = entry.adapter.push(event);
			for (const frame of frames) {
				if (!entry.writeRaw(serializeSseFrame(frame))) {
					// 写出失败（对方断开）：立即标记关闭，避免持续写已失效的 socket。
					entry.closed = true;
					set.delete(entry);
					break;
				}
				// AI SDK 协议：finish 帧后必须跟 [DONE] 终止标记，前端据此关闭连接。
				if (frame.type === "finish") {
					if (!entry.writeRaw(SSE_DONE)) {
						entry.closed = true;
						set.delete(entry);
						break;
					}
					// [DONE] 是协议终止标记，但 Node response 仍需显式 end，
					// 否则 useChat 可能继续等待 HTTP body 关闭，界面会一直显示运行中。
					entry.closed = true;
					set.delete(entry);
					entry.onFinish?.();
					break;
				}
			}
		}
		if (set.size === 0) this.sessionStreams.delete(sessionId);
	}
}

/** 生成 SSE 响应头。 */
export function writeSseHeaders(
	setHeader: (name: string, value: string) => void,
	writeHead: (status: number, headers: Record<string, string>) => void,
): void {
	writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		[UI_MESSAGE_STREAM_HEADER]: "v1",
	});
	// writeHead 已带 header；setHeader 仅作类型占位兼容，实际不会重复调用。
	void setHeader;
}
