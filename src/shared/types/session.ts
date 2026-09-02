export type ChatRole = "user" | "assistant" | "tool" | "system" | "error";

export type I18nParams = Record<string, string | number | boolean | null | undefined>;

/** Structured copy crosses process boundaries without forcing main to choose a locale. */
export type I18nDescriptor = {
	i18nKey?: string;
	i18nParams?: I18nParams;
	/** Raw provider/process diagnostics. Renderers may expose this separately from localized copy. */
	debugDetails?: string;
};

export type ChatMessage = {
	id: string;
	agentId: string;
	role: ChatRole;
	text: string;
	timestamp: number;
	meta?: Record<string, unknown> & I18nDescriptor;
	images?: ImageContent[]; // 用户消息中附加的图片
	/** 思考内容：来自 thinking 内容块，用于展示模型推理过程 */
	thinking?: string;
	/** 思考段开始时间（可选；缺省回退 message.timestamp） */
	thinkingStartedAt?: number;
	/** 思考段结束时间（可选；缺省回退 message.timestamp） */
	thinkingEndedAt?: number;
	/**
	 * pi RPC message_end 的 stopReason（provider 归一化枚举）：
	 * stop=最终回复 / toolUse=中间回复（工具调用回合）/ aborted=被打断 /
	 * error|length=异常截断 / pending=message_start 占位（结束时更新为真实值）。
	 * 历史会话/旧版本数据可能缺失，渲染层需回退启发式判定。
	 */
	stopReason?: string;
};

/** A bounded historical timeline slice. `nextBefore` is the exclusive index for an older page. */
export type SessionMessagePage = {
	messages: ChatMessage[];
	total: number;
	nextBefore: number | null;
	/**
	 * 下一页锚点（entryId，2026-11 缓存优先）：页最旧条目的 entryId。
	 * 主进程缓存命中路径用它做续页游标（跨下标空间稳定）；文件路径同义于 nextBefore 指向的条目。
	 * 到顶（nextBefore === null）时缺省。
	 */
	nextBeforeEntryId?: string;
	/** 会话文件版本（mtime:size）：渲染层比对检测压缩/外部改写，变化即丢弃已缓存的历史前缀。 */
	indexVersion?: string;
};

export type FileTreeNode = {
	name: string;
	path: string;
	relativePath: string;
	type: "file" | "directory";
	children?: FileTreeNode[];
	/** 文件元数据（文件树排序用；缺失时回退按名称）。目录 size 无意义恒为 0。 */
	mtimeMs?: number;
	ctimeMs?: number;
	size?: number;
};

export type SessionSource = "pi" | "codex" | "claude" | "opencode";
export type SessionEnvironment = "native" | "wsl";

export type SessionSummary = {
	id: string;
	filePath: string;
	projectPath?: string;
	name?: string;
	/** 子会话：关联的父会话文件路径。有该字段时不在会话列表顶层显示，而是嵌套在父会话下。 */
	parentSessionPath?: string;
	preview: string;
	updatedAt: number;
	messageCount: number;
	/** 会话来源：pi 原生、Codex 导入、Claude 导入、OpenCode 导入 */
	source?: SessionSource;
	/** 标记此会话文件来自 WSL，rename/delete/copy 等操作需走 wsl.exe */
	wsl?: boolean;
	/** 从 JSONL 中的 model_change / thinking_level_change 提取的最后值 */
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	codexSessionId?: string;
	codexThreadSource?: "user" | "subagent";
	codexParentThreadId?: string;
	codexAgentRole?: string;
	codexAgentNickname?: string;
};

/** PiDeck-owned session identity, independent from a running Pi process. */
export type SessionRecord = {
	id: string;
	projectId: string;
	title: string;
	/**
	 * Runtime-only anonymous conversations are deliberately kept out of the
	 * persisted catalog and disappear when their process is closed.
	 */
	noSession?: boolean;
	source: SessionSource;
	environment: SessionEnvironment;
	filePath?: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	projectPath?: string;
	preview: string;
	messageCount: number;
	status: "draft" | "active";
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	createdAt: number;
	updatedAt: number;
	wsl?: boolean;
	codexSessionId?: string;
	codexThreadSource?: "user" | "subagent";
	codexParentThreadId?: string;
	codexAgentRole?: string;
	codexAgentNickname?: string;
};

export type CreateSessionDraftInput = {
	projectId: string;
	title?: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
};

/** 启动前选择的模型与思考级别；显式值优先于 pi 配置默认值。 */
export type SessionLaunchPreferences = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
};

