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

import { readWebAssistantToolCalls, snapshotWebToolInput, type WebStreamToolInput } from "./webStreamTools";
import { toolResultMissingMetadata } from "../../shared/toolOutcome";
import type { SessionRuntimeInfo, SessionRuntimeTarget } from "../../shared/types";
import { reconcileWebStreamRuntime, type WebStreamAdmission } from "./webStreamRuntime";

/** AI SDK UIMessageStream 单个 SSE 帧（data: 后的 JSON 对象）。 */
export type UiMessageStreamFrame = Record<string, unknown>;

/** 事件来源 agentId → 目标 sessionId 的路由函数，由装配方注入。 */
export type AgentToSessionRouter = (agentId: string) => string | undefined;

/** 主进程 pi 事件订阅器；streamGeneration 区分同一 runtime 上连续的 run。 */
export type PiEventSubscriber = (
	handler: (agentId: string, event: PiEvent, streamGeneration?: number) => void,
) => () => void;

/** SSE 帧写出函数；返回 false 表示连接已失效（对方已断开）。 */
export type SseWriter = (frame: UiMessageStreamFrame) => boolean;

const RUN_OPENING_EVENT_TYPES = new Set([
	"agent_start",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_update",
	"tool_execution_start",
	"tool_execution_end",
]);

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

/**
 * 已宣告工具的运行态：`args` 是给重连回放用的有界快照，`liveInput` 是本次运行
 * 真实的结构化输入。两者必须分开保存——回放要防内存膨胀，实时帧不能截断。
 */
type ActiveWebTool = WebStreamToolInput & { liveInput: unknown };

