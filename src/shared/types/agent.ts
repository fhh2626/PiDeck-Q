import type { SessionEnvironment, SessionSource } from "./session";

export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed";

export type AgentTab = {
	id: string;
	projectId: string;
	cwd: string;
	title: string;
	status: AgentStatus;
	sessionId?: string;
	/** PiDeck 会话身份（与 CreateAgentInput.deckSessionId 同源），用于安全门 PIDECK_SESSION_ID 注入。 */
	deckSessionId?: string;
	sessionPath?: string;
	/** Identity used only for session/runtime matching; agentId remains the process handle. */
	sessionEnvironment?: SessionEnvironment;
	sessionSource?: SessionSource;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	noSession?: boolean;
	/** Monotonic binding generation assigned by SessionRuntimeCoordinator. */
	runtimeGeneration?: number;
	createdAt: number;
	/** 会话累计压缩次数，由主进程解析会话文件得到，用于前端展示“已压缩 N 次”。 */
	compactionCount?: number;
};

export type AgentRuntimeState = {
	modelName?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	/** 是否正在执行工具调用（read/write/bash 等） */
	isExecutingTool?: boolean;
	/** 当前正在执行的工具名称，如 read、write、bash */
	executingToolName?: string;
	/** 工具状态事件的单调序号，用于忽略晚到的异步完整状态。 */
	toolStateSequence?: number;
	contextTokens?: number | null;
	contextWindow?: number | null;
	contextPercent?: number | null;
	/** 对话消息估算 token：主进程按会话文件消息文本字符数 ÷ 4 粗估，
	 *  用于 UI 展示「对话 vs 系统+工具」两段占比（pi 不返回 prompt 构成）。 */
	contextMessageTokens?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheTotal?: number;
	cacheHitPercent?: number | null;
	/** 当前会话平均缓存命中率：会话文件全部 assistant 消息 usage 的算术平均 */
	cacheHitAveragePercent?: number | null;
	/** 参与平均统计的 assistant 消息条数（与 cacheHitAveragePercent 同源） */
	cacheHitSampleCount?: number;
	cost?: number;
	/** 最近一次 assistant 回复的首 token 延迟（ms；message_start → 首个 text/thinking delta），由主进程本地计时 */
	ttftMs?: number;
	/** 最近一次 assistant 回复的总耗时（ms；message_start → message_end/done/error） */
	totalMs?: number;
	/** 最近一次 assistant 回复的生成速度（tokens/s；output tokens ÷ 生成期时长） */
	tps?: number;
	/** 性能指标结算时刻（Date.now()），渲染层据此判断是否为近期数据 */
	perfAt?: number;
};

export type AvailableModel = {
	id: string;
	name?: string;
	provider: string;
	/** 上下文窗口（token 数，来自 pi --list-models context 列） */
	contextWindow?: number;
	/** 单次输出上限（token 数，来自 max-out 列） */
	maxTokens?: number;
	reasoning?: boolean;
	/** 是否支持图片输入（来自 images 列；undefined = pi 未提供该列） */
	images?: boolean;
};

export type CreateAgentInput = {
	projectId: string;
	title?: string;
	sessionPath?: string;
	/**
	 * PiDeck 会话身份（SessionRecord.id，可能为 UUID 或会话文件路径）。
	 * 会话级安全覆盖（SecurityStore.sessionOverrides）与 PIDECK_SESSION_ID 注入都使用这个 key；
	 * 与 pi 进程自身的 sessionId（AgentTab.sessionId / piSessionId）语义不同，不可混用。
	 */
	deckSessionId?: string;
	environment?: SessionEnvironment;
	source?: SessionSource;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	noSession?: boolean;
};

export type AgentUiResponse = {
	value?: string | boolean;
	cancelled?: boolean;
	confirmed?: boolean;
};