/** Creates a live `--no-session` runtime without writing a session file. */
export type CreateAnonymousSessionInput = {
	projectId: string;
	title?: string;
} & SessionLaunchPreferences;

export type CreateAnonymousSessionResult = {
	session: SessionRecord;
	/** Runtime creation continues in the background so the composer can open immediately. */
	runtime?: SessionRuntimeInfo;
};

export type UpdateSessionRecordInput = {
	title?: string;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
};

export type ForkMessage = {
	entryId: string;
	text: string;
};

/** 图片内容格式，与 pi RPC 的 ImageContent 一致 */
export type ImageContent = {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // 如 "image/png", "image/jpeg", "image/gif", "image/webp"
};

export type ContextControllerState = {
	/** 丢掉全部 toolCall + toolResult（早于最近 keepRecentCount 条的调用） */
	clearToolHistory: boolean;
	/** stub read 正文（早于最近 keepRecentCount 条的调用） */
	clearReadContent: boolean;
	/** stub 非 read 正文（早于最近 keepRecentCount 条的调用） */
	clearCommandContent: boolean;
	/** 保留最近 N 条工具结果原文不裁剪（默认 10，范围 0-99） */
	keepRecentCount: number;
};

export type SendPromptInput = {
	agentId: string;
	message: string;
	images?: ImageContent[]; // 可选的图片列表
	streamingBehavior?: "steer" | "followUp";
	/** 仅发给 Agent 的内部提示，不显示在聊天 UI 中。 */
	agentMessage?: string;
	/** 提示的简短描述/摘要，发给 pi agent 用于标识本次 prompt 的意图。
	 *  从模板 description、用户输入首行自动提取；WebService 等外部来源可不传。 */
	description?: string;
	/** 发送请求的上层 requestId，用于跨 Session/runtime/AgentManager 对齐性能日志。 */
	requestId?: string;
	/** 静默下发：发给 Agent / 扩展但不向时间线追加用户气泡（如 UI 开关调扩展命令）。 */
	silent?: boolean;
};

/** 主进程完成 pi prompt 预检后的明确接收结果。 */
export type SendPromptResult =
	| { accepted: true }
	| ({ accepted: false; error: string; delivery?: "rejected" } & I18nDescriptor)
	| ({ accepted: false; error: string; delivery: "unknown" } & I18nDescriptor);

export type SendSessionPromptInput = Omit<SendPromptInput, "agentId"> & {
	sessionId: string;
	requestId: string;
};

export type SendSessionPromptResult = SendPromptResult & {
	sessionId: string;
	requestId: string;
	agentId?: string;
	sessionPath?: string;
	runtimeGeneration?: number;
};

import type { AgentStatus, AgentUiResponse } from "./agent";

export type SessionRuntimeEvent = {
	kind?: "event" | "detach";
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	sourceChannel: string;
	payload: unknown;
};

export type SessionRuntimeTarget = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

export type SessionRuntimeInfo = SessionRuntimeTarget & {
	projectId: string;
	cwd: string;
	status: AgentStatus;
	sessionPath?: string;
	createdAt: number;
	compactionCount?: number;
	noSession?: boolean;
	/** 本地流式标志：思考/正文 token 仍在推。旧客户端可忽略。 */
	isStreaming?: boolean;
	/** 本地工具执行标志。旧客户端可忽略。 */
	isExecutingTool?: boolean;
};

export type SessionCommandErrorCode =
	| "SESSION_NOT_FOUND"
	| "MESSAGE_NOT_FOUND"
	| "SESSION_RUNTIME_UNAVAILABLE"
	| "SESSION_RUNTIME_CHANGED"
	| "SESSION_RUNTIME_BUSY"
	| "SESSION_COMMAND_FAILED"
	| "SESSION_MODEL_NOT_FOUND";

export type SessionCommandError = {
	code: SessionCommandErrorCode;
	params?: Record<string, string | number>;
	debugDetails?: string;
	/** 模型在本地 models.json 存在但运行中 Agent 的快照未加载：需重启 Agent 生效。 */
	needsRestart?: boolean;
};

export type SessionCommandResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: SessionCommandError };

export type SessionTargetedValue<T> = {
	target: SessionRuntimeTarget;
	value: T;
};

export type SessionRuntimeReplacement = {
	previousTarget: SessionRuntimeTarget;
	runtime: SessionRuntimeInfo;
	session: SessionRecord;
};

export type SessionUiResponseInput = {
	sessionId: string;
	requestId: string;
	agentId: string;
	runtimeGeneration: number;
	response: AgentUiResponse;
};