/** 事件流翻译器：维护消息级游标（text/reasoning/tool 块是否已开启），逐事件产出帧。 */
export class PiEventToUiMessageStream {
	private textBlockId: string | null = null;
	private hasTextDelta = false;
	private reasoningBlockId: string | null = null;
	private hasReasoningDelta = false;
	private currentMessageId: string | null = null;
	private readonly startedToolCallIds = new Set<string>();
	private readonly finishedToolCallIds = new Set<string>();
	private readonly activeToolCalls = new Map<string, ActiveWebTool>();
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
				} else if (this.activeToolCalls.size === 0) {
					// 工具循环的下一跳：同一条 UI 消息里开新 step，不要再发 start 拆气泡。
					// 但仍有工具在跑时不能开新 step：ai@7 的 updateDynamicToolPart 只在
					// 「当前 step」里按 toolCallId 找 part，找不到就 push 一条新的。
					// 跨越 step 的 tool-input-available 会变成「运行中 + 结果未记录」两条重复卡，
					// 而收尾的 unknown 标记也永远落不到旧 step 的那条 part 上。
					// 因此 step 边界推迟到本轮工具都收尾之后（真实 pi 顺序本来如此）。
					frames.push({ type: "start-step" });
				}
			}
			return frames;
		}

		// 消息更新：文本/思考增量都在 assistantMessageEvent 里。
		if (type === "message_update" && event.assistantMessageEvent) {
			return this.handleAssistantMessageEvent(event.assistantMessageEvent);
		}

		// A snapshot may be the first observed evidence of a tool on a cold stream.
		if (type === "message_end" && event.message?.role === "assistant") {
			return readWebAssistantToolCalls(event.message.content).flatMap((call) => this.startTool(call));
		}

		// Progress can arrive after Web was enabled mid-execution, without a start.
		if (type === "tool_execution_update") return this.startTool(event);

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

	/** Replay only active tool inputs to one new subscriber, never old text or results. */
	replayActiveTools(snapshot: readonly WebStreamToolInput[] = []): UiMessageStreamFrame[] {
		for (const call of snapshot) {
			// The live translator wins over possibly older polling snapshots.
			if (!this.startedToolCallIds.has(call.toolCallId)) this.startTool(call);
		}
		if (!this.currentMessageId && this.activeToolCalls.size) {
			// A cold translator seeded mid-tool must treat the next assistant as a
			// new step, not restart the UI message containing the recovered tools.
			this.currentMessageId = `tool_${this.activeToolCalls.keys().next().value}`;
		}
		return [...this.activeToolCalls.values()].flatMap((call) => [
			{ type: "tool-input-start", toolCallId: call.toolCallId, toolName: call.toolName, dynamic: true },
			{ type: "tool-input-available", toolCallId: call.toolCallId, toolName: call.toolName, dynamic: true, input: call.args, toolMetadata: {} },
		]);
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
			const finalContent = eventType === "text_end" ? String(ev.content ?? "") : "";
			if (!this.textBlockId) {
				this.textBlockId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
				this.hasTextDelta = false;
				frames.push({ type: "text-start", id: this.textBlockId });
			}
			if (eventType === "text_delta" && delta) {
				this.hasTextDelta = true;
				frames.push({ type: "text-delta", id: this.textBlockId, delta });
			}
			if (eventType === "text_end" && this.textBlockId) {
				// text_end.content 是权威全文；只有本块完全没发 delta 时才回填，
				// 避免普通流式块把已追加的 delta 再重复一遍。
				if (!this.hasTextDelta && finalContent) {
					frames.push({ type: "text-delta", id: this.textBlockId, delta: finalContent });
				}
				frames.push({ type: "text-end", id: this.textBlockId });
				this.textBlockId = null;
				this.hasTextDelta = false;
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

		// toolcall_end completes argument generation, NOT execution. Subagent can
		// run for minutes afterwards; only tool_execution_end may settle its card.
		if (eventType === "toolcall_start" || eventType === "toolcall_end") {
			const toolCall = ev.toolCall;
			if (!toolCall || typeof toolCall !== "object") return frames;
			return readWebAssistantToolCalls([{ ...toolCall, type: "toolCall" }])
				.flatMap((call) => this.startTool(call));
		}

		// message_update 的 done：这一条 assistant 文本/思考结束，不是整轮 run 结束。
		// 工具调用回合随后还有 tool_execution_* 和下一轮 message_start，绝不能在这里关 SSE。
		if (eventType === "done") {
			const message = ev.message;
			const calls = message && typeof message === "object"
				? readWebAssistantToolCalls(Reflect.get(message, "content")) : [];
			return [...this.closeOpenBlocks(), ...calls.flatMap((call) => this.startTool(call))];
		}

		return frames;
	}

	private startTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolCallId = this.resolveToolCallId(event.toolCallId, toolName);
		if (!toolCallId) return [];
		return this.ensureToolStarted(toolCallId, toolName, event.args ?? this.retainedToolInput(toolCallId));
	}

	private endTool(event: PiEvent): UiMessageStreamFrame[] {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const toolCallId = this.resolveToolCallId(event.toolCallId, toolName);
		if (!toolCallId) return [];
		return this.finishTool(toolCallId, toolName, event.args ?? this.retainedToolInput(toolCallId), event.isError === true);
	}

	/** 事件没带 args 时沿用上一次真实输入（优先结构化实时值，而不是有界回放快照）。 */
	private retainedToolInput(toolCallId: string): unknown {
		const active = this.activeToolCalls.get(toolCallId);
		return active ? active.liveInput : {};
	}

	/** 无 ID 的 start/end 共用最近一张工具卡，避免合成 ID 对不上后把 end 丢掉。 */
	private resolveToolCallId(rawId: string | undefined, toolName: string): string | undefined {
		if (typeof rawId === "string" && rawId.trim()) return rawId;
		if (this.lastStartedToolCallId) return this.lastStartedToolCallId;
		if (!toolName) return undefined;
		return `tool_${toolName}_${Date.now()}`;
	}

	/**
	 * 同一 toolCallId 只开一次 input 帧，避免 end 早到时 useChat 抛错关流。
	 * 实时帧必须携带真实结构化输入（大参数不能被截断成非法 JSON 字符串）；
	 * 只有回放用的保留快照才做有界截断（见 replayActiveTools）。
	 */
	private ensureToolStarted(
		toolCallId: string,
		toolName: string,
		input: unknown,
	): UiMessageStreamFrame[] {
		this.lastStartedToolCallId = toolCallId;
		if (this.finishedToolCallIds.has(toolCallId)) return [];
		const previous = this.activeToolCalls.get(toolCallId);
		if (previous) {
			// 已在当前 step 宣告过：只能原地更新，绝不能再发 tool-input-start。
			// （step 边界在本轮工具收尾前是推迟的，所以活跃工具一定在当前 step 里。）
			if (previous.liveInput === input) return [];
			const args = snapshotWebToolInput(input);
			if (JSON.stringify(previous.args) === JSON.stringify(args)
				&& JSON.stringify(previous.liveInput) === JSON.stringify(input)) return [];
			this.activeToolCalls.set(toolCallId, { toolCallId, toolName, args, liveInput: input });
			return [{ type: "tool-input-available", toolCallId, toolName, dynamic: true, input, toolMetadata: {} }];
		}
		this.activeToolCalls.set(toolCallId, {
			toolCallId, toolName, args: snapshotWebToolInput(input), liveInput: input,
		});
		// toolMetadata: {} 显式清掉可能残留的「结果未记录」标记：
		// AI SDK 的 updateToolPart 只在 toolMetadata !== undefined 时覆盖，
		// 不主动清就会让历史投影的 unknown 粘到真正开始执行的 part 上。
		const available = {
			type: "tool-input-available", toolCallId, toolName, dynamic: true, input, toolMetadata: {},
		};
		this.startedToolCallIds.add(toolCallId);
		return [{ type: "tool-input-start", toolCallId, toolName, dynamic: true }, available];
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
		this.activeToolCalls.delete(toolCallId);
		// SDK versions may retain invocation metadata on output frames. Consumers
		// must treat the real output state as stronger evidence than a stale marker.
		frames.push(isError
			? { type: "tool-output-error", toolCallId, errorText: "Tool failed", toolMetadata: {} }
			: { type: "tool-output-available", toolCallId, output: {}, toolMetadata: {} },
		);
		return frames;
	}

	/** 只关当前 text/reasoning 块，不结束整条 SSE。 */
	private closeOpenBlocks(): UiMessageStreamFrame[] {
		const frames: UiMessageStreamFrame[] = [];
		if (this.textBlockId) {
			frames.push({ type: "text-end", id: this.textBlockId });
			this.textBlockId = null;
			this.hasTextDelta = false;
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
		// 但绝不能编造 tool-output-available：结果没到就说明我们不知道结果，
		// 只能回到 input-available 并打上「结果未记录」标记（与桌面投影同一个契约）。
		for (const toolCallId of this.startedToolCallIds) {
			if (this.finishedToolCallIds.has(toolCallId)) continue;
			this.finishedToolCallIds.add(toolCallId);
			const call = this.activeToolCalls.get(toolCallId);
			frames.push({
				type: "tool-input-available",
				toolCallId,
				toolName: call?.toolName ?? "tool",
				dynamic: true,
				// 用实时输入回填，避免把已经展示的大参数降级成有界截断串。
				input: call ? call.liveInput : {},
				toolMetadata: toolResultMissingMetadata(),
			});
		}
		this.activeToolCalls.clear();
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

/** 单条 SSE socket；翻译状态不属于 socket，断线只移除这个 subscriber。 */
export type SessionStreamEntry = {
	writeRaw: (wire: string) => boolean;
	closed: boolean;
	/** 每条 socket 的 AI SDK parser 都有独立 active-part 表。 */
	openTextIds: Set<string>;
	openReasoningIds: Set<string>;
	onClose: () => void;
	onFinish?: () => void;
};

/** 一轮 session stream 的持续状态，可在没有 socket 时继续消费 pi 事件。 */
type SessionRunStream = {
	adapter: PiEventToUiMessageStream;
	streamGeneration?: number;
	runtimeTarget?: SessionRuntimeTarget;
	/** run 级准入模式：缺省（仅由 pi 事件先建 run）按 dispatch 处理，不凭“当前没有活动 runtime”收尾；
	 * 一旦有 dispatch 订阅者（POST）则永久粘住，避免 prompt 发出前被提前 finish。 */
	admission?: WebStreamAdmission;
	subscribers: Set<SessionStreamEntry>;
};

/**
 * WebEventStreamRouter — translator 属于 session/run，socket 只是可随时 attach/detach 的 subscriber。
 * 因此网络重连不会丢失 reasoning、message step 与 tool call 游标。
 */
export class WebEventStreamRouter {
	private readonly sessionRuns = new Map<string, SessionRunStream>();
	private unsubscribePi: (() => void) | null = null;

	constructor(private readonly resolveSession: AgentToSessionRouter) {}

	/** 注册一个 session 的 SSE socket；返回只 detach 当前 subscriber 的关闭函数。 */
	add(
		sessionId: string,
		writeRaw: (wire: string) => boolean,
		onClose: () => void,
		onFinish?: () => void,
		tools: readonly WebStreamToolInput[] = [],
		admission: WebStreamAdmission = "dispatch",
	): () => void {
		const run = this.getOrCreateRun(sessionId);
		// POST may join a GET that pinned a starting runtime. Its starting→idle
		// preparation is not completion of the new prompt: discard that old fence.
		// handleStream synchronously re-pins if execution is actually running.
		if (admission === "dispatch") run.runtimeTarget = undefined;
		// A later GET must not revoke an earlier POST's pre-dispatch patience.
		run.admission = admission === "dispatch" || run.admission === "dispatch" ? "dispatch" : "observe";
		const entry: SessionStreamEntry = {
			writeRaw,
			closed: false,
			openTextIds: new Set(),
			openReasoningIds: new Set(),
			onClose,
			onFinish,
		};
		run.subscribers.add(entry);
		// Reconnect during a quiet/long tool must not wait for the next event.
		// Target only this socket; existing readers must not receive duplicate starts.
		for (const frame of run.adapter.replayActiveTools(tools)) {
			if (!this.writeFrame(entry, frame)) { this.closeEntry(run, entry); break; }
		}
		return () => this.closeEntry(run, entry);
	}

	/** Runtime lifecycle is independent of Pi's settled events (e.g. a killed process). */
	observeRuntimeStates(runtimes: readonly SessionRuntimeInfo[]): void {
		const bySession = new Map(runtimes.map((runtime) => [runtime.sessionId, runtime]));
		for (const [sessionId, run] of this.sessionRuns) {
			const next = reconcileWebStreamRuntime(run.runtimeTarget, bySession.get(sessionId), run.admission ?? "dispatch");
			run.runtimeTarget = next.target;
			if (next.finish) this.finishSession(sessionId);
		}
	}

	/** runtime 已非 running 时同步结束该 session，覆盖 settled 发生在重订阅之前的竞态。 */
	finishSession(sessionId: string, error?: unknown): void {
		const run = this.sessionRuns.get(sessionId);
		if (!run) return;
		const frames = error === undefined
			? run.adapter.finish()
			: run.adapter.push({ type: "agent_end", error });
		this.broadcast(run, frames);
		this.sessionRuns.delete(sessionId);
	}

	/** 供后端绑定：从 pi 事件源订阅全量事件（应只订阅一次）。 */
	bindPiSource(subscribe: PiEventSubscriber | undefined): void {
		this.unsubscribePi?.();
		if (!subscribe) {
			this.unsubscribePi = null;
			return;
		}
		this.unsubscribePi = subscribe(
			(agentId, event, streamGeneration) => this.onPiEvent(agentId, event, streamGeneration),
		);
	}

	/** 解绑 pi 事件源（服务停止时调用）。 */
	unbindPiSource(): void {
		this.unsubscribePi?.();
		this.unsubscribePi = null;
		this.sessionRuns.clear();
	}

	private getOrCreateRun(sessionId: string): SessionRunStream {
		let run = this.sessionRuns.get(sessionId);
		if (!run) {
			run = { adapter: new PiEventToUiMessageStream(), subscribers: new Set() };
			this.sessionRuns.set(sessionId, run);
		}
		return run;
	}

	private onPiEvent(agentId: string, event: PiEvent, streamGeneration?: number): void {
		const sessionId = this.resolveSession(agentId);
		if (!sessionId) return;
		let run = this.sessionRuns.get(sessionId);
		if (!run) {
			// 非 run 事件不应仅因 Web 服务全局监听而创建长期状态。
			if (!event.type || !RUN_OPENING_EVENT_TYPES.has(event.type)) return;
			run = this.getOrCreateRun(sessionId);
		}

		// agent_start 的 generation 是 run 身份。新一轮替换 translator，但保留已经先建立的 socket；
		// 旧 generation 的迟到 settled/delta 不得结束或污染新一轮。
		if (streamGeneration !== undefined) {
			if (run.streamGeneration === undefined) {
				run.streamGeneration = streamGeneration;
			} else if (run.streamGeneration !== streamGeneration) {
				if (event.type !== "agent_start") return;
				run = {
					adapter: new PiEventToUiMessageStream(),
					streamGeneration,
					admission: run.admission,
					subscribers: run.subscribers,
				};
				this.sessionRuns.set(sessionId, run);
			}
		}

		const frames = run.adapter.push(event);
		this.broadcast(run, frames);
		if (run.adapter.isFinished()) this.sessionRuns.delete(sessionId);
	}

	private broadcast(run: SessionRunStream, frames: UiMessageStreamFrame[]): void {
		for (const frame of frames) {
			for (const entry of [...run.subscribers]) {
				if (entry.closed) continue;
				if (!this.writeFrame(entry, frame)) {
					this.closeEntry(run, entry);
					continue;
				}
				if (frame.type !== "finish") continue;
				if (!entry.writeRaw(SSE_DONE)) {
					this.closeEntry(run, entry);
					continue;
				}
				entry.closed = true;
				run.subscribers.delete(entry);
				entry.onFinish?.();
			}
		}
	}

	/**
	 * 将 run 级帧投影到单条 socket 的 parser 状态。
	 * 重连后首帧若是 delta，先补 start；若只是 end，则 snapshot 已含完整 block，直接忽略，
	 * 避免 AI SDK 因孤立 end 报错，也避免 start+end 生成一个空的重复 part。
	 */
	private writeFrame(entry: SessionStreamEntry, frame: UiMessageStreamFrame): boolean {
		const type = frame.type;
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (type === "text-start" && id) entry.openTextIds.add(id);
		if (type === "reasoning-start" && id) entry.openReasoningIds.add(id);
		if (type === "text-delta" && id && !entry.openTextIds.has(id)) {
			if (!entry.writeRaw(serializeSseFrame({ type: "text-start", id }))) return false;
			entry.openTextIds.add(id);
		}
		if (type === "reasoning-delta" && id && !entry.openReasoningIds.has(id)) {
			if (!entry.writeRaw(serializeSseFrame({ type: "reasoning-start", id }))) return false;
			entry.openReasoningIds.add(id);
		}
		if (type === "text-end" && id && !entry.openTextIds.has(id)) return true;
		if (type === "reasoning-end" && id && !entry.openReasoningIds.has(id)) return true;
		if (!entry.writeRaw(serializeSseFrame(frame))) return false;
		if (type === "text-end" && id) entry.openTextIds.delete(id);
		if (type === "reasoning-end" && id) entry.openReasoningIds.delete(id);
		return true;
	}

	private closeEntry(run: SessionRunStream, entry: SessionStreamEntry): void {
		if (entry.closed) return;
		entry.closed = true;
		run.subscribers.delete(entry);
		entry.onClose();
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