export type AgentUiBatchQuestion = {
	id: string;
	type: "select" | "confirm" | "input" | "editor";
	question: string;
	options?: Array<string | { label: string; value?: string; description?: string }>;
	allowOther?: boolean;
	placeholder?: string;
	prefill?: string;
};

export type AgentUiRequest = {
	agentId: string;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	completed?: boolean;
	value?: string | boolean;
	confirmed?: boolean;
	cancelled?: boolean;
	message?: string;
	notifyType?: "info" | "warning" | "error";
	text?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
	/** A batched ask_question envelope rendered as tabs in the session timeline footer. */
	batchQuestions?: AgentUiBatchQuestion[];
	batchReview?: boolean;
};

/** 实时思考内容更新，用于流式展示模型推理过程。
 *  id 与 History 的 thinking-group id 相同（msg-thinking-${assistantMessageId}），
 *  保证 Live→History 不 remount。 */
export type ThinkingUpdate = {
	agentId: string;
	/** 稳定段 id：与 buildTurnDisplay 的 msg-thinking-* 一致 */
	id: string;
	/** 累积的思考文本（全量快照；流式增量推送时缺省，见 delta） */
	text?: string;
	/** 自上次推送以来的增量（2026-08 治理：避免每 50ms 全量重推长思考文本，
	 *  主/渲染两侧分配器被瞬时 IPC 流量抬到 GB 级 RSS）。渲染层按 id 累积。 */
	delta?: string;
	startedAt: number;
	/** 0 表示仍在流式思考中 */
	endedAt: number;
	/** true：本段结束，渲染层可清 live 通道并回退到 History */
	done: boolean;
};

/** 实时流式正文更新。
 *  messageId 与当前 assistant 消息/骨架 id 一致，用于按消息精确绑定 live 正文。 */
export type TextStreamUpdate = {
	agentId: string;
	messageId?: string;
	text?: string;
	delta?: string;
	done: boolean;
};

/** 输入框发送模式，决定消息直接执行还是以只读方式触发生成计划。 */
export type ComposerAgentMode = "normal" | "plan";

/* ────────────────────────────────────────────────────────────────
 * ask_question 已完成问答的结果契约（跨主进程/桌面/Web 共享）
 *
 * 数据来源：主进程在实时（AgentManager）与历史（AgentMessageProjector）
 * 两条投影路径上，把 pi 的 ask_question 工具结果规范化为
 * AskQuestionResultSummary，挂在 ChatMessage.meta._askCard 上。
 * 渲染层（桌面 TurnRow / Web WebTimeline）据此渲染「常驻问答卡」，
 * 而不是普通可折叠工具详情。
 * ──────────────────────────────────────────────────────────────── */

/** 提问选项：历史数据是纯字符串，新数据是带描述的对象，两者都要兼容。 */
export type AskQuestionResultOption =
	| string
	| {
			label: string;
			value?: unknown;
			description?: string;
	  };

/** 单个问题的问答结果。 */
export type AskQuestionResultItem = {
	question: string;
	type?: "select" | "confirm" | "input" | "editor";
	answered: boolean;
	answer: unknown;
	/** 用户可见的展示文案（自定义输入时为原始文本；选项时为选项 label）。 */
	answerLabel?: string;
	options?: AskQuestionResultOption[];
};

/** 一次 ask_question 调用的完整结果（单题 = 根对象即 item；批量 = questions 数组）。 */
export type AskQuestionResultSummary = AskQuestionResultItem & {
	cancelled: boolean;
	/** 批量提问的完整问答列表（单题可缺省）。 */
	questions?: AskQuestionResultItem[];
};

/**
 * 待回答的 UI 请求快照（Web/飞书轮询用）。
 * 由 SessionRuntimeCoordinator 记录，跨主进程与 Web 渲染层共享，
 * 避免两侧各维护一份不同契约。
 */
export type PendingUiRequestSnapshot = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	batchQuestions?: AgentUiBatchQuestion[];
	batchReview?: boolean;
};
