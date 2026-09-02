import { resolveNotificationSessionId } from "./agentUtils";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type {
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ForkMessage,
	I18nParams,
	ImageContent,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionEnvironment,
	SessionMessagePage,
	TextStreamUpdate,
	ThinkingUpdate,
} from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { PiProcess } from "./PiProcess";
import { listActiveBuiltInExtensionPaths } from "../extensions/builtInExtensions";
import type {
	PlatformNotifications,
	PlatformApplication,
	PlatformPaths,
} from "../platform/PlatformServices";
import type { RpcResponse } from "./PiRpcClient";
import { formatBashToolMessage } from "./bashResult";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import {
	mergeHistoryWithPreservedMessages,
	stabilizeReloadedMessageIds,
} from "./historyMessages";
import {
	buildAgentSessionKey,
	toAbsoluteSessionPath,
	type AgentSessionIdentityDefaults,
} from "./agentSessionIdentity";
import {
	SessionFileEditor,
	type SessionEntryTarget,
	type SessionFileRef,
} from "./SessionFileEditor";
import { SessionHistoryReader, findTurnPageStart } from "./SessionHistoryReader";
import {
	AgentMessageProjector,
	buildActiveBranchEntryIds as buildActiveBranchEntryIdsForDisplay,
} from "./AgentMessageProjector";
import { buildAskQuestionResultSummary } from "./askQuestionResult";
import { LatestByKeyEmitter } from "./LatestByKeyEmitter";
import {
	createStreamGateState,
	isStreamGateSealed,
	noteAbortSettled,
	openStreamGateForNewRun,
	sealStreamGate,
	type StreamGateState,
} from "./streamGate";
import { createCacheHitStatsReader, type CacheHitStats, type CacheHitStatsReader } from "./cacheHitStats";
import {
	stripAnsi,
	parseAvailableModelsResponse,
	pickNumber,
	clampPercent,
	trimHistoryMessages,
	turnTrimStartIndex,
	countRoleMessagesBefore,
	buildMessageFlushPayload,
	leadingSummaryCards,
	stripToolResultForDelivery,
	cleanTitle,
	inferTitleFromMessages,
	isDefaultAgentTitle,
} from "./agentUtils";
import {
  updateActiveToolCalls,
  type ActiveToolCallState,
} from "../../shared/toolRuntimeState";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SecurityStore } from "../security/SecurityStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RpcLogger } from "../logging/RpcLogger";
import type { RpcLogBatch, RpcLogEntry } from "../../shared/types/rpcLog";
import type { AppLogger } from "../logging/AppLogger";
import {
	toWindowsHostPath,
	toWslLinuxPath,
	type WslEnvironment,
} from "../wsl/WslPaths";

/** 项目信任确认弹窗的用户选择 */
/** 项目信任确认弹窗的用户选择 */
export type ProjectTrustChoice = "trust-remember" | "trust-session" | "deny";

export interface AgentPlatformDeps {
	appName: string;
	appPath: string;
	resourcesPath: string;
	isPackaged: boolean;
	notifications: PlatformNotifications;
	focusSessionFromNotification: (sessionId?: string) => boolean;
	hasLiveWindow?: () => boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isUnsupportedCommandError(errText: string): boolean {
	const lower = errText.toLowerCase();
	return (
		lower.includes("unknown command") ||
		lower.includes("unsupported command") ||
		lower.includes("not supported") ||
		lower.includes("unknown method")
	);
}

const SESSION_IDENTITY_RETRY_DELAYS_MS: readonly number[] = [0, 50, 100, 200];

type MessageLoadOptions = {
	preserveMessagesAfter?: number;
	/** 文件追加/压缩不会让已加载历史失效；编辑/删除等破坏性改写显式传 false。 */
	preserveHistory?: boolean;
	/** 压缩完成后的前缀在本次回底清理周期内保持可见。 */
	stickyHistory?: boolean;
};

type CreateAgentInputWithHistory = CreateAgentInput & {
	/** 重启/重开同一会话时保留 renderer 已展示的历史前缀。 */
	preserveHistoryOnLoad?: boolean;
};

export class AgentManager {
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly messages = new Map<string, ChatMessage[]>();
	/** 历史修改提交后 refresh 失败的 agent 集合，命中时禁用内存消息快速路径、强制读文件。 */
	private readonly staleMessageCacheAgents = new Set<string>();
	/** 工具完整结果 LRU 缓存：按 agent 隔离，避免停止一个会话清空其他会话的结果。 */
	private readonly toolFullTextByAgent = new Map<string, Map<string, string>>();

	/** 当前流式思考的累积文本，用于实时推送给前端展示 */
	private readonly streamingThinking = new Map<string, string>();
	/**
	 * 当前思考段身份：id = msg-thinking-${assistantMessageId}，与 History 一致。
	 * 首 thinking_delta 铸造；message_end/abort 写入 messages 后清掉。
	 */
	private readonly thinkingSegmentByAgent = new Map<
		string,
		{ id: string; assistantMessageId: string; startedAt: number; endedAt: number }
	>();
	/** 当前正在流式更新文本的 agent（message_start/text_delta/thinking_delta 置位，
	 *  message_end/done/error/agent_end/agent_settled/abort 清除）。
	 *  isStreaming 不再只依赖 pi get_state 轮询：轮询在 text_delta 期间不触发，
	 *  前端 streamingMessageId → MarkdownStream 逐字渐显依赖它，缺失会“整段蹦出”。 */
	private readonly streamingAgents = new Set<string>();

	/** 当前是否有任何 agent 正在流式输出（内存采样探针用，避免直接暴露内部 Set）。 */
	hasActiveStreaming(): boolean {
		return this.streamingAgents.size > 0;
	}
	/** 当前正在流式更新的 assistant 消息；tool 事件插入时仍要继续更新同一个回答块。 */
	private readonly activeAssistantMessageIds = new Map<string, string>();
	/** pi 的 toolCallId 贯穿 start/update/end，用它把同一次工具调用合并成一条 UI 记录。 */
	private readonly toolMessageIds = new Map<string, Map<string, string>>();
	/** 每个 agent 只保留一条自动重试状态消息，避免短暂 5xx/网络错误把会话刷屏。 */
	private readonly retryStatusMessageIds = new Map<string, string>();
	/** 同一历史会话正在创建 Agent 时共享同一个 Promise，避免快速重复点击/IPC 竞态创建多个进程。 */
	private readonly creatingSessionAgents = new Map<string, Promise<AgentTab>>();
	/** 工具 start/end 事件的单调序号，renderer 用它忽略迟到的异步完整状态。 */
	private readonly toolStateSequenceByAgent = new Map<string, number>();
	/** 每个 agent 当前仍在执行的 toolCall；并行工具必须等最后一个结束才发 false 边沿。 */
	private readonly activeToolCallsByAgent = new Map<string, Map<string, string>>();
	/** 记录每个 agent 当前执行的工具名称，无工具时为 null */
	private readonly toolExecutingByAgent = new Map<string, string | null>();
	private readonly sessionFileEditor: SessionFileEditor;
	private readonly sessionHistoryReader: SessionHistoryReader;
	private readonly messageProjector: AgentMessageProjector;
	/** 流式消息 emit 节流状态。 */
	private readonly messageFlushTimers = new Map<string, NodeJS.Timeout>();
	private readonly pendingMessageAgents = new Set<string>();
	/** 增量消息 flush 的脏下标：自上次 flush 以来最早的变化位置（取多次标记的最小值）。
	 *  只在流式 upsert/append 高频路径显式标记；编辑/删除/截断/重载不标记 → flush 回退全量。 */
	private readonly messageDirtyFromByAgent = new Map<string, number>();
	/**
	 * 激活显示窗口起点（2026-08 激活分页）：loadMessages 后以「尾部 N 轮」算出，
	 * flush 只下发窗口段；窗口前历史由渲染层走 disk 轮次分页 prepend。
	 */
	private readonly displayWindowStartByAgent = new Map<string, number>();
	/**
	 * 运行期消息缓存头部在会话文件消息下标空间中的偏移（entryId 缺失时的数值游标换算）。
	 * loadMessages / trimRuntimeCache 维护；-1 表示未知（匿名会话等无文件场景）。
	 */
	private readonly messageHeadOffsetByAgent = new Map<string, number>();
	/**
	 * trim 窗口右移滑出显示区的旧窗口头部轮次（待下次全量 flush 下发，渲染层并入历史前缀）。
	 * 防止「翻历史 → 新轮 settle → 窗口前移」时锚点轮从视口消失且无法翻回。
	 */
	private readonly pendingSlideOutByAgent = new Map<string, ChatMessage[]>();
	/** 下一次全量 flush 是否保留 renderer 已加载的历史前缀。缺省按追加语义保留。 */
	private readonly preserveHistoryOnNextFlush = new Map<string, boolean>();
	/** 下一次全量 flush 是否把压缩后的历史前缀暂时标记为 sticky。 */
	private readonly stickyHistoryOnNextFlush = new Set<string>();
	/** 会话文件版本（mtime:size）：随消息载荷下发，渲染层据此校验历史前缀是否仍在同一文件版本。 */
	private readonly sessionFileVersionByAgent = new Map<string, string>();
	/** 每个 agent 的历史加载序号；较早的异步快照完成后不得覆盖较新的加载。 */
	private readonly messageLoadSequenceByAgent = new Map<string, number>();
	private readonly thinkingEmitter = new LatestByKeyEmitter<string, string>(
		50,
		(agentId, thinking) => this.emitThinkingNow(agentId, thinking),
	);
	/** 当前流式正文的累积文本，独立于 messages 数组推送（阶段1：学 Proma 独立存储）。
	 *  50ms 窗口与 Proma PI_PARTIAL_UPDATE_INTERVAL_MS 对齐：渲染层 20fps 更新，
	 *  避免 16ms 高频推送让 streamdown 解析（每 content 变更全量重解析）压满主线程、
	 *  rAF 帧率下降后 queue 积压导致「burst 蹦字」；打字机感由渲染层 useSmoothStream
	 *  （divisor=8 字符队列逐字吐）呈现，不依赖推送粒度。 */
	private readonly textEmitter = new LatestByKeyEmitter<string, string>(
		50,
		(agentId, text) => this.emitTextStreamNow(agentId, text),
	);
	/** 流式正文累积缓冲：text_delta 时累加，message_end/agent_end/settled/abort 清除。 */
	private readonly streamingText = new Map<string, string>();
	private readonly lastSentTextByAgent = new Map<string, string>();
	private readonly textPushCountByAgent = new Map<string, number>();
	private readonly lastSentThinkingByAgent = new Map<string, string>();
	private readonly thinkingPushCountByAgent = new Map<string, number>();
	/** 流式 emit 合并窗口（毫秒）。50ms 兼顾流畅度与传输量，肉眼几乎无延迟。 */
	private static readonly MESSAGE_FLUSH_INTERVAL_MS = 50;
	/** 激活显示窗口轮数（2026-08 激活分页）：loadMessages 后只下发尾部 N 轮，更早历史走 disk 轮次分页。 */
	private static readonly DISPLAY_WINDOW_TURNS = 3;
	/**
	 * agent_end 后等待 agent_settled 的超时时间（毫秒）。
	 * 如果 Pi 在此时间内未发送 agent_settled，桌面端将主动查询 get_state 并尝试恢复 idle。
	 * 这补偿了 Pi 在某些边缘情况下不发送 agent_settled 导致动画永久卡住的问题。
	 */
	private static readonly AGENT_SETTLED_TIMEOUT_MS = 5000;
	/** pi_agent_rust currently emits sessionId-bearing agent_end without agent_settled. */
	private static readonly RUST_AGENT_SETTLED_TIMEOUT_MS = 250;
	/** Runtime kind observed from the lifecycle event shape; cleared with the Agent. */
	private readonly rustRuntimeAgents = new Set<string>();
	/**
	 * 超过该大小的历史会话跳过 get_messages RPC，改为直接从 JSONL 文件尾部读取最近 N 条消息。
	 * pi 当前不支持 limit/cursor，40MB JSONL 会以单行大 JSON 返回，主进程 JSON.parse 会短暂冻结整个应用。
	 * 文件直接读取仅解析近尾部少量消息，避免大会话加载导致的界面冻结。
	 */
	private static readonly MAX_AUTO_HISTORY_LOAD_BYTES = 5 * 1024 * 1024;
	/** 工具完整结果 LRU 上限（见 toolFullTextByAgent）。 */
	private static readonly TOOL_FULL_TEXT_LRU_LIMIT = 200;
	/**
	 * 大会话直接从文件尾部读取时，最多保留的最近消息轮次（每条 user 消息算一轮）。
	 * 12 轮 = 4 次 3 轮翻页，覆盖绝大多数回看需求；更早历史走磁盘轮次分页。
	 */
	private static readonly MAX_HISTORY_LOAD_TURNS = 12;
	/**
	 * 运行期消息缓存上限（轮）：agent_settled 后把主进程数组裁到最近 N 轮。
	 * 12 轮覆盖激活窗口（3 轮）+ 三级缓存的回看命中率；头部更早历史随时可从文件分页读回。
	 */
	private static readonly MAX_RUNTIME_CACHE_TURNS = 12;
	/**
	 * 工具结果文本截断阈值（字符数）。工具结果（如 bash 输出、文件读取）可能达数十 KB，
	 * 若完整存入 ChatMessage.meta 并随流式 emit 反复全量传输，会显著放大 IPC payload
	 * 并推高渲染进程内存，是大会话白屏的重要诱因。超长结果保留首尾各一部分，中间省略。
	 */
	/** 本地事件监听器（用于 Web SSE 等主进程内部订阅） */
	private readonly localEventListeners = new Set<
		(agentId: string, event: unknown, streamGeneration: number) => void
	>();
	/** 主进程内部观察所有 renderer 输出，用于增量桥接 session-addressed 事件。 */
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();
	/** 开启了 RPC 日志记录的 agent id 集合 */
	private readonly rpcLoggingAgents = new Set<string>();
	/**
	 * 实时 RPC 日志广播缓冲：按 agent 聚合待发条目，节流刷出。
	 * 流式阶段 RPC 事件可能非常高频，逐条 IPC 会把渲染进程打爆，必须批量推送。
	 */
	private readonly pendingLiveRpcLogs = new Map<string, RpcLogEntry[]>();
	private liveRpcLogFlushTimer: NodeJS.Timeout | null = null;
	/** 实时日志广播节流间隔：聚合 ~80ms 的条目一次性推送 */
	private static readonly LIVE_RPC_LOG_FLUSH_MS = 80;
	/** 单次广播批次的条数上限，防止单条 IPC 负载过大 */
	private static readonly LIVE_RPC_LOG_MAX_BATCH = 100;
	/** 聚合缓冲的条数上限，极端高频时丢弃最旧条目，防止内存失控 */
	private static readonly LIVE_RPC_LOG_MAX_PENDING = 1000;
	/** 正在执行手动压缩操作的 agent，用于区分手动压缩重启和异常崩溃 */
	private readonly compactingAgents = new Set<string>();
	/** 手动压缩期间 Pi 是否已经开始了后续 agent run；用于避免 finally 提前置 idle。 */
	private readonly manualCompactionFollowUpAgents = new Set<string>();
	/** 手动压缩期间收到 compaction_start 的 agent；用于区分 Pi 事件标记与本地 RPC 标记。 */
	private readonly manualCompactionEventAgents = new Set<string>();
	/** 手动 compact 已经由 RPC 路径负责 reload；迟到 compaction_end 只收口，不重复加载。 */
	private readonly manualCompactionReloadClaims = new Set<string>();
	/**
	 * Pi 通过事件报告正在自动/手动压缩的 agent。
	 * 自动压缩发生在 agent_end 之后，桌面端若不单独追踪，会过早把会话置为 idle，
	 * 用户随后发送的新消息可能撞上 Pi 内部 compaction，表现为“会话中断”。
	 */
	private readonly rpcCompactingAgents = new Set<string>();
	/** 正在执行模型配置刷新的 agent，用于退出处理器中忽略进程退出事件 */
	private readonly modelRefreshingAgents = new Set<string>();
	/** 用户主动停止的 agent，用于退出处理器中跳过自动重连 */
	private readonly userInitiatedStop = new Set<string>();
	/** 已尝试过自动重连的 agent（防止无限循环），重连成功后清除 */
	private readonly autoRestartAttempted = new Set<string>();
	/**
	 * 用户主动 abort 后正在等待 pi 确认的 agent。
	 * abort() 先加入该集合，再发送 abort RPC；在收到 agent_settled 或下一个 agent_start 之前，
	 * 用于抑制 auto-retry/compaction 等状态回写，避免把侧边栏重新标成 running。
	 * 流式事件拦截改走 streamGate（按 generation 封印），不再依赖本集合。
	 */
	private readonly recentlyAborted = new Set<string>();
	/**
	 * 每个 agent 的流式 generation 闸门。
	 * abort 封印当前 generation；须等 abort settled（或超时兜底）后，
	 * 再由 agent_start 推进 generation 放行，防止残留 thinking/text delta 串台。
	 */
	private readonly streamGates = new Map<string, StreamGateState>();

	/**
	 * 流式性能计时：以 sendPrompt 发出的请求时刻为起点（而非收到 message_start），
	 * 首个 thinking/text delta 记 firstDeltaAt，正文首 delta 记 firstTextAt，
	 * message_end/done/error 结算。用于计算首 token 延迟（TTFT）、总耗时与生成速度（TPS）。
	 * pi 不暴露耗时字段，只能由本地事件时间戳推算。
	 */
	private readonly messagePerfByAgent = new Map<
		string,
		{ startedAt: number; firstDeltaAt: number; firstTextAt: number }
	>();

	/** sendPrompt 发出的请求时刻（毫秒），供首个 message_start 起表时优先使用（含排队时间）。 */
	private readonly promptRequestedAtByAgent = new Map<string, number>();

	/** 最近一次 assistant 回复的性能指标（结算后保留，供 getRuntimeState 合并展示）。 */
	private readonly lastPerfByAgent = new Map<
		string,
		{ ttftMs?: number; totalMs: number; tps?: number; at: number }
	>();
	/** abort 后等待 agent_settled 的超时定时器；避免 pi 漏发 settled 导致永久封印。 */
	private readonly abortSettledFallbackTimers = new Map<string, NodeJS.Timeout>();
	/** abort settled 兜底超时：覆盖多数管道残留，同时不让“立刻重发”永久卡死。 */
	private static readonly ABORT_SETTLED_FALLBACK_MS = 1500;
	/** abort 升级验证窗口：abort_bash + 二次 abort 后仍 running 则提示用户。 */
	private static readonly ABORT_ESCALATION_VERIFY_MS = 4000;

	/**
	 * 待处理的 Extension UI 请求。key 为 agentId，value 为 Map<requestId, { method, title, options }>。
	 * 用于在 abort 时及时发送 cancellation 防止 pi 等待超时。
	 */
	private readonly pendingUIRequests = new Map<string, Map<string, { method: string; title: string }>>();
	/** abort 时正在等待 ask_question 响应的 agent，用于在工具结果中覆写 answer 为 null。 */
	private readonly abortedDuringAsk = new Set<string>();
	/** 已发送 ask 系统通知的 agent；新一轮 run（agent_start）时清除，避免同一轮多次提问刷屏。 */
	private readonly notifiedAskAgents = new Set<string>();
	/** 待处理的项目信任确认请求。key 为 requestId，用于在 Agent 启动前等待用户的信任决策。 */
	private readonly pendingTrustRequests = new Map<string, { resolve: (choice: ProjectTrustChoice) => void }>();
	private wslEnvironment: WslEnvironment | null = null;

	/**
	 * 记录 agent 的 entryId 获取源能力（"rpc" 表示支持 get_entries，"file" 表示不支持、直接读 JSONL）。
	 * 仅在收到明确的 Unknown command 错误时缓存为 "file"，偶发超时/网络错误不永久劣化。
	 */
	private readonly entrySourceByAgent = new Map<string, "rpc" | "file">();

	/**
	 * 用户配置的 RPC 超时（默认 600s，SettingsStore 另有「低于 600s 自动提升」保险）。
	 * 发送消息与启动/重连等用户可感知的等待路径统一吃该配置，
	 * 与启动诊断卡里的指引（“Increase the RPC timeout in settings”）保持一致，
	 * 避免用户调大配置却只对 prompt 生效、启动仍按硬编码 30s 超时的误导。
	 */
	private get rpcTimeoutMs(): number {
		return this.settingsStore.get().rpcTimeout;
	}

	constructor(
		private readonly getProject: (id: string) => Project | undefined,
		private readonly sendToRenderer: (channel: string, ...args: unknown[]) => void,
		private readonly settingsStore: SettingsStore,
		private readonly configManager: ConfigManager,
		private readonly rpcLogger?: RpcLogger,
		private readonly appLogger?: AppLogger,
		sessionFileEditor?: SessionFileEditor,
		private readonly translate: (
			key: MainProcessTranslationKey,
			params?: Record<string, string | number>,
		) => string = () => "Agent operation failed.",
		/** 每次 spawn pi 进程前回调（如刷新模型列表缓存）；异步但不等完成，避免阻塞 Agent 启动。 */
		private readonly onBeforeAgentSpawn?: () => void,
		/** 安全管理：Agent 启动前写策略快照 + 注入会话身份（缺省时不注入安全门）。 */
		private readonly securityStore?: SecurityStore,
		/**
		 * spawn pi 前对会话文件的预检/修复（剔除旧版 PiDeck 私有 sessionName 头行，
		 * 该行会让 pi 拒绝加载会话并 exit 1，见 #114）。由 main/index.ts 装配 SessionScanner 实现。
		 */
		private readonly repairSessionFile?: (sessionPath: string) => Promise<boolean>,
		/**
		 * agentId → SessionRecord.id 解析（由 main/index.ts 注入 coordinator.getSessionId）。
		 * 通知 toast 的 launch 必须携带 record.id：renderer 的 sessionRecordByIdAtomFamily
		 * 只索引 record.id，而 tab.sessionId 是 pi 侧会话 id。
		 */
		private readonly resolveSessionId?: (agentId: string) => string | undefined,
		private readonly platformDeps?: AgentPlatformDeps,
	) {
		this.messageProjector = new AgentMessageProjector({
			translate: this.translate,
			isAskAborted: (agentId) => this.abortedDuringAsk.has(agentId),
		});
		this.sessionFileEditor = sessionFileEditor ?? new SessionFileEditor({
			logger: appLogger
				? {
					warn: (message, details) => appLogger.warn("session-file", message, details),
				}
				: undefined,
		});
		this.sessionHistoryReader = new SessionHistoryReader({
			toHostPath: (sessionPath) => this.toSessionHostPath(sessionPath),
			convertMessages: (agentId, rawMessages, activeEntryIds) =>
				this.convertAgentMessages(agentId, rawMessages, activeEntryIds),
			trimMessages: (rawMessages, maxTurns) => trimHistoryMessages(rawMessages, maxTurns),
			translate: this.translate,
			logger: appLogger,
		});
	}

	configureWsl(environment: WslEnvironment | null): void {
		this.wslEnvironment = environment;
	}

	/**
	 * 统一构造 PiProcess：注入 PiDeck 内置扩展路径解析 + 安全管理快照/会话身份。
	 * 内置扩展以 -e 从 app resources 加载，不再依赖用户扩展目录副本。
	 * 安全管理：确保策略快照已落盘（小 JSON 写，等完成后启动，保证扩展首次拦截即可读到）。
	 */
	private createPiProcess(cwd: string, sessionPath?: string, securitySessionKey?: string): PiProcess {
		const settings = this.settingsStore.get();
		if (this.securityStore) {
			void this.securityStore.ensureSnapshotWritten();
		}
		return new PiProcess(cwd, settings, undefined, {
			resolveBuiltInExtensionPaths: (processSettings) =>
				listActiveBuiltInExtensionPaths(
					{
						appPath: this.platformDeps?.appPath ?? process.cwd(),
						resourcesPath: this.platformDeps?.resourcesPath ?? process.cwd(),
						isDev: this.platformDeps ? !this.platformDeps.isPackaged : true,
					},
					processSettings?.removedBuiltInExtensions ?? settings.removedBuiltInExtensions ?? [],
				),
			// 会话身份 = PiDeck 会话 key（SessionRecord.id，UUID 或旧版文件路径），扩展按它解析等级覆盖；
			// 匿名会话（noSession）无 key，扩展仅用全局默认等级。
			securitySessionId: securitySessionKey ?? sessionPath,
			securitySnapshotPath: this.securityStore?.getSnapshotPath(),
			// 预检修复：全部 spawn 路径（create/reattach/withTemporarySession）都在 start() 内生效。
			repairSessionFileBeforeStart: this.repairSessionFile,
		});
	}

	/** Windows 主进程文件操作必须使用可由 host 访问的路径。 */
	private toSessionHostPath(sessionPath: string): string {
		return this.wslEnvironment
			? toWindowsHostPath(sessionPath, this.wslEnvironment)
			: sessionPath;
	}

	/** Pi/RPC/session identity 在 WSL 模式下始终使用 Linux 逻辑路径。 */
	private toSessionProtocolPath(sessionPath: string): string {
		return this.wslEnvironment
			? toWslLinuxPath(sessionPath, this.wslEnvironment)
			: sessionPath;
	}

	/**
	 * 归一化 pi 上报/传入的会话路径为绝对路径（含日志）。
	 * pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，get_state 返回的
	 * sessionFile 是相对 cwd 的；若原样写入 catalog，会与扫描器发现的绝对路径
	 * 构成同文件双记录（侧栏重复显示），且文件操作会落到错误位置。
	 */
	private normalizeSessionPathFromPi(
		sessionPath: string | undefined,
		projectPath: string,
		environment: SessionEnvironment,
	): string | undefined {
		if (!sessionPath) return undefined;
		const resolved = toAbsoluteSessionPath(sessionPath, projectPath, environment);
		if (resolved !== sessionPath) {
			void this.appLogger?.warn("agent", "Session file path was relative; resolved to absolute", {
				sessionPath,
				resolved,
			});
		}
		return resolved;
	}

	list() {
		return [...this.agents.values()]
			.map((runtime) => runtime.tab)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	/** 本地流式/工具标志，不发 get_state RPC；供 Web /api/state 轮询。 */
	getLocalStreamingFlags(agentId: string): {
		isStreaming: boolean;
		isExecutingTool: boolean;
	} {
		return {
			isStreaming: this.streamingAgents.has(agentId),
			isExecutingTool: !!this.toolExecutingByAgent.get(agentId),
		};
	}

	/**
	 * 与 create/reattach 的 get_state 使用同一设置值，供 SessionRuntimeCoordinator
	 * 等待 starting runtime 时共享 deadline，避免慢机器被第二套硬编码 timeout 提前清理。
	 */
	getStartupTimeoutMs(): number {
		return this.rpcTimeoutMs;
	}

	/**
	 * 判断指定项目是否仍有运行中的 Agent（pi 子进程未退出）。
	 * 用于删除项目前拦截，避免删除后 pi 进程悬挂后台继续占用资源。
	 */
	hasAgentForProject(projectId: string): boolean {
		for (const runtime of this.agents.values()) {
			if (runtime.tab.projectId === projectId) return true;
		}
		return false;
	}

	getMessages(agentId: string) {
		return this.messages.get(agentId) ?? [];
	}

	isMessageCacheStale(agentId: string): boolean {
		return this.staleMessageCacheAgents.has(agentId);
	}

	/**
	 * 补取 Pi 延迟创建的持久会话身份。
	 *
	 * 原版 Pi 通常在进程启动后的首个 get_state 就返回 sessionFile；部分兼容实现
	 * 会在首条 prompt 被接受后才异步创建 JSONL。这里使用同一条 stdio RPC 通道做
	 * 短时、有界重试，让上层能把草稿 Session 绑定到实际文件并复用目录去重逻辑。
	 */
	async refreshSessionIdentity(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
		if (runtime.tab.noSession || runtime.tab.sessionPath) return runtime.tab;

		for (const delayMs of SESSION_IDENTITY_RETRY_DELAYS_MS) {
			if (delayMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			}
			if (this.agents.get(agentId) !== runtime || !runtime.process.isRunning()) break;

			const response = await runtime.process.client
				.request({ type: "get_state" }, Math.min(this.rpcTimeoutMs, 2_000))
				.catch(() => ({ success: false, data: undefined }));
			if (!response.success) continue;
			const data = response.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			const sessionPath = this.normalizeSessionPathFromPi(
				data?.sessionFile,
				this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd,
				runtime.tab.sessionEnvironment ?? "native",
			);
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			if (data?.sessionName) runtime.tab.title = data.sessionName;
			if (!sessionPath) continue;

			runtime.tab.sessionPath = sessionPath;
			this.emitState();
			void this.appLogger?.info("agent", "Delayed session identity resolved", {
				agentId,
				sessionPath,
			});
			break;
		}
		return runtime.tab;
	}

	/**
	 * 枚举正在运行的 pi agent 子进程（agentId → pid）。
	 * 供进程监控面板使用：仅返回存活进程，退出/未启动的不计入。
	 */
	listAgentPids(): Array<{ agentId: string; pid: number }> {
		const result: Array<{ agentId: string; pid: number }> = [];
		for (const [agentId, runtime] of this.agents) {
			const pid = runtime.process.pid;
			if (pid != null && runtime.process.isRunning()) {
				result.push({ agentId, pid });
			}
		}
		return result;
	}

	/**
	 * 窗口首条消息在会话文件消息下标空间中的位置（无 entryId 窗口的数值游标）。
	 * 消息数组头部可能存在系统摘要卡片（compaction/branchSummary，文件消息空间无对应条目），
	 * 因此用「headOffset + (windowStart - 卡片数)」换算；窗口完全落在卡片区时返回 undefined。
	 */
	private computeWindowStartFilePos(
		agentId: string,
		all: ChatMessage[],
		windowStart: number,
	): number | undefined {
		const headOffset = this.messageHeadOffsetByAgent.get(agentId);
		if (headOffset === undefined || headOffset < 0) return undefined;
		const cardCount = leadingSummaryCards(all, all.length).length;
		const offset = windowStart - cardCount;
		if (offset < 0) return undefined;
		return headOffset + offset;
	}

	/**
	 * 显示窗口视图（2026-08 激活分页）：替换/激活路径的下发与 flush 保持同一协议——
	 * 窗口段消息 + windowStart + totalLength + fileVersion。
	 */
	getMessageWindow(agentId: string): {
		messages: ChatMessage[];
		windowStart?: number;
		totalLength: number;
		fileVersion?: string;
		windowStartFilePos?: number;
	} {
		const all = this.messages.get(agentId) ?? [];
		const windowStart = Math.min(
			Math.max(0, this.displayWindowStartByAgent.get(agentId) ?? 0),
			all.length,
		);
		const fileVersion = this.sessionFileVersionByAgent.get(agentId);
		// 窗口前若存在系统摘要卡片（压缩/分支），prepend 回来——压缩卡片插在数组最前，
		// 不 prepend 会被窗口 slice 切掉（与 buildMessageFlushPayload 全量分支同一约定）。
		const summaryCards = leadingSummaryCards(all, windowStart);
		const windowStartFilePos = this.computeWindowStartFilePos(agentId, all, windowStart);
		return {
			messages: stripToolResultForDelivery([...summaryCards, ...all.slice(windowStart)]),
			totalLength: all.length,
			...(windowStart > 0 ? { windowStart } : {}),
			...(fileVersion ? { fileVersion } : {}),
			...(windowStartFilePos !== undefined ? { windowStartFilePos } : {}),
		};
	}

	/**
	 * 按需读取消息完整文本（「查看完整输出」）：优先运行期工具结果缓存
	 * （toolFullTextByAgent，仅截断下发后的完整文本），回退会话文件定位读取
	 * （SessionHistoryReader 内部有 LRU）。找不到或读取失败抛错，由 IPC 层转结构化错误。
	 */
	async readMessageFullText(
		agentId: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		const cached = this.toolFullTextByAgent.get(agentId)?.get(messageId);
		if (cached !== undefined) return { text: cached };
		const runtime = this.agents.get(agentId);
		const sessionPath = runtime?.tab.sessionPath;
		if (!sessionPath) {
			throw new Error(`Message full text unavailable: session path missing for agent ${agentId}`);
		}
		return this.sessionHistoryReader.readMessageFullText(sessionPath, messageId, entryId);
	}

	/**
	 * 按会话文件路径直接读取单条消息完整文本（不依赖运行期绑定）。
	 * 历史会话浏览（_viewer 投影，无 runtime）的「查看完整输出」走此路径。
	 */
	async readMessageFullTextFromFile(
		sessionPath: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		return this.sessionHistoryReader.readMessageFullText(sessionPath, messageId, entryId);
	}

	/**
	 * The reader owns persisted JSONL parsing and paging. This facade keeps the
	 * Session-first public contract on AgentManager while runtime remains inactive.
	 */
	async readSessionDisplayMessages(
		sessionPath: string,
		agentId = "_viewer",
		sessionContent?: string,
	): Promise<ChatMessage[]> {
		return stripToolResultForDelivery(
			await this.sessionHistoryReader.readSessionDisplayMessages(sessionPath, agentId, sessionContent),
		);
	}

	async readSessionDisplayMessagePage(
		sessionPath: string,
		agentId = "_viewer",
		before?: number,
		pageSize?: number,
	): Promise<SessionMessagePage> {
		const page = await this.sessionHistoryReader.readSessionDisplayMessagePage(
			sessionPath,
			agentId,
			before,
			pageSize,
		);
		return { ...page, messages: stripToolResultForDelivery(page.messages) };
	}

	/** 轮次维度显示分页：pageSize 复用为轮次数（readSessionDisplayTurnPage 内部夹紧上限） */
	async readSessionDisplayTurnPage(
		sessionPath: string,
		agentId = "_viewer",
		before?: number,
		turnCount?: number,
		beforeEntryId?: string,
	): Promise<SessionMessagePage> {
		const page = await this.sessionHistoryReader.readSessionDisplayTurnPage(
			sessionPath,
			agentId,
			before,
			turnCount,
			beforeEntryId,
		);
		return { ...page, messages: stripToolResultForDelivery(page.messages) };
	}

	/**
	 * 缓存优先的历史翻页：运行中会话的「加载更早对话」先在主进程内存缓存（最近 12 轮）里切片，
	 * 命中则零文件 IO；未命中返回 null，调用方回退 SessionHistoryReader 读文件。
	 *
	 * 游标：beforeEntryId 优先（跨下标空间稳定）；before 为文件绝对下标时先解析成 entryId 再查缓存。
	 * 命中边界：锚点条目必须在缓存中且不是缓存第一条（第一条之前没有缓存内容，交给文件路径）。
	 * 返回页的 nextBefore/nextBeforeEntryId 统一换算回文件下标空间，渲染层续页协议不变。
	 */
	async tryReadRuntimeTurnPage(
		sessionPath: string,
		agentId: string,
		options: { beforeEntryId?: string; before?: number; turnCount?: number },
	): Promise<SessionMessagePage | null> {
		const runtime = this.agents.get(agentId);
		const list = this.messages.get(agentId);
		if (!runtime || !list || list.length === 0) return null;
		// 防御：运行时已切到别的会话（替换/重绑）时禁止用其缓存应答本会话的翻页，
		// 交给文件路径（调用方以稳定 sessionId 经 coordinator 解析，此处兜底双保险）。
		if (
			runtime.tab.sessionPath &&
			this.toSessionHostPath(runtime.tab.sessionPath) !== this.toSessionHostPath(sessionPath)
		) {
			return null;
		}

		let pos = -1;
		if (options.beforeEntryId) {
			pos = list.findIndex((m) => m.meta?.entryId === options.beforeEntryId);
		} else if (options.before !== undefined) {
			const entryId = await this.sessionHistoryReader.resolveEntryIdAtPosition(sessionPath, options.before);
			if (!entryId) return null;
			pos = list.findIndex((m) => m.meta?.entryId === entryId);
			// 锚点是缓存最旧条目：缓存里没有比它更早的内容，交给文件路径
			if (pos === 0) return null;
		}
		if (pos < 0) return null;

		const turnCount = Math.min(
			Math.max(1, Math.floor(options.turnCount ?? 3)),
			SessionHistoryReader.maxTurnPageSize(),
		);
		const roles = list.map((m) => ({ role: m.role, byteLength: 0 }));
		const start = findTurnPageStart(roles, pos, turnCount, Number.MAX_SAFE_INTEGER);
		if (start >= pos) return null;
		const page = list.slice(start, pos);
		const oldest = page[0] ?? list[0];
		const oldestEntryId = typeof oldest?.meta?.entryId === "string" ? oldest.meta.entryId : undefined;
		// 缓存页的 nextBefore 必须是文件下标空间。缺 entryId 或解析失败时，
		// 不能用运行时数组下标冒充，更不能写成 null（那是「已经到顶」）。
		// 这两种情况都回退文件路径，由 SessionHistoryReader 给出正确游标。
		if (!oldestEntryId) return null;
		const resolvedOldest = await this.sessionHistoryReader.resolveEntryPosition(sessionPath, oldestEntryId);
		if (resolvedOldest === undefined) return null;
		const nextBefore = resolvedOldest;
		const total = await this.sessionHistoryReader.getActiveEntryCount(sessionPath);
		// 与文件路径同口径的会话文件版本：渲染层据此检测压缩/外部改写并丢弃已缓存的历史前缀
		// （indexVersion 缺失会让 cache 页沿用旧版本，压缩后前缀失效不可见）。
		const indexVersion = await this.sessionHistoryReader.getSessionIndexVersion(sessionPath);
		void this.appLogger?.info("agent", "Runtime history cache hit", {
			agentId,
			start,
			pos,
			pageCount: page.length,
		});
		return {
			messages: page,
			total,
			nextBefore,
			...(oldestEntryId ? { nextBeforeEntryId: oldestEntryId } : {}),
			indexVersion,
		};
	}

	recordHostExchange(agentId: string, userText: string, assistantText: string) {
		this.addMessage(agentId, "user", userText);
		this.addMessage(agentId, "assistant", assistantText);
	}

	getCwd(agentId: string) {
		return this.requireRuntime(agentId).tab.cwd;
	}

	async loadMessages(
		agentId: string,
		skipEntries = false,
		earlyMessagesPromise?: Promise<RpcResponse>,
		options?: MessageLoadOptions,
	) {
		const t0 = Date.now();
		const runtime = this.requireRuntime(agentId);
		const loadProcess = runtime.process;
		const loadSessionPath = runtime.tab.sessionPath;
		const loadSequence = (this.messageLoadSequenceByAgent.get(agentId) ?? 0) + 1;
		this.messageLoadSequenceByAgent.set(agentId, loadSequence);
		const isCurrentLoad = () => {
			const current = this.agents.get(agentId);
			return Boolean(
				current &&
				current.process === loadProcess &&
				current.tab.sessionPath === loadSessionPath &&
				this.messageLoadSequenceByAgent.get(agentId) === loadSequence,
			);
		};
		const staleLoadResult = () => this.messages.get(agentId) ?? [];

		// 并行请求：get_messages 和 get_entries 互不依赖，可以同时发起
		// 如果已有提前发出的请求（earlyMessagesPromise），直接复用，避免重复发送
		const messagesPromise = earlyMessagesPromise ?? runtime.process.client.request({
			type: "get_messages",
		}, this.rpcTimeoutMs);

		let entriesPromise: Promise<string[] | undefined> | undefined;
		if (!skipEntries) {
			entriesPromise = this.resolveActiveEntryIds(agentId, runtime).catch(() => {
				// resolveActiveEntryIds 失败时不阻塞消息加载；编辑/删除走 fallback（_piDeckMsgSeq 计数）
				void this.appLogger?.warn("agent", "Failed to resolve activeEntryIds for entryId mapping", { agentId });
				return undefined;
			});
		}

		const [response, resolvedEntryIds] = await Promise.all([
			messagesPromise,
			entriesPromise ?? Promise.resolve(undefined),
		]);
		if (!isCurrentLoad()) return staleLoadResult();
		const t1 = Date.now();

		const rawMessages = (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];
		let activeEntryIds = resolvedEntryIds;

		// 按对话轮次截断（保留最近若干轮 user 消息）。压缩摘要不是 user 消息，会被此逻辑保留在尾部，
		// 因此下方会单独把它插到最前面，确保不被按 user 轮次切掉。
		const trimmed = trimHistoryMessages(rawMessages);
		const trimmedStart = turnTrimStartIndex(rawMessages);

		// 身份向量必须与保留消息同步裁剪：activeEntryIds 按「消费槽位的角色消息」与 rawMessages
		// 一一对应，trim 丢弃头部整轮后，若仍把完整 activeEntryIds 交给 projector，保留消息会被
		// 绑定到会话最早的 entry——编辑/删除/重发将落到错误轮次（曾因 15 轮裁剪复现 q4→u1）。
		// compactionSummary/branchSummary 不消费槽位，prepend 到最前不影响对齐。
		let droppedRoleCount = 0;
		if (activeEntryIds && trimmedStart > 0) {
			droppedRoleCount = countRoleMessagesBefore(rawMessages, trimmedStart);
			activeEntryIds = activeEntryIds.slice(droppedRoleCount);
		}
		// 记录缓存头部在文件消息下标空间中的位置：无 entryId 的窗口（skipEntries 大历史路径）
		// 需要用它作为首次补历史的数值游标（渲染层 before=windowStartFilePos）。
		let headOffset: number;
		if (activeEntryIds) {
			headOffset = droppedRoleCount;
		} else if (runtime.tab.sessionPath) {
			// get_entries 失败/未启用（skipEntries）时同样尽力提供数值游标：
			// 否则渲染层「加载更多对话」因 entryId 锚点与 windowStartFilePos 双缺失而静默放弃，
			// 表现为点击无反应（2026-02 修复，此前仅 skipEntries 路径走此兑底）。
			const roleCount = trimmed.reduce<number>((count, message) => {
				const role = (message as { role?: unknown } | undefined)?.role;
				return count + (role === "user" || role === "assistant" || role === "toolResult" ? 1 : 0);
			}, 0);
			// 最佳努力：文件活动消息数 - 缓存内角色消息数 ≈ 被裁头部长度。
			// 文件里非角色 message 条目（system 等）会让该值偏大，属极端边角；
			// entryId 锚点仍是首选路径，此值只作为无 entryId 时的兜底游标。
			const activeFileCount = await this.sessionHistoryReader
				.getActiveEntryCount(runtime.tab.sessionPath)
				.catch(() => 0);
			if (!isCurrentLoad()) return staleLoadResult();
			headOffset = Math.max(0, activeFileCount - roleCount);
		} else {
			headOffset = -1; // 未知：不提供 windowStartFilePos，渲染层回退 entryId 锚点
		}

		// 解析会话文件里的压缩记录：拿到所有压缩段摘要 + 归档消息。
		// pi 的 get_messages 对压缩会话只返回压缩后的消息，通常不带压缩摘要；
		// 这里从原始会话文件补回：压缩摘要卡片 + 归档消息（支持展开查看压缩前内容）。
		// 若 RPC 已经返回了压缩/分支摘要，则不再重复补，避免时间线出现两张摘要卡片。
		let compactionSummaryRaw: unknown | null = null;
		let archiveDataCompactionCount = runtime.tab.compactionCount;
		const rpcAlreadyHasSummary = rawMessages.some(
			(m) => (m as { role?: unknown })?.role === "compactionSummary"
				|| (m as { role?: unknown })?.role === "branchSummary",
		);
		void this.appLogger?.info("agent", "Compaction check", {
			agentId,
			hasSessionPath: !!runtime.tab.sessionPath,
			rpcAlreadyHasSummary,
			rawMessageCount: rawMessages.length,
		});
		if (runtime.tab.sessionPath) {
			const archiveData = await this.scanCompactions(runtime.tab.sessionPath).catch((err) => {
				void this.appLogger?.warn("agent", "Failed to parse session archives", {
					agentId,
					sessionPath: runtime.tab.sessionPath,
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			});
			if (!isCurrentLoad()) return staleLoadResult();
			if (archiveData && archiveData.compactions.length > 0) {
				void this.appLogger?.info("agent", "Session archives parsed", {
					agentId,
					compactionCount: archiveData.compactions.length,
					rpcAlreadyHasSummary,
				});

				const last = archiveData.compactions[archiveData.compactions.length - 1];

				if (!rpcAlreadyHasSummary) {
					// RPC 未返回摘要 → 我们自己创建压缩卡片（只带元信息，归档消息按需读取）
					compactionSummaryRaw = {
						role: "compactionSummary",
						summary: last.summary || this.translate("session.summaryPlaceholder"),
						timestamp: last.timestamp ? Date.parse(last.timestamp) : Date.now(),
						meta: {
							compactionId: last.id || null,
							compactionCount: archiveData.compactions.length,
							firstKeptEntryId: last.firstKeptEntryId,
							tokensBefore: last.tokensBefore,
						},
					};
				}
				archiveDataCompactionCount = archiveData.compactions.length;
			}
		}

		// 文件版本随本次加载快照：普通外部改写会改变 mtime:size，渲染层据此校验
		// disk 前缀；压缩路径通过 preserveHistory 明确保留已展示的对话。
		// 所有异步 I/O 在此处全部完成，确认当前 load 依然有效后，再原子写入状态。
		let sessionFileVersion: string | undefined;
		if (runtime.tab.sessionPath) {
			try {
				const version = await stat(this.toSessionHostPath(runtime.tab.sessionPath));
				if (!isCurrentLoad()) return staleLoadResult();
				sessionFileVersion = `${version.mtimeMs}:${version.size}`;
			} catch {
				if (!isCurrentLoad()) return staleLoadResult();
				sessionFileVersion = undefined;
			}
		}
		if (!isCurrentLoad()) return staleLoadResult();

		// 将压缩摘要插到消息最前面（在 trim 之后，避免被按 user 轮次切掉）。
		const finalRaw = compactionSummaryRaw ? [compactionSummaryRaw, ...trimmed] : trimmed;
		const messages = this.convertAgentMessages(agentId, finalRaw, activeEntryIds);
		const t2 = Date.now();
		void this.appLogger?.info("agent", "Agent messages loaded", {
			agentId,
			skipEntries,
			rawMessages: rawMessages.length,
			trimmedMessages: trimmed.length,
			requestMs: t1 - t0,
			convertMs: t2 - t1,
			totalMs: t2 - t0,
		});

		// 把压缩次数写回 tab，供前端（会话头/标签）展示"已压缩 N 次"。
		if (runtime.tab.compactionCount !== archiveDataCompactionCount) {
			runtime.tab.compactionCount = archiveDataCompactionCount;
			this.emitState();
		}
		this.messageHeadOffsetByAgent.set(agentId, headOffset);
		// abort 时 ask_question 的 answer 已被覆写为 null，不再需要跟踪
		this.abortedDuringAsk.delete(agentId);
		const currentMessages = this.messages.get(agentId) ?? [];
		const nextMessages = stabilizeReloadedMessageIds(
			currentMessages,
			mergeHistoryWithPreservedMessages(
				messages,
				currentMessages,
				options?.preserveMessagesAfter,
			),
		);
		// 重载后把进行中的消息身份（activeAssistantMessageIds/toolMessageIds）从
		// 运行期副本重定向到投影版：后续事件继续更新投影版（位置正确、单份），
		// 避免「投影 partial + 运行期完整版」双份或事件 append 到错误轮次。
		this.rebindInFlightMessages(agentId, nextMessages, messages);
		this.messages.set(agentId, nextMessages);
		this.staleMessageCacheAgents.delete(agentId);
		// 显示窗口 = 尾部 3 轮（轮次起点对齐 user 消息，与 disk 轮次分页同一约定；
		// 字节预算不参与窗口计算——单轮再大也整轮显示，折叠完整性优先）
		this.displayWindowStartByAgent.set(
			agentId,
			findTurnPageStart(
				nextMessages.map((m) => ({ role: m.role, byteLength: 0 })),
				nextMessages.length,
				AgentManager.DISPLAY_WINDOW_TURNS,
				Number.MAX_SAFE_INTEGER,
			),
		);
		if (runtime.tab.sessionPath) {
			if (sessionFileVersion) {
				this.sessionFileVersionByAgent.set(agentId, sessionFileVersion);
			} else {
				this.sessionFileVersionByAgent.delete(agentId);
			}
		}
		this.refreshAutoTitle(agentId);
		this.preserveHistoryOnNextFlush.set(agentId, options?.preserveHistory !== false);
		if (options?.stickyHistory) this.stickyHistoryOnNextFlush.add(agentId);
		else this.stickyHistoryOnNextFlush.delete(agentId);
		this.scheduleMessageEmit(agentId, true);
		return nextMessages;
	}

	async create(rawInput: CreateAgentInputWithHistory) {
		const input = rawInput.sessionPath
			? { ...rawInput, sessionPath: this.toSessionProtocolPath(rawInput.sessionPath) }
			: rawInput;
		const sessionKey = buildAgentSessionKey(input, this.getAgentSessionIdentityDefaults());
		if (!sessionKey) return this.createUnlocked(input);

		// 先复用同一 session 的 in-flight 创建 Promise；createUnlocked 会很早把
		// starting runtime 放进 agents，若先查 agents，第二次调用会绕过真正的去重等待。
		const pendingCreate = this.creatingSessionAgents.get(sessionKey);
		if (pendingCreate) return pendingCreate;

		const existingForSession = this.findRuntimeBySessionKey(sessionKey);
		if (existingForSession) return existingForSession.tab;

		// 历史会话激活属于“一个 sessionPath 只能对应一个 Agent”的业务规则；
		// 先登记 in-flight Promise，再启动真实创建，防止第二次点击绕过 agents map 检查。
		const createPromise = this.createUnlocked(input).finally(() => {
			this.creatingSessionAgents.delete(sessionKey);
		});
		this.creatingSessionAgents.set(sessionKey, createPromise);
		return createPromise;
	}

	private getAgentSessionIdentityDefaults(): AgentSessionIdentityDefaults {
		return this.wslEnvironment
			? {
				environment: "wsl",
				wslDistro: this.wslEnvironment.distro,
				wslUser: this.wslEnvironment.user,
			}
			: { environment: "native" };
	}

	private getHistoryAutoLoadDecision(sessionPath?: string): { shouldLoad: boolean; sizeBytes?: number } {
		if (!sessionPath) return { shouldLoad: true };
		try {
			const sizeBytes = statSync(this.toSessionHostPath(sessionPath)).size;
			return {
				shouldLoad: sizeBytes <= AgentManager.MAX_AUTO_HISTORY_LOAD_BYTES,
				sizeBytes,
			};
		} catch {
			// 无法读取大小时保留旧行为尝试加载，避免临时文件/权限异常直接导致历史不可见。
			return { shouldLoad: true };
		}
	}

	private async readRecentMessagesFromSessionFile(
		sessionPath: string,
		maxTurns: number,
	): Promise<RpcResponse> {
		return this.sessionHistoryReader.readRecentMessages(sessionPath, maxTurns);
	}

	private async scanCompactions(
		sessionPath: string,
		sessionContent?: string,
	) {
		return this.sessionHistoryReader.scanCompactions(
			sessionPath,
			sessionContent,
		);
	}

	private findRuntimeBySessionKey(sessionKey: string) {
		const defaults = this.getAgentSessionIdentityDefaults();
		return [...this.agents.values()].find(
			(runtime) => buildAgentSessionKey({
				projectId: runtime.tab.projectId,
				sessionPath: runtime.tab.sessionPath,
				environment: runtime.tab.sessionEnvironment,
				source: runtime.tab.sessionSource,
				wslDistro: runtime.tab.wslDistro,
				wslUser: runtime.tab.wslUser,
				importedSourceId: runtime.tab.importedSourceId,
			}, defaults) === sessionKey,
		);
	}

	private async createUnlocked(input: CreateAgentInputWithHistory) {
		const t0 = Date.now();
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);

		const sessionIdentityDefaults = this.getAgentSessionIdentityDefaults();
		const sessionEnvironment = input.environment ?? sessionIdentityDefaults.environment;
		const id = randomUUID();
		void this.appLogger?.info("agent", "Agent create requested", {
			agentId: id,
			projectId: input.projectId,
			projectPath: project.path,
			sessionPath: input.sessionPath,
			title: input.title,
		});
		const existingForSessionKey = buildAgentSessionKey(input, sessionIdentityDefaults);
		const existingForSession = existingForSessionKey
			? this.findRuntimeBySessionKey(existingForSessionKey)
			: undefined;
		if (existingForSession) {
			void this.appLogger?.info("agent", "Agent create reused existing session", {
				agentId: existingForSession.tab.id,
				sessionPath: input.sessionPath,
			});
			return existingForSession.tab;
		}

		const tab: AgentTab = {
			id,
			projectId: project.id,
			cwd: project.path,
			title: input.title || `${project.name} agent`,
			status: "starting",
			deckSessionId: input.deckSessionId,
			sessionPath: input.sessionPath,
			sessionEnvironment,
			sessionSource: input.source ?? "pi",
			wslDistro: input.wslDistro ?? (
				sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslDistro : undefined
			),
			wslUser: input.wslUser ?? (
				sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslUser : undefined
			),
			importedSourceId: input.importedSourceId,
			noSession: input.noSession,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		const trustOverride = await this.ensureProjectTrust(project);
		const t2 = Date.now();

		void this.appLogger?.info("agent", "Agent pi process start", { agentId: id });
		// 每次 spawn 前异步刷新模型列表缓存（不等完成，避免阻塞 Agent 启动）：
		// 用户直接编辑 models.json/auth.json 后，下一次启动的 Agent 即能看到新模型。
		this.onBeforeAgentSpawn?.();
		const process = this.createPiProcess(project.path, input.sessionPath, input.deckSessionId);
		process.on("version-check", (payload) => {
			void this.appLogger?.info("agent", "Pi version check completed", {
				agentId: id,
				...(payload && typeof payload === "object" ? payload : {}),
			});
		});
		const runtime: AgentRuntime = { tab, process };
		this.agents.set(id, runtime);
		this.messages.set(id, []);
		this.emitState();

		// 关键：监听器必须在 process.start() 之前挂上。
		// spawn 的 ENOENT / EACCES 等 error 事件是异步的；若等 start() 返回后再 on("error")，
		// 中间窗口可能 0 listener，EventEmitter 会把 error 升级成未捕获异常，
		// 在部分 macOS arm 环境上表现为“一点启动 Agent 就闪退”。
		this.attachPiProcessLifecycle(id, process, {
			projectPath: project.path,
			onExit: (payload) => this.handleCreateProcessExit(id, tab, payload),
		});

		let client: Awaited<ReturnType<PiProcess["start"]>>;
		try {
			client = await process.start(input.sessionPath, trustOverride, input.noSession);
		} catch (error) {
			// start() 同步失败（非法 cwd、spawn 抛错等）也要落到会话错误卡，而不是 IPC 裸抛。
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Agent pi process start threw", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
				diagnostics: process.getDiagnostics(),
				// 注意：局部变量 process 是 PiProcess，宿主平台要用 globalThis.process
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			this.addMessage(id, "error", this.buildStartupFailureMessage(rawMessage, process.getDiagnostics()));
			this.emitState();
			return tab;
		}
		const t3 = Date.now();
		const diag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process spawned", {
			agentId: id,
			prepareMs: t1 - t0,
			trustMs: t2 - t1,
			spawnCallMs: t3 - t2,
			command: diag?.command,
			args: diag?.args?.join(' '),
			cwd: diag?.cwd,
		});

		// 启动后先获取状态，get_messages 必须等状态就绪后再发送，
		// 确保 pi 进程已完全加载会话文件，避免竞态导致返回空结果。
		void this.appLogger?.info("agent", "Agent get_state request start", { agentId: id });
		// 启动 get_state 吃用户配置的 rpcTimeout：WSL/代理/慢机器上 pi 首次响应可能超过默认 30s，
		// 超时即触发「Pi RPC 启动失败」诊断卡；与诊断指引（调大设置里的 RPC 超时）保持一致。
		const statePromise = client.request({ type: "get_state" }, this.rpcTimeoutMs);
		const historyLoadDecision = this.getHistoryAutoLoadDecision(input.sessionPath);


		try {
			void this.appLogger?.info("agent", "Agent get_state request completed", { agentId: id });
			const state = await statePromise;
			const t4 = Date.now();
			void this.appLogger?.info("agent", "Agent get_state completed", {
				agentId: id,
				stateMs: t4 - t3,
				totalSinceCreateMs: t4 - t0,
			});
			const data = state.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			tab.sessionId = data?.sessionId;
			tab.sessionPath = this.normalizeSessionPathFromPi(
				data?.sessionFile ?? input.sessionPath,
				project.path,
				sessionEnvironment,
			);
			tab.title =
				input.title ||
				data?.sessionName ||
				(input.sessionPath
					? this.translate("session.historyTitle", { project: project.name })
					: `${project.name} agent`);
			tab.status = "idle";
			// 大历史会话的 get_messages 可能需要十几秒；Agent 可用只依赖 get_state，
			// 因此历史消息后台加载，避免 40MB+ 会话把“打开 Agent”阻塞到十几秒。
			// 同时插入一条临时系统消息，给用户明确的加载反馈，避免空白页面看起来像冻结。
			// preserveMessagesAfter 保护加载期间用户新发的消息/流式回复，防止历史结果回写时覆盖当前会话。
			// 状态就绪后发送 get_messages，确保 pi 进程已完全加载会话文件，避免竞态。
			const messagesPromise = historyLoadDecision.shouldLoad
				? client.request({ type: "get_messages" }, this.rpcTimeoutMs)
				: undefined;
			const preserveMessagesAfter = Date.now();
			// 重开已有会话（停止后再启动、restart）时，新进程只会投影尾部窗口。
			// 必须保留 renderer 已展示的前缀，并暂时阻止回底清理把中间轮次立刻收走。
			const historyLoadOptions: MessageLoadOptions = {
				preserveMessagesAfter,
				...((input.sessionPath || input.preserveHistoryOnLoad)
					? { preserveHistory: true, stickyHistory: true }
					: {}),
			};
			if (messagesPromise) {
				void this.loadMessages(id, true, messagesPromise, historyLoadOptions)
					.catch(() =>
						new Promise<void>((resolve) => setTimeout(resolve, 800))
							.then(() => this.loadMessages(id, true, undefined, historyLoadOptions)),
					)
					.then(() => {
						void this.appLogger?.info("agent", "Agent history loaded in background", {
							agentId: id,
							totalMs: Date.now() - preserveMessagesAfter,
						});
					})
					.catch((error) => {
						const list = this.messages.get(id) ?? [];
						const loadingMessage = list.find((message) => message.meta?.historyLoading === true);
						if (loadingMessage) {
							loadingMessage.role = "error";
							loadingMessage.text = "历史会话加载失败，可继续使用当前 Agent 或重新打开会话重试。";
							loadingMessage.meta = {
								historyLoading: "failed",
								i18nKey: "diagnostic.historyLoadFailed",
								debugDetails: error instanceof Error ? error.message : String(error),
							};
							loadingMessage.timestamp = Date.now();
							this.scheduleMessageEmit(id, true);
						}
						void this.appLogger?.warn("agent", "Agent history background load failed", {
							agentId: id,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			} else if (input.sessionPath) {
				void this.loadMessages(
					id,
					true,
					this.readRecentMessagesFromSessionFile(
						input.sessionPath,
						AgentManager.MAX_HISTORY_LOAD_TURNS,
					),
					historyLoadOptions,
				)
					.then(() => {
						void this.appLogger?.info("agent", "Agent recent history loaded from file", {
							agentId: id,
							sessionPath: input.sessionPath,
							sizeBytes: historyLoadDecision.sizeBytes,
							totalMs: Date.now() - preserveMessagesAfter,
						});
					})
					.catch((error) => {
						const list = this.messages.get(id) ?? [];
						const loadingMessage = list.find((message) => message.meta?.historyLoading === true);
						if (loadingMessage) {
							loadingMessage.role = "error";
							loadingMessage.text = "历史会话加载失败，可继续使用当前 Agent 或重新打开会话重试。";
							loadingMessage.meta = {
								historyLoading: "failed",
								i18nKey: "diagnostic.historyLoadFailed",
								debugDetails: error instanceof Error ? error.message : String(error),
							};
							loadingMessage.timestamp = Date.now();
							this.scheduleMessageEmit(id, true);
						}
						void this.appLogger?.warn("agent", "Agent recent history file load failed", {
							agentId: id,
							sessionPath: input.sessionPath,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				totalMs: Date.now() - t0,
				historyLoading: "background",
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
			});
			// 构建丰富的错误诊断信息
			const diag = process.getDiagnostics();
			let debugDetails: string | undefined;
			if (diag) {
				const lines: string[] = [];
				// 退出码
				if (diag.exitCode !== null) {
					lines.push(`Exit code: ${diag.exitCode}${diag.exitSignal ? ` (signal: ${diag.exitSignal})` : ""}`);
				}
				// stderr 输出（截取末尾最有用的部分）
				const stderrText = diag.stderr.join("").trim();
				if (stderrText) {
					// 只保留末尾 600 字符，避免刷屏
					const snippet = stderrText.length > 600 ? "…" + stderrText.slice(-600) : stderrText;
					lines.push(`Process stderr:\n${snippet}`);
				}
				// pi 路径与版本检测
				lines.push(`Pi command: ${diag.command}`);
				if (diag.customPiPath) {
					lines.push(`Configured path: ${diag.customPiPath}`);
				}
				lines.push(`Working directory: ${diag.cwd}`);
				lines.push(`Version check: ${diag.versionCheck ? "passed" : "failed"}`);

				// 诊断与指引
				lines.push("");
				lines.push("Troubleshooting");
				if (!diag.versionCheck) {
					lines.push("1. Run pi --version in a terminal and verify the configured path.");
					lines.push("2. If Pi is missing, run npm install -g @earendil-works/pi-coding-agent.");
					lines.push("3. Run pi --version again after installation.");
				} else if (diag.exitCode !== 0) {
					lines.push("1. Run pi --mode rpc in a terminal.");
					lines.push("2. Resolve the error reported by Pi before retrying.");
				} else if (!stderrText && diag.exitCode === null) {
					lines.push("1. Pi may still be starting. Increase the RPC timeout in settings and retry.");
				} else {
					lines.push("1. Run pi --mode rpc and verify that Pi starts successfully.");
					lines.push("2. Verify the Pi path in settings.");
				}
				lines.push("");
				lines.push("If the problem persists, include these diagnostics in a GitHub issue.");

				debugDetails = lines.join("\n");
			}
			this.addLocalizedMessage(id, "error", "diagnostic.agentStartFailed", "Pi RPC 启动失败。", {
				debugDetails: [rawMessage, debugDetails].filter(Boolean).join("\n\n"),
			});
		}

		this.emitState();
		return tab;
	}

	async rename(agentId: string, name: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmed = name.replace(/\s+/g, " ").trim();
		if (!trimmed) throw new Error(this.translate("mainAgent.nameRequired"));

		// 会话名属于 pi 原生 session 元数据；通过 RPC 修改，避免 desktop 手写 JSONL 后与 pi 格式演进脱节。
		const response = await runtime.process.client.request(
			{ type: "set_session_name", name: trimmed },
			20_000,
		);
		if (!response.success) {
			void this.appLogger?.warn("agent", "Session rename failed", {
				agentId,
				error: response.error,
			});
			throw new Error(this.translate("mainAgent.renameFailed"));
		}

		runtime.tab.title = trimmed;
		const state = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => ({ data: undefined }));
		const data = state.data as
			| { sessionId?: string; sessionFile?: string; sessionName?: string }
			| undefined;
		runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
		runtime.tab.sessionPath = this.normalizeSessionPathFromPi(
			data?.sessionFile ?? runtime.tab.sessionPath,
			this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd,
			runtime.tab.sessionEnvironment ?? "native",
		);
		runtime.tab.title = data?.sessionName || runtime.tab.title;
		this.emitState();
		return runtime.tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		const trimmed = input.message.trim();
		const hasImages = input.images && input.images.length > 0;
		const agentMessage = input.agentMessage?.trim() || trimmed || "Describe this image.";
		// 允许只有图片没有文字的情况发送；silent 模式下允许 message 为空由 agentMessage 驱动
		if (!trimmed && !hasImages && !input.agentMessage?.trim()) {
			return {
				accepted: false,
				error: "消息不能为空",
				i18nKey: "diagnostic.messageRequired",
			};
		}

		// 解析 !/!! 前缀：与 pi 终端行为一致
		// !command  → 执行命令并将输出发送给 LLM（excludeFromContext: false）
		// !!command → 执行命令但不将输出发送给 LLM（excludeFromContext: true）
		const isBashExcluded = trimmed.startsWith("!!");
		const isBashNormal = !isBashExcluded && trimmed.startsWith("!");

		if (isBashExcluded || isBashNormal) {
			const command = isBashExcluded
				? trimmed.slice(2).trim()
				: trimmed.slice(1).trim();
			if (command) {
				return this.executeBashCommand(input.agentId, command, isBashExcluded);
			}
		}

		// 判断 agent 是否已在忙碌中；运行中继续发送时必须带 streamingBehavior，
		// 否则 pi RPC 会拒绝请求。该值也用于给用户消息打上投递语义标记。
		const alreadyBusy = runtime.tab.status === "running";
		const statusBeforePrompt = runtime.tab.status;
		const promptDeliveryBehavior = input.streamingBehavior ?? (alreadyBusy ? "steer" : undefined);

		// 在设置状态为 running 之前检查进程是否还活着，避免进程崩溃后状态不一致
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			if (!input.silent) {
				this.addLocalizedMessage(
					input.agentId,
					"error",
					"diagnostic.agentStopped",
					errorMessage,
				);
			}
			this.emitState();
			return { accepted: false, error: errorMessage, i18nKey: "diagnostic.agentStopped" };
		}

		// 静默命令必须是已注册扩展命令；否则会当成普通 prompt 发给模型。
		if (input.silent) {
			const isExtensionCommand = await this.promptMatchesRegisteredExtensionCommand(runtime, agentMessage);
			if (!isExtensionCommand) {
				return {
					accepted: false,
					error: "Context controller command is unavailable",
					i18nKey: "ctx.switches.pluginDisabled",
				};
			}
			if (alreadyBusy) {
				return {
					accepted: false,
					error: "Can't change context while generating",
					i18nKey: "ctx.switches.busyDisabled",
				};
			}
		}

		if (!input.silent) {
			runtime.tab.status = "running";
			this.emitState();

			// 乐观更新：在等待 RPC 返回前先把用户消息写入会话，让用户立即看到自己的消息。
			// 只展示用户原文；agentMessage 里的宿主指令不进 UI 气泡。
			// 如果后续 RPC 失败，再追加错误消息；用户消息本身仍保留在聊天中（用户确已发送）。
			this.addMessage(
				input.agentId,
				"user",
				trimmed || this.translate("session.imagePlaceholder"),
				promptDeliveryBehavior ? { streamingBehavior: promptDeliveryBehavior } : undefined,
				input.images,
			);
		}

		// streamingBehavior 只在 agent 忙碌时需要；UI 可以显式传 steer/followUp 以复用 pi 队列语义。
		// 当前端排队 flush 连续发送多条消息时，第一条会触发 agent_start 使 agent 变忙碌，
		// 后续消息必须带 streamingBehavior 否则 pi 直接返回 error。这里自动兜底。
		// images 用于传递粘贴/拖拽的图片，pi 会将 base64 图片直接传给支持视觉的模型。
		try {
			const promptIsExtensionCommand = await this.promptMatchesRegisteredExtensionCommand(runtime, agentMessage);
			const requestPayload: Record<string, unknown> = {
				type: "prompt",
				message: agentMessage,
				...(input.description ? { description: input.description } : {}),
				...(hasImages ? { images: input.images } : {}),
			};
			// 如果 agent 已经忙碌且调用方没指定 streamingBehavior，默认用 steer；
			// 与上方用户消息 meta 保持同一个计算结果，避免 UI 标记和实际 RPC 语义不一致。
			if (promptDeliveryBehavior) {
				requestPayload.streamingBehavior = promptDeliveryBehavior;
			}
			// 使用用户配置的 RPC 超时时间，因为用户提示词可能触发长时间运行的命令或复杂操作
			const rpcStartedAt = Date.now();
			// 静默扩展命令不进入模型回合，不能占用首字计时起点，否则会污染下一次真实回复的 TTFT。
			if (!input.silent) {
				// 首字计时起点：RPC 请求发出时刻（而非收到 message_start），把 pi 内部排队与
				// 模型服务端等待计入用户体感的首 token 延迟，避免统计系统性偏短。
				this.promptRequestedAtByAgent.set(input.agentId, rpcStartedAt);
			}
			void this.appLogger?.info("session-perf", "Prompt RPC request started", {
				agentId: input.agentId,
				requestId: input.requestId,
			});
			const response = await runtime.process.client.request(
				requestPayload,
				this.settingsStore.get().rpcTimeout,
			);
			void this.appLogger?.info("session-perf", "Prompt RPC response received", {
				agentId: input.agentId,
				requestId: input.requestId,
				success: response.success,
				rpcMs: Date.now() - rpcStartedAt,
			});
			if (!response.success) {
				// pi RPC 会把不支持图片、忙碌队列参数缺失等前置错误作为 success:false 返回；
				// 必须显式显示出来，否则 UI 会停在"已发送但无响应"的状态。
				const errorMessage = response.error ?? "图片消息发送失败";
				runtime.tab.status = statusBeforePrompt === "running" ? "running" : "idle";
				if (!input.silent) {
					this.addLocalizedMessage(
						input.agentId,
						"error",
						"diagnostic.promptRejected",
						"消息发送失败。",
						{ debugDetails: errorMessage },
					);
				}
				this.emitState();
				return {
					accepted: false,
					error: errorMessage,
					i18nKey: "diagnostic.promptRejected",
					debugDetails: errorMessage,
				};
			}

			if (promptIsExtensionCommand) {
				// 机制：Pi 扩展命令可在 prompt 阶段直接执行并返回，不进入 agent run。
				// 证据：@earendil-works/pi-coding-agent/dist/core/agent-session.js 中 AgentSession.prompt()
				//      先调用 _tryExecuteExtensionCommand()；命中后 return，不再调用 _runAgentPrompt()。
				// 推导：不能等 agent_end；只有 Pi get_state 明确报告无剩余工作时才恢复 idle。
				this.scheduleIdleCheckAfterExtensionCommand(input.agentId);
			}
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// prompt RPC 调用前已通过同步 write() 写入 pi stdin；此处所有异常都只说明
			// preflight 响应未到达，无法证明 pi 没有接收。返回 unknown，renderer 会永久禁用
			// 该快照的重试/编辑/取消，防止用户把同一条消息提交两次。
			runtime.tab.status = statusBeforePrompt === "running" ? "running" : "error";
			if (!input.silent) {
				this.addLocalizedMessage(
					input.agentId,
					"error",
					"diagnostic.promptDeliveryUnknown",
					"消息接收结果未知。请先检查当前会话，避免重复发送；必要时重启 Agent。",
					{ debugDetails: errorMessage },
				);
			}
			this.emitState();
			return {
				accepted: false,
				error: errorMessage,
				delivery: "unknown",
				i18nKey: "diagnostic.promptDeliveryUnknown",
				debugDetails: errorMessage,
			};
		}
	}

	/**
	 * 执行 bash 命令并通过 tool 消息展示输出，行为与 pi 终端的 !/!! 前缀一致。
	 * excludeFromContext 控制输出是否作为上下文发送给 LLM。
	 */
	private async executeBashCommand(
		agentId: string,
		command: string,
		excludeFromContext: boolean,
	): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(agentId);
		const statusBeforeCommand = runtime.tab.status;
		
		// 检查进程是否还活着
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addLocalizedMessage(agentId, "error", "diagnostic.agentStopped", errorMessage);
			this.emitState();
			return { accepted: false, error: errorMessage, i18nKey: "diagnostic.agentStopped" };
		}
		
		runtime.tab.status = "running";
		this.emitState();

		try {
			const response = await runtime.process.client.request(
				{
					type: "bash",
					command,
					excludeFromContext,
				},
				60_000,
			);

			if (!response.success) {
				const errorMessage = response.error ?? "命令执行失败";
				this.addLocalizedMessage(
					agentId,
					"error",
					"diagnostic.commandFailed",
					"命令执行失败。",
					{ debugDetails: errorMessage },
				);
				return {
					accepted: false,
					error: errorMessage,
					i18nKey: "diagnostic.commandFailed",
					debugDetails: errorMessage,
				};
			}

			this.addMessage(
				agentId,
				"user",
				`${excludeFromContext ? "!!" : "!"}${command}`,
			);
			const data = response.data as
				| {
						output?: string;
						exitCode?: number;
						cancelled?: boolean;
						truncated?: boolean;
				  }
				| undefined;

			const output = data?.output ?? "";
			const exitCode = data?.exitCode ?? 0;
			const cancelled = data?.cancelled ?? false;

			if (cancelled) {
				this.addLocalizedMessage(
					agentId,
					"system",
					"diagnostic.commandCancelled",
					"命令已取消",
				);
			} else {
				// 以 tool 消息展示命令输出，与 pi 终端的 bash 结果展示保持一致
				const toolMessage = formatBashToolMessage({
					command,
					output,
					exitCode,
					excludeFromContext,
					translate: (key, params) => this.translate(key, params),
				});
				this.addMessage(agentId, "tool", toolMessage.text, toolMessage.meta);
			}
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// bash 请求也在计时前写入 stdin；异常只能判定响应未知。对于可能有副作用的命令，
			// 把它标成可重试失败会比保守阻止重试更危险。
			runtime.tab.status = statusBeforeCommand === "running" ? "running" : "error";
			this.addLocalizedMessage(
				agentId,
				"error",
				"diagnostic.commandDeliveryUnknown",
				"命令接收结果未知。请先检查命令输出或工作区状态，避免重复执行。",
				{ debugDetails: errorMessage },
			);
			return {
				accepted: false,
				error: errorMessage,
				delivery: "unknown",
				i18nKey: "diagnostic.commandDeliveryUnknown",
				debugDetails: errorMessage,
			};
		} finally {
			if (runtime.tab.status !== "error") {
				runtime.tab.status = statusBeforeCommand === "running" ? "running" : "idle";
			}
			this.emitState();
		}
	}

	async abort(agentId: string) {
		const runtime = this.requireRuntime(agentId);

		// pi 在等待 extension_ui_response 时（如 ask_question），不发 abort 也能处理，
		// 但必须解除 pending 请求的阻塞，否则 pi 不会继续读取 stdin 中的后续命令。
		// 发 cancelled: true 会导致 pi 返回 undefined，ask_question 工具默认选第一个；
		// 改发 value: null（不带 cancelled 标记），select parser 返回 null，
		// 工具 result 的 answer = null，answered 为 false → 卡片显示"已取消"。
		const pending = this.pendingUIRequests.get(agentId);
		if (pending && pending.size > 0) {
			this.abortedDuringAsk.add(agentId);
			for (const [requestId] of pending) {
				runtime.process.client.sendRaw({
					type: "extension_ui_response",
					id: requestId,
					value: null,
				});
				// The extension receives null to preserve its cancellation semantics, while
				// the renderer must immediately remove the runtime-only interaction.
				this.emit(ipcChannels.agentsUiRequest, {
					agentId,
					requestId,
					completed: true,
					cancelled: true,
				});
			}
		}

		// 标记最近中止的 agent，用于抑制 auto-retry/compaction 把状态重新标为 running。
		// 必须在发送 abort RPC 之前加入集合，避免事件处理函数在 RPC 发出后、
		// handlePiEvent 返回前收到管道中的旧事件并重建 assistant 消息。
		this.recentlyAborted.add(agentId);
		// 封印当前 stream generation：比 recentlyAborted 更硬，不依赖 activeAssistantMessageIds 例外条件，
		// 残留 thinking/text/tool 事件在 abort settled 前一律丢弃。
		const sealedGate = this.sealAgentStream(agentId);
		this.scheduleAbortSettledFallback(agentId, runtime.process, sealedGate.currentGeneration);

		runtime.process.client
			.request({ type: "abort" }, 10_000)
			.catch(() => {
				// abort 超时或失败不影响前端状态切换
			});

		// Pending dialogs are runtime-only, so clearing their request map is enough.
		if (pending && pending.size > 0) {
			this.pendingUIRequests.delete(agentId);
		}
		// abort 时必须清除所有流式状态，防止后续 pi 的延迟事件（text_delta、thinking_delta、tool_execution_* 等）
		// 修改上次会话的旧消息，导致新会话消息混入被中止的旧输出。
		// 先把已累积思考落入当前 assistant 骨架（保留中断轮的推理），再清 live 通道。
		this.finalizeThinkingIntoMessage(agentId);
		this.flushMessageEmit(agentId);
		this.finishThinkingChannel(agentId);
		this.activeAssistantMessageIds.delete(agentId);
		this.setStreamingAgent(agentId, false);
		this.textEmitter.cancel(agentId);
		this.streamingText.delete(agentId);
		this.lastSentTextByAgent.delete(agentId);
		this.textPushCountByAgent.delete(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		const hadActiveTool = Boolean(
			this.toolExecutingByAgent.get(agentId) ||
			(this.activeToolCallsByAgent.get(agentId)?.size ?? 0) > 0,
		);
		this.toolMessageIds.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.set(agentId, null);
		// abort 直接清本地工具状态时必须同步发送 false 边沿，
		// 否则 renderer 可能只收到 idle，却继续保留旧的工具 spinner。
		if (hadActiveTool) this.emitToolRuntimeTransition(agentId, false);
		// 工具边沿不含 isStreaming；abort 后必须再发一次关边沿，避免 spinner 残。
		this.emitStreamingStatePatch(agentId);
		// 取消节流中的 message 推送，避免 abort 后还有 pending flush 把旧内容刷回 UI。
		this.cancelMessageEmit(agentId);

		runtime.tab.status = "idle";
		// 停止反馈改 toast，不再写入会话时间线：
		// 1) 系统状态卡片太抢眼；2) 插在 assistant 中间会打断 agent-run 分组，放大“消息串台”体感。
		this.emit(ipcChannels.agentsNotice, {
			agentId,
			message: "已请求停止当前响应",
			i18nKey: "app.abortRequested",
			kind: "info",
			duration: 2500,
		});
		this.emitState();
	}

	/**
	 * 手动触发上下文压缩。pi 会将历史消息摘要化以释放 context 空间，
	 * 适用于长时间对话后 context 占比过高、但不想丢失关键信息的场景。
	 *
	 * 注意：pi 在压缩完成后可能会自动重启进程（尤其早期版本），此时 RPC 请求会因
	 * "pi exited" 错误而失败。本方法检测到进程退出后会自动重连同一会话并加载消息，
	 * 因此调用方不应把 RPC 失败等同于压缩失败。
	 */
	async compact(agentId: string, prompt?: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmedPrompt = prompt?.trim();
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Compact requested", {
			agentId,
			prompt: trimmedPrompt,
			hasSessionPath: !!runtime.tab.sessionPath,
		});

		// 已有压缩在进行：拒绝重复请求。
		if (this.compactingAgents.has(agentId) || this.rpcCompactingAgents.has(agentId)) {
			void this.appLogger?.info("agent", "Compact skipped: already compacting", { agentId });
			return this.getRuntimeState(agentId);
		}

		// 标记压缩中，退出处理器据此区分压缩重启与异常崩溃
		this.consumeManualCompactionReloadClaim(agentId);
		this.compactingAgents.add(agentId);
		this.rpcCompactingAgents.add(agentId);
		if (runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
			runtime.tab.status = "running";
			this.emitState();
			void this.emitRuntimeState(agentId);
		}

		try {
			const response = await runtime.process.client.request(
				trimmedPrompt
					? { type: "compact", customInstructions: trimmedPrompt }
					: { type: "compact" },
				120_000,
			);
			void this.appLogger?.info("agent", "Compact RPC response received", {
				agentId,
				elapsedMs: Date.now() - startTime,
				rpcSuccess: response.success,
				rpcError: response.error,
			});

			// success:false 必须抛给上层：渲染层靠错误文案映射 nothing-to-do / too-small
			// 友好 toast。之前只 warn 不抛，导致「暂无可压缩内容」永远到不了 UI（#113 3.2-7）。
			if (!response.success) {
				const rpcError = response.error?.trim() || "compact failed";
				void this.appLogger?.warn("agent", "Compact RPC returned failure", {
					agentId,
					error: rpcError,
				});
				throw new Error(rpcError);
			}

			// 压缩成功且进程未退出，直接加载消息（压缩期间乐观/流式消息不能丢：保护到重载完成）。
			// claim 只覆盖这次 loadMessages；加载一结束立刻收票，避免吃掉后续自动压缩。
			this.claimManualCompactionReload(agentId);
			try {
				await this.loadMessages(agentId, false, undefined, {
					preserveHistory: true,
					stickyHistory: true,
				}).catch(() => undefined);
			} finally {
				this.consumeManualCompactionReloadClaim(agentId);
			}
			void this.appLogger?.info("agent", "Compact completed successfully", {
				agentId,
				totalElapsedMs: Date.now() - startTime,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const processAlive = runtime.process.isRunning();
			void this.appLogger?.error("agent", "Compact failed", {
				agentId,
				elapsedMs: Date.now() - startTime,
				error: errorMsg,
				processAlive,
				hasSessionPath: !!runtime.tab.sessionPath,
			});

			// 如果进程在压缩期间退出（pi 压缩后自动重启进程的行为），
			// RPC 请求会因连接断开而失败，但压缩实际已完成。
			// 尝试重连同一会话，不从 compact() 层面抛出错误。
			if (!processAlive && runtime.tab.sessionPath) {
				void this.appLogger?.info("agent", "Compact: process exited, reattaching", {
					agentId,
				});
				await this.reattachProcess(agentId, runtime.tab.sessionPath, {
					preserveHistory: true,
					stickyHistory: true,
				});
				runtime.tab.status = "idle";
				this.addLocalizedMessage(
					agentId,
					"system",
					"diagnostic.compactDone",
					"会话压缩完成",
				);
				this.emitState();
				void this.appLogger?.info("agent", "Compact: reattach succeeded", {
					agentId,
					totalElapsedMs: Date.now() - startTime,
				});
			} else {
				// 非退出相关的 RPC 错误，正常抛出
				throw error;
			}
		} finally {
			// 手动 compact 通常没有可靠的 agent_settled；无论成功/失败都必须
			// 收口两个 compact 标记，否则 UI 会永久停在 busy，后续发送也会被挡住。
			this.finishManualCompaction(agentId);
		}

		return this.getRuntimeState(agentId);
	}

	/** 手动压缩收口：恢复可发送状态，但不覆盖 error/closed/starting。 */
	private finishManualCompaction(agentId: string) {
		const piCompactionStillRunning = this.manualCompactionEventAgents.has(agentId);
		const followUpStarted = this.manualCompactionFollowUpAgents.has(agentId);
		this.compactingAgents.delete(agentId);
		if (!piCompactionStillRunning) this.rpcCompactingAgents.delete(agentId);
		if (!followUpStarted) this.manualCompactionFollowUpAgents.delete(agentId);
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		const runtimeStillWorking =
			piCompactionStillRunning ||
			followUpStarted ||
			this.streamingAgents.has(agentId) ||
			this.activeAssistantMessageIds.has(agentId) ||
			this.toolExecutingByAgent.get(agentId) != null;
		if (
			!runtimeStillWorking &&
			runtime.tab.status !== "error" &&
			runtime.tab.status !== "closed" &&
			runtime.tab.status !== "starting"
		) {
			runtime.tab.status = "idle";
		}
		this.emitState();
		void this.emitRuntimeState(agentId);
	}

	/**
	 * 进程退出后重新附加到同一会话：创建新的 PiProcess 并替换旧的进程引用。
	 * 在压缩导致 pi 进程自动重启后调用，保持同一 agentId 可继续对话。
	 *
	 * 与 create() 中创建过程的区别：不重新分配 agentId、不解绑项目，
	 * 只替换底层的 pi 进程和 RPC 客户端，保留所有消息和 tab 状态。
	 */
	private async reattachProcess(
		agentId: string,
		sessionPath: string,
		loadOptions?: MessageLoadOptions,
	): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error("Agent not found: " + agentId);

		const project = this.getProject(runtime.tab.projectId);
		if (!project) throw new Error("Project not found");

		void this.appLogger?.info("agent", "Reattaching process", {
			agentId,
			sessionPath,
		});

		const process = this.createPiProcess(project.path, sessionPath, runtime.tab.deckSessionId);
		this.invalidateMessageLoads(agentId);
		// 先登记新 process，再等待 start/get_state；旧 process 的迟到事件会因身份检查
		// 被丢弃，新 process 在启动窗口内产生的有效事件也不会被误判为旧 runtime。
		runtime.process = process;
		// 与 createUnlocked 同理：监听器必须在 start() 前挂上，
		// 避免重连窗口期 spawn error 变成未捕获异常。
		this.attachPiProcessLifecycle(agentId, process, {
			projectPath: project.path,
			onExit: (payload) => this.handleReattachProcessExit(agentId, runtime, payload),
		});
		const client = await process.start(sessionPath);
		const restartDiag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process restarted", {
			agentId,
			command: restartDiag?.command,
			args: restartDiag?.args?.join(' '),
			cwd: restartDiag?.cwd,
		});


		try {
			const stateResponse = await client.request({ type: "get_state" }, this.rpcTimeoutMs);
			const data = stateResponse.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			runtime.tab.sessionPath = this.normalizeSessionPathFromPi(
				data?.sessionFile ?? sessionPath,
				project.path,
				runtime.tab.sessionEnvironment ?? "native",
			);
			runtime.tab.title = data?.sessionName ?? runtime.tab.title;
			runtime.tab.status = "idle";
			// 进程退出型压缩可能来不及发 compaction_end；重连成功即表示 Pi 已可继续接收消息。
			this.rpcCompactingAgents.delete(agentId);

			// 重连成功后清除自动重连标记，允许下一次再触发
			this.autoRestartAttempted.delete(agentId);

			// 如果有旧的 pending abort 标记，清理掉
			this.abortedDuringAsk.delete(agentId);

			// 重连期间用户可能已发送消息（乐观上屏）：必须保护，否则替换投影时未落盘消息丢失
			await this.loadMessages(agentId, false, undefined, loadOptions).catch(() => undefined);

			void this.appLogger?.info("agent", "Process reattached successfully", {
				agentId,
			});
		} catch (error) {
			void this.appLogger?.error("agent", "Process reattach failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * 会话缓存命中率读取器：按 (size, mtimeMs) 缓存文件解析结果，
	 * 会话文件未变化时 O(1) 复用，避免高频 getRuntimeState 反复读文件+逐行 parse。
	 */
	private readonly cacheHitStatsReader: CacheHitStatsReader = createCacheHitStatsReader({
		readFile: (path) => readFile(path, "utf8"),
		stat,
	});

	/**
	 * 读取 session 文件，统计缓存命中率：最后一条 assistant 消息（latest）与
	 * 全部 assistant 消息的平均值（average，即「当前会话平均缓存率」）。
	 * 口径与 pi CLI footer 的 latestCacheHitRate 一致：
	 * cacheRead / (input + cacheRead + cacheWrite) * 100
	 */
	private getSessionCacheHitStats(sessionPath: string): Promise<CacheHitStats> {
		return this.cacheHitStatsReader(this.toSessionHostPath(sessionPath));
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		// 文件统计（读会话 + 逐行 parse）与两个 RPC 并行：总耗时 = max(RPC, 文件)，
		// 且文件结果带 (size, mtimeMs) 缓存，会话未变化时零 IO 零 parse
		const [stateResponse, statsResponse, fileHitStats] = await Promise.all([
			runtime.process.client
				.request({ type: "get_state" }, this.rpcTimeoutMs)
				.catch(() => ({ data: undefined })),
			runtime.process.client
				.request({ type: "get_session_stats" })
				.catch(() => ({ data: undefined })),
			runtime.tab.sessionPath
				? this.getSessionCacheHitStats(runtime.tab.sessionPath)
				: Promise.resolve({ latest: undefined as number | undefined, average: undefined as number | undefined, sampleCount: 0 }),
		]);
		const state = stateResponse.data as any;
		const stats = statsResponse.data as any;
		const model = state?.model;
		const tokens = stats?.tokens;
		const inputTokens = pickNumber(
			tokens?.input,
			tokens?.inputTokens,
			tokens?.prompt,
			tokens?.promptTokens,
			stats?.inputTokens,
			stats?.usage?.input,
		);
		const outputTokens = pickNumber(
			tokens?.output,
			tokens?.outputTokens,
			tokens?.completion,
			tokens?.completionTokens,
			stats?.outputTokens,
			stats?.usage?.output,
		);
		const cacheRead = pickNumber(
			tokens?.cacheRead,
			tokens?.cache?.read,
			stats?.cacheRead,
			stats?.usage?.cacheRead,
		);
		const cacheWrite = pickNumber(
			tokens?.cacheWrite,
			tokens?.cache?.write,
			stats?.cacheWrite,
			stats?.usage?.cacheWrite,
		);
		const directCacheHitPercent = pickNumber(
			tokens?.cacheHitPercent,
			tokens?.cacheHitRate != null ? tokens.cacheHitRate * 100 : undefined,
			stats?.cacheHitPercent,
			stats?.cacheHitRate != null ? stats.cacheHitRate * 100 : undefined,
		);
	/**
	 * 使用最新一条 assistant 消息的缓存命中率，与 pi CLI footer 保持一致。
	 * pi 的 get_session_stats RPC 不直接返回 cacheHitPercent，需读取 session 文件。
	 * 同时统计全部 assistant 消息的平均命中率（当前会话平均缓存率）。
	 */
	const cacheHitPercent = clampPercent(
		directCacheHitPercent ?? fileHitStats.latest,
	);
	const cacheHitAveragePercent = clampPercent(fileHitStats.average);
	const perf = this.lastPerfByAgent.get(agentId);
	return {
		modelName: model?.name ?? model?.id,
		provider: model?.provider,
		modelId: model?.id,
		thinkingLevel: state?.thinkingLevel,
		isStreaming: state?.isStreaming || this.streamingAgents.has(agentId),
		isCompacting:
			state?.isCompacting ||
			this.rpcCompactingAgents.has(agentId) ||
			this.compactingAgents.has(agentId),
		/** 工具执行状态从本地追踪，无需 Pi 进程查询 */
		isExecutingTool: !!(this.toolExecutingByAgent.get(agentId)),
		executingToolName: this.toolExecutingByAgent.get(agentId) ?? undefined,
		toolStateSequence: this.toolStateSequenceByAgent.get(agentId) ?? 0,
		contextTokens: stats?.contextUsage?.tokens,
		contextWindow: stats?.contextUsage?.contextWindow ?? model?.contextWindow,
		contextPercent: stats?.contextUsage?.percent,
		inputTokens,
		outputTokens,
		cacheRead,
		cacheWrite,
		cacheTotal:
			cacheRead != null || cacheWrite != null
				? (cacheRead ?? 0) + (cacheWrite ?? 0)
				: undefined,
		cacheHitPercent,
		cacheHitAveragePercent,
		cacheHitSampleCount: fileHitStats.sampleCount,
		cost: stats?.cost,
		// 最近一次回复性能指标：本地结算缓存（不经 RPC），会话切换/轮询时保持可用
		ttftMs: perf?.ttftMs,
		totalMs: perf?.totalMs,
		tps: perf?.tps,
		perfAt: perf?.at,
	};
	}

	private applyActiveToolCallState(agentId: string, state: ActiveToolCallState) {
		if (state.calls.size > 0) {
			this.activeToolCallsByAgent.set(agentId, state.calls);
			this.toolExecutingByAgent.set(agentId, state.executingToolName ?? "tool");
			this.emitToolRuntimeTransition(
				agentId,
				true,
				state.executingToolName ?? "tool",
			);
			return;
		}
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.set(agentId, null);
		this.emitToolRuntimeTransition(agentId, false);
	}

	private emitToolRuntimeTransition(
		agentId: string,
		isExecutingTool: boolean,
		executingToolName?: string,
	) {
		const toolStateSequence = (this.toolStateSequenceByAgent.get(agentId) ?? 0) + 1;
		this.toolStateSequenceByAgent.set(agentId, toolStateSequence);
		// 工具边沿直接从原始 pi 事件发出，不等待 get_state/get_session_stats。
		// 这样即使工具极快完成或完整状态请求乱序，renderer 仍能稳定看到 true → false。
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: {
				isExecutingTool,
				executingToolName,
				toolStateSequence,
			},
		});
	}

	private async emitRuntimeState(agentId: string) {
		try {
			const state = await this.getRuntimeState(agentId);
			const latestToolSequence = this.toolStateSequenceByAgent.get(agentId) ?? 0;
			// getRuntimeState 包含异步 RPC；若期间发生新工具事件，只覆盖非工具字段，
			// 工具字段保留调用完成时的最新本地真值和序号。
			state.isExecutingTool = !!this.toolExecutingByAgent.get(agentId);
			state.executingToolName = this.toolExecutingByAgent.get(agentId) ?? undefined;
			state.toolStateSequence = latestToolSequence;
			this.emit(ipcChannels.agentsRuntimeState, { agentId, state });
		} catch {
			// 运行态刷新失败不影响主流程；下一次轮询或事件会继续同步。
		}
	}

	/**
	 * 主动推送一次完整 runtime state（get_state + 最新工具状态补丁）给渲染层。
	 *
	 * 懒启动/重启链路的 applyPreferences（setModel/setThinking）之后调用：
	 * setModel 内部只 emitState（AgentTab 无 state 字段），若不额外推送，
	 * 渲染层底栏会停留在旧绑定残留的 state 或仅 record 回退，看不到应用后的真实模型。
	 */
	async publishRuntimeState(agentId: string): Promise<void> {
		await this.emitRuntimeState(agentId);
	}

	async cycleModel(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request({ type: "cycle_model" }, 60_000);
		return this.getRuntimeState(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "get_available_models" },
			60_000,
		);
		return parseAvailableModelsResponse(response);
	}

	async setModel(agentId: string, provider: string, modelId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "set_model", provider, modelId },
			60_000,
		);
		if (!response.success) {
			// pi 对 set_model 用启动时加载的模型快照校验；模型不在快照中返回
			// "Model not found: provider/model"。若本地 models.json 确实有该模型，
			// 说明是运行中 Agent 未加载新配置——抛带 needsRestart 标记的错误，
			// 渲染层据此引导用户重启 Agent（新进程会重新加载 models.json）。
			const errorText = response.error ?? "";
			if (/model not found/i.test(errorText)) {
				const localHasModel = await this.localModelsContains(provider, modelId);
				if (localHasModel) {
					const err = new Error(errorText) as Error & { needsRestart?: boolean };
					err.needsRestart = true;
					throw err;
				}
			}
			throw new Error(errorText || "set_model failed");
		}
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	/** 本地 models.json 是否包含指定 provider/modelId。 */
	private async localModelsContains(provider: string, modelId: string): Promise<boolean> {
		try {
			const result = await this.configManager.getModelsConfig();
			const config = result.parsed;
			return Boolean(
				config?.providers?.[provider]?.models?.some((model) => model.id === modelId),
			);
		} catch {
			return false;
		}
	}

	/**
	 * 刷新模型配置：让运行中的 agent 重新加载 models.json，无需完全重启。
	 *
	 * 当前仅支持轻量级 reload_config RPC（策略 1）。
	 * 策略 2（进程重启）已注释，等待 pi 官方支持 reload_config RPC 后再考虑：
	 *   - 运行中的 Agent 重启进程会打断正在进行的对话/工具执行
	 *   - 进程重启涉及 exit 事件竞态、模型恢复等复杂边界条件
	 *
	 * RPC 提案：https://github.com/earendil-works/pi/issues/6890
	 * pi 合并 reload_config 后，本方法将自动生效，无需任何修改。
	 */
	async refreshModels(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Model refresh requested", { agentId });

		// 策略 1：尝试 reload_config RPC（轻量级，无需重启进程）
		// 该命令在 pi model-runtime 中已实现为 reloadConfig()，会重新读取 models.json
		// 并重建所有 provider。当前 pi 0.80.10 的 RPC 协议尚未暴露此命令，
		// 待 pi 合并 https://github.com/earendil-works/pi/issues/6890 后自动生效。
		try {
			const response = await runtime.process.client.request(
				{ type: "reload_config" },
				8_000,
			);
			if (response.success) {
				await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
				void this.appLogger?.info("agent", "Model refresh succeeded via reload_config RPC", {
					agentId,
					elapsedMs: Date.now() - startTime,
				});
				this.emitState();
				return this.getRuntimeState(agentId);
			}
		} catch {
			// reload_config 尚不支持，当前 pi 版本无轻量级刷新路径
		}

		// 策略 2（已注释）：进程重启方案。
		// 原因：运行中重启会打断用户对话、工具执行，且涉及 exit 事件竞态。
		// 等 pi 官方支持 reload_config RPC 后，策略 1 自动生效，无需回退到策略 2。
		//
		// const sessionPath = runtime.tab.sessionPath;
		// if (!sessionPath) {
		// 	throw new Error("Cannot refresh models: agent has no session path");
		// }
		// this.modelRefreshingAgents.add(agentId);
		// try {
		// 	const previousState = await this.getRuntimeState(agentId).catch(() => null);
		// 	runtime.process.stop();
		// 	await new Promise<void>((resolve) => setTimeout(resolve, 600));
		// 	await this.reattachProcess(agentId, sessionPath);
		// 	if (previousState?.provider && previousState?.modelId) {
		// 		try { await this.setModel(agentId, previousState.provider, previousState.modelId); } catch {}
		// 	}
		// 	runtime.tab.status = "idle";
		// 	await this.loadMessages(agentId).catch(() => undefined);
		// } finally {
		// 	this.modelRefreshingAgents.delete(agentId);
		// }

		void this.appLogger?.info("agent", "Model refresh: reload_config not supported by current pi version, skipping", {
			agentId,
			elapsedMs: Date.now() - startTime,
		});
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	async cycleThinking(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "cycle_thinking_level" },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	async setThinking(agentId: string, level: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "set_thinking_level", level },
			60_000,
		);
		if (!response.success) {
			throw new Error(response.error ?? `Failed to set thinking level: ${level}`);
		}
		this.emitState();
		return this.getRuntimeState(agentId);
	}

	/** Build one physical/logical file reference for the isolated JSONL transaction. */
	private createSessionFileRef(runtime: AgentRuntime, sessionPath: string): SessionFileRef {
		const environment = runtime.tab.sessionEnvironment ??
			(this.wslEnvironment ? "wsl" : "native");
		return {
			protocolPath: this.toSessionProtocolPath(sessionPath),
			hostPath: this.toSessionHostPath(sessionPath),
			environment,
			wslDistro: runtime.tab.wslDistro ?? (
				environment === "wsl" ? this.wslEnvironment?.distro : undefined
			),
		};
	}

	/**
	 * 统一解析活动分支的 entryId 序列：
	 * 优先通过 RPC get_entries 获取；若 RPC 不支持（如 pi_agent_rust 明确返回 unknown command）
	 * 或请求失败，则回退从会话 JSONL 读取 canonical entryId。
	 */
	private async resolveActiveEntryIds(
		agentId: string,
		runtime: AgentRuntime,
	): Promise<string[] | undefined> {
		const source = this.entrySourceByAgent.get(agentId);
		if (source !== "file") {
			try {
				const response = await runtime.process.client.request(
					{ type: "get_entries" },
					15_000,
				);
				if (response.success) {
					this.entrySourceByAgent.set(agentId, "rpc");
					const entriesData = response.data as
						| { entries?: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>; leafId?: string }
						| undefined;
					if (entriesData?.entries && entriesData?.leafId) {
						return this.buildActiveBranchEntryIds(entriesData.entries, entriesData.leafId);
					}
				} else if (response.error && isUnsupportedCommandError(response.error)) {
					this.entrySourceByAgent.set(agentId, "file");
				}
			} catch (error) {
				const msg = errorMessage(error);
				if (isUnsupportedCommandError(msg)) {
					this.entrySourceByAgent.set(agentId, "file");
				} else {
					void this.appLogger?.warn("agent", "Failed to get_entries via RPC, falling back to session file", {
						agentId,
						error: msg,
					});
				}
			}
		}

		if (runtime.tab.sessionPath) {
			try {
				const identity = await this.sessionHistoryReader.readActiveEntryIdentity(runtime.tab.sessionPath);
				return identity.entryIds;
			} catch (error) {
				void this.appLogger?.warn("agent", "Failed to read entry identity from session file", {
					agentId,
					sessionPath: runtime.tab.sessionPath,
					error: errorMessage(error),
				});
			}
		}
		return undefined;
	}

	/**
	 * A current Pi leaf constrains every locator, including explicit entry IDs.
	 * If the RPC is unavailable, SessionFileEditor falls back to the last valid leaf.
	 */
	private async getActiveSessionLeafId(
		agentId: string,
		runtime: AgentRuntime,
	): Promise<string | undefined> {
		const source = this.entrySourceByAgent.get(agentId);
		if (source !== "file") {
			try {
				const response = await runtime.process.client.request(
					{ type: "get_entries" },
					15_000,
				);
				if (response.success) {
					this.entrySourceByAgent.set(agentId, "rpc");
					const leafId = (response.data as { leafId?: unknown } | undefined)?.leafId;
					if (typeof leafId === "string" && leafId) return leafId;
				} else if (response.error && isUnsupportedCommandError(response.error)) {
					this.entrySourceByAgent.set(agentId, "file");
				}
			} catch (error) {
				const msg = errorMessage(error);
				if (isUnsupportedCommandError(msg)) {
					this.entrySourceByAgent.set(agentId, "file");
				} else {
					void this.appLogger?.warn("agent", "Session entry leaf lookup failed", {
						agentId,
						error: msg,
					});
				}
			}
		}

		if (runtime.tab.sessionPath) {
			try {
				const identity = await this.sessionHistoryReader.readActiveEntryIdentity(runtime.tab.sessionPath);
				if (identity.leafId) return identity.leafId;
			} catch (error) {
				void this.appLogger?.warn("agent", "Session JSONL leaf lookup failed", {
					agentId,
					error: errorMessage(error),
				});
			}
		}
		return undefined;
	}

	private createSessionEntryTarget(
		message: ChatMessage,
		activeLeafId?: string,
	): SessionEntryTarget {
		if (message.role !== "user" && message.role !== "assistant") {
			throw new Error("SESSION_ENTRY_ROLE_INVALID");
		}
		const entryId = typeof message.meta?.entryId === "string"
			? message.meta.entryId
			: undefined;
		return {
			entryId,
			legacyMessageId: message.id,
			legacyAgentId: message.agentId,
			role: message.role,
			text: message.text,
			activeLeafId,
		};
	}

	private async requestSessionReload(
		runtime: AgentRuntime,
		file: SessionFileRef,
	): Promise<void> {
		const response = await runtime.process.client.request({
			type: "switch_session",
			sessionPath: file.protocolPath,
		}, 30_000);
		if (!response.success) {
			throw new Error(response.error ?? "switch_session failed");
		}
	}

	/**
	 * File mutations are only valid while Pi is idle. The editor owns file-level
	 * serialization; this check protects the runtime protocol boundary.
	 */
	private async ensureAgentIdle(agentId: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		if (runtime.tab.status === "running") {
			try {
				const state = await this.getRuntimeState(agentId);
				if (state.isStreaming || state.isCompacting) {
					throw new Error("BUSY_STREAMING: Agent is streaming, please wait");
				}
				if (state.isExecutingTool) {
					throw new Error("BUSY_TOOL: Agent is executing a tool, please wait");
				}
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("BUSY_")) {
					throw error;
				}
				throw new Error("BUSY_GENERIC: Agent is currently busy, please try again later");
			}
		}
	}

	/**
	 * 编辑/删除/重发定位消息条目：优先运行时缓存（最近 12 轮窗口，O(1)），
	 * 缓存未命中时按 messageId 从文件索引定位 —— 使这些操作不再依赖缓存轮数
	 * （此前 40 轮缓存的一部分意义是保证操作按钮可用，12 轮窗口外也能操作）。
	 * 文件定位返回 entryId 精确锚点（SessionFileEditor.locateEntry 优先 entryId 匹配）。
	 */
	private async locateMessageTarget(
		agentId: string,
		sessionPath: string,
		messageId: string,
		activeLeafId?: string,
	): Promise<{ target: SessionEntryTarget; resend?: { text: string; images?: ImageContent[] } }> {
		const currentMessages = !this.staleMessageCacheAgents.has(agentId)
			? this.messages.get(agentId)
			: undefined;
		const cachedMessage = currentMessages?.find((candidate) => candidate.id === messageId);

		// 1. message.meta.entryId: 缓存中已有有效 entryId，直接走 fast path
		if (cachedMessage && typeof cachedMessage.meta?.entryId === "string" && cachedMessage.meta.entryId) {
			return {
				target: this.createSessionEntryTarget(cachedMessage, activeLeafId),
				resend: {
					text: cachedMessage.text,
					...(cachedMessage.images?.length ? { images: cachedMessage.images } : {}),
				},
			};
		}

		// 2. synthetic history entryId (${agentId}-history-${entryId})
		// 3. JSONL 中原始 message.id (或 entry.id)
		const located = await this.sessionHistoryReader.readMessageByMessageId(sessionPath, messageId);
		if (located) {
			void this.appLogger?.info("agent", "Message located from session file by ID", {
				agentId,
				messageId,
				entryId: located.entryId,
			});
			const role: "user" | "assistant" = located.role === "user" ? "user" : "assistant";
			if (cachedMessage) {
				cachedMessage.meta = { ...cachedMessage.meta, entryId: located.entryId };
			}
			return {
				target: {
					entryId: located.entryId,
					legacyMessageId: messageId,
					legacyAgentId: agentId,
					role,
					text: located.text,
					activeLeafId,
				},
				resend: {
					text: located.text,
					...(located.images?.length ? { images: located.images } : {}),
				},
			};
		}

		// 4. active message sequence 映射得到的 entryId（针对实时消息 UUID 或无 entryId 缓存）
		if (cachedMessage && (cachedMessage.role === "user" || cachedMessage.role === "assistant")) {
			try {
				const identity = await this.sessionHistoryReader.readActiveEntryIdentity(sessionPath);
				const activeUserAssistantEntries = identity.activeMessageEntries.filter(
					(entry) => entry.role === "user" || entry.role === "assistant",
				);
				const cachedUserAssistantMessages = (currentMessages ?? []).filter(
					(m) => m.role === "user" || m.role === "assistant",
				);
				const cachedIndex = cachedUserAssistantMessages.findIndex((m) => m.id === messageId);
				if (cachedIndex >= 0) {
					const offsetFromTail = cachedUserAssistantMessages.length - 1 - cachedIndex;
					const targetEntryIndex = activeUserAssistantEntries.length - 1 - offsetFromTail;
					if (targetEntryIndex >= 0 && targetEntryIndex < activeUserAssistantEntries.length) {
						const candidate = activeUserAssistantEntries[targetEntryIndex];
						if (candidate.role === cachedMessage.role) {
							void this.appLogger?.info("agent", "Message located by active sequence mapping", {
								agentId,
								messageId,
								entryId: candidate.id,
							});
							cachedMessage.meta = { ...cachedMessage.meta, entryId: candidate.id };
							return {
								target: {
									entryId: candidate.id,
									legacyMessageId: messageId,
									legacyAgentId: agentId,
									role: cachedMessage.role,
									text: cachedMessage.text,
									activeLeafId,
								},
								resend: {
									text: cachedMessage.text,
									...(cachedMessage.images?.length ? { images: cachedMessage.images } : {}),
								},
							};
						}
					}
				}
			} catch (err) {
				void this.appLogger?.warn("agent", "Sequence mapping lookup failed", {
					agentId,
					messageId,
					error: errorMessage(err),
				});
			}

			// 5. role + exact text，仅最后兼容兜底
			return {
				target: {
					entryId: undefined,
					legacyMessageId: messageId,
					legacyAgentId: agentId,
					role: cachedMessage.role,
					text: cachedMessage.text,
					activeLeafId,
				},
				resend: {
					text: cachedMessage.text,
					...(cachedMessage.images?.length ? { images: cachedMessage.images } : {}),
				},
			};
		}

		throw new Error("Message not found");
	}

	async editMessage(agentId: string, messageId: string, newText: string) {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		await this.sessionFileEditor.editMessage({
			file,
			target,
			newText,
			reload: () => this.requestSessionReload(runtime, file),
		});
		try {
			await this.loadMessages(
				agentId,
				false,
				undefined,
				{ preserveHistory: false },
			);
		} catch (error) {
			this.invalidateMessageLoads(agentId);
			this.staleMessageCacheAgents.add(agentId);
			void this.appLogger?.warn(
				"agent",
				"Edit committed but message refresh failed",
				{
					agentId,
					messageId,
					error: errorMessage(error),
				},
			);
		}
		void this.appLogger?.info("agent", "Edit message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	async deleteMessage(agentId: string, messageId: string) {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		await this.sessionFileEditor.deleteMessage({
			file,
			target,
			reload: () => this.requestSessionReload(runtime, file),
		});
		try {
			await this.loadMessages(
				agentId,
				false,
				undefined,
				{ preserveHistory: false },
			);
		} catch (error) {
			this.invalidateMessageLoads(agentId);
			this.staleMessageCacheAgents.add(agentId);
			void this.appLogger?.warn(
				"agent",
				"Delete committed but message refresh failed",
				{
					agentId,
					messageId,
					error: errorMessage(error),
				},
			);
		}
		void this.appLogger?.info("agent", "Delete message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	async prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }> {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");
		// 缓存命中且未 stale 时先校验角色（重发仅限用户消息）；缓存未命中或 stale 时由 SessionFileEditor 的 inputRole 校验兜底
		const cached = !this.staleMessageCacheAgents.has(agentId)
			? this.messages.get(agentId)?.find((candidate) => candidate.id === messageId)
			: undefined;
		if (cached && cached.role !== "user") throw new Error("Only user messages can be resent");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target, resend } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		await this.sessionFileEditor.truncateForResend({
			file,
			target,
			reload: () => this.requestSessionReload(runtime, file),
		});
		try {
			await this.loadMessages(
				agentId,
				false,
				undefined,
				{ preserveHistory: false },
			);
		} catch (error) {
			this.invalidateMessageLoads(agentId);
			this.staleMessageCacheAgents.add(agentId);
			void this.appLogger?.warn(
				"agent",
				"Prepare resend committed but message refresh failed",
				{
					agentId,
					messageId,
					error: errorMessage(error),
				},
			);
		}
		void this.appLogger?.info("agent", "Prepare resend completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
		return resend ?? {
			text: cached?.text ?? "",
			...(cached?.images?.length ? { images: cached.images } : {}),
		};
	}

	async reload(agentId: string) {
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");
		const file = this.createSessionFileRef(runtime, sessionPath);
		await this.sessionFileEditor.reload({
			file,
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId, false, undefined, { preserveHistory: false });
	}

	/**
	 * 重启 agent 进程：停止当前 pi RPC 子进程，用同一个 session 重新启动。
	 * 适用场景：修改了 provider 配置、切换了 API key、更新了 pi 版本后，
	 * /reload 只重载 extension，不会重新读取配置文件，restart 才能生效。
	 */
	/**
	 * 统一清理某 agent 的全部运行态键（2026-10 泄漏修复）。
	 *
	 * agentId 每次 spawn 都是 randomUUID，而各状态 Map/Set 若只在事件驱动路径清理，
	 * 用户高频 stop/restart/崩溃退出时键会永久残留（慢泄漏）。
	 * 在 agent 生命周期终止点（stop/restart/最终 closed/stopAll）统一调用。
	 *
	 * 不清的键（各自语义）：agents/messages（调用方处理）、userInitiatedStop
	 * （stop 后由退出处理器消费删除）、modelRefreshingAgents（refresh 流程跨 stop 存活）、
	 * pendingTrustRequests（启动流程 await 中，删键会挂死 create）、
	 * compactingAgents（compact 的 catch 靠它决定重连）。
	 */
	private clearAgentState(agentId: string) {
		// 关闭路径必须清掉所有按 agent 索引的运行态；agentId 每次 spawn 都不同，
		// 遗留 key 不会串到新进程，但会在反复崩溃/重启时形成慢泄漏。
		this.streamingThinking.delete(agentId);
		this.thinkingSegmentByAgent.delete(agentId);
		this.setStreamingAgent(agentId, false);
		this.activeAssistantMessageIds.delete(agentId);
		this.toolMessageIds.delete(agentId);
		this.retryStatusMessageIds.delete(agentId);
		this.streamingText.delete(agentId);
		this.lastSentTextByAgent.delete(agentId);
		this.textPushCountByAgent.delete(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
		this.rpcCompactingAgents.delete(agentId);
		this.rustRuntimeAgents.delete(agentId);
		this.autoRestartAttempted.delete(agentId);
		this.messagePerfByAgent.delete(agentId);
		this.lastPerfByAgent.delete(agentId);
		this.notifiedAskAgents.delete(agentId);
		this.abortedDuringAsk.delete(agentId);
		this.pendingUIRequests.delete(agentId);
		this.clearStreamGate(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.messageDirtyFromByAgent.delete(agentId);
		this.displayWindowStartByAgent.delete(agentId);
		this.messageHeadOffsetByAgent.delete(agentId);
		this.staleMessageCacheAgents.delete(agentId);
		this.pendingSlideOutByAgent.delete(agentId);
		this.preserveHistoryOnNextFlush.delete(agentId);
		this.stickyHistoryOnNextFlush.delete(agentId);
		this.manualCompactionFollowUpAgents.delete(agentId);
		this.manualCompactionEventAgents.delete(agentId);
		this.sessionFileVersionByAgent.delete(agentId);
		// 删除序号会让所有旧 load 在 await 返回时失效，同时避免关闭 agent 后留 key。
		this.messageLoadSequenceByAgent.delete(agentId);
		this.consumeManualCompactionReloadClaim(agentId);
		this.promptRequestedAtByAgent.delete(agentId);
		this.entrySourceByAgent.delete(agentId);
		this.rpcLoggingAgents.delete(agentId);
		this.dropPendingLiveRpcLogs(agentId);
		// 工具完整结果缓存是运行期性能优化（回退读文件等价），只释放当前 agent。
		this.toolFullTextByAgent.delete(agentId);
	}

	/** 使所有尚未完成的历史读取失效，避免旧 runtime 的快照回写新状态。 */
	private invalidateMessageLoads(agentId: string) {
		this.messageLoadSequenceByAgent.set(
			agentId,
			(this.messageLoadSequenceByAgent.get(agentId) ?? 0) + 1,
		);
	}

	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
		void this.appLogger?.info("agent", "Agent restart requested", {
			agentId,
			projectId: runtime.tab.projectId,
			sessionPath: runtime.tab.sessionPath,
		});
		const {
			projectId,
			title,
			sessionEnvironment: environment,
			sessionSource: source,
			wslDistro,
			wslUser,
			importedSourceId,
			noSession,
		} = runtime.tab;

		// 优先从 pi 获取最新 sessionFile，兜底用 tab 上缓存的值；
		// 避免首次创建时未指定 session 路径、restart 后丢失历史的情况。
		let sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) {
			try {
				const state = await runtime.process.client.request({
					type: "get_state",
				}, this.rpcTimeoutMs);
				sessionPath = this.normalizeSessionPathFromPi(
					(state.data as { sessionFile?: string } | undefined)?.sessionFile ??
						undefined,
					this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd,
					environment ?? "native",
				);
			} catch {
				// 获取失败时继续用 undefined，create 会启动新 session
			}
		}

		// 停止旧进程并清理状态
		runtime.process.stop();
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.messageDirtyFromByAgent.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		this.pendingSlideOutByAgent.delete(agentId);
		this.clearAgentState(agentId);
		this.emitState();

		// 用相同的 session 重新创建 agent，新进程会重新加载所有配置
		return this.create({
			projectId,
			sessionPath: noSession ? undefined : sessionPath,
			title,
			environment,
			source,
			wslDistro,
			wslUser,
			importedSourceId,
			noSession,
			// 重启只换 pi 进程，不改会话文件。新进程只会投影尾部窗口，
			// 必须保留 renderer 已经展示的前缀，否则多次停止/重启会把中间历史“吃掉”。
			preserveHistoryOnLoad: true,
		});
	}

	async exportHtml(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "export_html" },
			120_000,
		);
		return response.data;
	}

	/**
	 * 对未打开的历史会话执行官方 RPC 导出。
	 * 使用临时 pi 进程可以复用官方 export_html 样式，同时不切换当前桌面 Agent。
	 */
	async exportSessionHtml(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request(
				{ type: "export_html" },
				120_000,
			);
			return response.data;
		});
	}

	/**
	 * 对未打开的历史会话执行官方 clone。
	 * clone 会复制 active branch 到新 session；随后读取 get_state 拿到新 sessionFile 供历史列表刷新。
	 */
	async cloneSessionFile(
		projectId: string,
		sessionPath: string,
		environment: SessionEnvironment = "native",
	) {
		const project = this.getProject(projectId);
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request({ type: "clone" }, 120_000);
			const state = await process.client.request({ type: "get_state" }, this.rpcTimeoutMs);
			return {
				...((response.data as object | undefined) ?? {}),
				sessionPath: this.normalizeSessionPathFromPi(
					(state.data as { sessionFile?: string } | undefined)?.sessionFile,
					project?.path ?? "",
					environment,
				),
			};
		});
	}

	private async withTemporarySession<T>(
		projectId: string,
		sessionPath: string,
		run: (process: PiProcess) => Promise<T>,
	): Promise<T> {
		const project = this.getProject(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const process = this.createPiProcess(project.path, sessionPath);
		await process.start(sessionPath);
		try {
			return await run(process);
		} finally {
			process.stop();
		}
	}

	async getForkMessages(agentId: string): Promise<ForkMessage[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_fork_messages",
		});
		return (
			(response.data as { messages?: ForkMessage[] } | undefined)?.messages ?? []
		);
	}

	async forkSession(agentId: string, entryId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "fork", entryId },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async cloneSession(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "clone" }, 120_000);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async switchSession(agentId: string, sessionPath: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "switch_session", sessionPath: this.toSessionProtocolPath(sessionPath) },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	private async refreshRuntimeAfterSessionReplacement(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const stateResponse = await runtime.process.client
			.request({ type: "get_state" }, this.rpcTimeoutMs)
			.catch(() => ({ data: undefined }));
		const state = stateResponse.data as { sessionFile?: string; sessionName?: string } | undefined;
		if (state?.sessionFile) {
			runtime.tab.sessionPath = this.normalizeSessionPathFromPi(
				state.sessionFile,
				this.getProject(runtime.tab.projectId)?.path ?? runtime.tab.cwd,
				runtime.tab.sessionEnvironment ?? "native",
			) ?? runtime.tab.sessionPath;
		}
		if (state?.sessionName) runtime.tab.title = state.sessionName;
		// 重新附加后恢复：保留附加期间用户发送/流式中的消息，避免投影替换吞掉乐观消息
		await this.loadMessages(agentId, false, undefined, {
			preserveHistory: false,
			preserveMessagesAfter: Date.now(),
		}).catch(() => undefined);
		this.emitState();
	}

	async getCommands(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_commands",
		});
		return (
			(response.data as { commands?: unknown[] } | undefined)?.commands ?? []
		);
	}

	private async promptMatchesRegisteredExtensionCommand(runtime: AgentRuntime, message: string): Promise<boolean> {
		const trimmed = message.trim();
		if (!trimmed.startsWith("/")) return false;

		const commandName = trimmed.slice(1).split(/\s+/, 1)[0];
		if (!commandName) return false;

		const response = await runtime.process.client
			.request({ type: "get_commands" }, 10_000)
			.catch(() => undefined);
		const commands = (response?.data as { commands?: unknown[] } | undefined)?.commands ?? [];
		return commands.some((command) => {
			if (!command || typeof command !== "object") return false;
			const typed = command as { name?: unknown; source?: unknown };
			return typed.name === commandName && typed.source === "extension";
		});
	}

	/**
	 * 聚合待广播的实时日志条目，节流刷出（见 LIVE_RPC_LOG_FLUSH_MS）。
	 * 批量推送既能降低 IPC 次数，也让渲染层一次 state 更新收到多条，减少重渲染频率。
	 */
	private enqueueLiveRpcLog(entry: RpcLogEntry) {
		let pending = this.pendingLiveRpcLogs.get(entry.agentId);
		if (!pending) {
			pending = [];
			this.pendingLiveRpcLogs.set(entry.agentId, pending);
		}
		if (pending.length >= AgentManager.LIVE_RPC_LOG_MAX_PENDING) {
			// 极端高频下丢弃最旧，保证聚合缓冲有界
			pending.splice(0, pending.length - AgentManager.LIVE_RPC_LOG_MAX_PENDING + 1);
		}
		pending.push(entry);
		if (this.liveRpcLogFlushTimer === null) {
			this.liveRpcLogFlushTimer = setTimeout(() => {
				this.liveRpcLogFlushTimer = null;
				this.flushLiveRpcLogs();
			}, AgentManager.LIVE_RPC_LOG_FLUSH_MS);
		}
	}

	/** 把聚合缓冲按 agent 拆分后批量广播；单次批次超限的条目留到下一轮，不丢日志 */
	private flushLiveRpcLogs() {
		if (this.pendingLiveRpcLogs.size === 0) return;
		for (const [agentId, entries] of [...this.pendingLiveRpcLogs]) {
			const batch = entries.slice(0, AgentManager.LIVE_RPC_LOG_MAX_BATCH);
			if (batch.length > 0) {
				this.emit(ipcChannels.agentsRpcLog, { agentId, entries: batch } satisfies RpcLogBatch);
			}
			const rest = entries.slice(AgentManager.LIVE_RPC_LOG_MAX_BATCH);
			if (rest.length > 0) {
				this.pendingLiveRpcLogs.set(agentId, rest);
			} else {
				this.pendingLiveRpcLogs.delete(agentId);
			}
		}
	}

	/** 清空某 agent 的实时日志聚合缓冲（agent 关闭时调用，防止残留数据泄漏） */
	private dropPendingLiveRpcLogs(agentId: string) {
		this.pendingLiveRpcLogs.delete(agentId);
	}

	/** 设置某 agent 的 RPC 日志记录开关 */
	setRpcLogging(agentId: string, enabled: boolean) {
		if (enabled) {
			this.rpcLoggingAgents.add(agentId);
		} else {
			this.rpcLoggingAgents.delete(agentId);
		}
	}

	/** 查询某 agent 是否开启了 RPC 日志记录 */
	isRpcLogging(agentId: string): boolean {
		return this.rpcLoggingAgents.has(agentId);
	}

	async stop(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		void this.appLogger?.info("agent", "Agent stopped (user initiated)", {
			agentId,
			projectId: runtime.tab.projectId,
			sessionPath: runtime.tab.sessionPath,
		});
		// 标记用户主动停止，退出处理器将跳过自动重连
		this.userInitiatedStop.add(agentId);
		const process = runtime.process;
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.messageDirtyFromByAgent.delete(agentId);
		this.activeToolCallsByAgent.delete(agentId);
		this.toolExecutingByAgent.delete(agentId);
		this.toolStateSequenceByAgent.delete(agentId);
		this.pendingSlideOutByAgent.delete(agentId);
		this.clearStreamGate(agentId);
		// agent 关闭时自动关闭 RPC 日志记录，并丢弃未广播的实时日志缓冲
		this.rpcLoggingAgents.delete(agentId);
		this.dropPendingLiveRpcLogs(agentId);
		this.displayWindowStartByAgent.delete(agentId);
		this.sessionFileVersionByAgent.delete(agentId);
		this.clearAgentState(agentId);
		process.stop();
		this.emitState();
	}

	/** 注册本地事件监听器（供 Web SSE 等主进程内部模块使用） */
	addLocalEventListener(
		listener: (agentId: string, event: unknown, streamGeneration: number) => void,
	): () => void {
		this.localEventListeners.add(listener);
		return () => { this.localEventListeners.delete(listener); };
	}

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	stopAll() {
		// 应用退出时统一清理所有 pi 子进程，避免后台 agent 残留占用模型或文件句柄。
		for (const runtime of this.agents.values()) {
			this.userInitiatedStop.add(runtime.tab.id);
			this.clearAgentState(runtime.tab.id);
			runtime.process.stop();
		}
		this.agents.clear();
		this.messages.clear();
		// 退出时统一清理所有 gate / abort 兜底定时器，避免泄漏到下一次生命周期。
		for (const agentId of [...this.streamGates.keys()]) this.clearStreamGate(agentId);
		this.recentlyAborted.clear();
		// 实时日志广播的节流定时器与聚合缓冲同步清理
		if (this.liveRpcLogFlushTimer !== null) {
			clearTimeout(this.liveRpcLogFlushTimer);
			this.liveRpcLogFlushTimer = null;
		}
		this.pendingLiveRpcLogs.clear();
		this.manualCompactionReloadClaims.clear();
		this.emitState();
	}


	/**
	 * 统一挂接 PiProcess 生命周期监听。
	 * 必须在 start() 之前调用，避免 spawn error 在无 listener 窗口升级成未捕获异常。
	 */
	private attachPiProcessLifecycle(
		agentId: string,
		piProcess: PiProcess,
		options: {
			projectPath?: string;
			onExit: (payload: { code: number | null; signal: string | null }) => void;
		},
	) {
		const isCurrentProcess = () => this.agents.get(agentId)?.process === piProcess;
		piProcess.on("event", (event) => {
			if (!isCurrentProcess()) return;
			try {
				this.handlePiEvent(agentId, event);
			} catch (error) {
				// 单条 pi 事件处理失败不能拖垮主进程；记录后继续接收后续事件。
				void this.appLogger?.error("agent", "handlePiEvent failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					eventType:
						event && typeof event === "object"
							? String((event as { type?: unknown }).type ?? "unknown")
							: typeof event,
				});
			}
		});
		piProcess.on("stderr", (text) => {
			if (!isCurrentProcess()) return;
			this.emit(ipcChannels.agentsLog, { agentId, text });
		});
		piProcess.on("protocol-error", (line) => {
			if (!isCurrentProcess()) return;
			this.emit(ipcChannels.agentsLog, {
				agentId,
				text: `Protocol error: ${line}`,
			});
			void this.appLogger?.error(
				"agent",
				`Protocol error: ${(line as string)?.slice(0, 200)}`,
				{
					agentId,
					project: options.projectPath,
				},
			);
		});
		// 转发 RPC 日志到前端，用于调试面板展示请求/响应/事件
		piProcess.on("rpc-log", (entry: { direction: string; data: unknown }) => {
			if (!isCurrentProcess()) return;
			try {
				const data = entry.data as Record<string, any>;
				let summary: string;
				if (entry.direction === "send") {
					const type = data.type ?? "?";
					if (type === "prompt") {
						const desc = data.description ? ` [${data.description}]` : "";
						summary = `→ prompt${desc}: ${(data.message ?? "").slice(0, 60)}`;
					}
					else if (type === "set_model")
						summary = `→ set_model: ${data.provider}/${data.modelId}`;
					else if (type === "set_thinking_level")
						summary = `→ set_thinking: ${data.level}`;
					else if (type === "bash")
						summary = `→ bash: ${(data.command ?? "").slice(0, 60)}`;
					else summary = `→ ${type}`;
				} else {
					const type = data.type ?? "?";
					if (type === "response")
						summary = `← ${data.command ?? "?"} ${data.success ? "✓" : "✗"}${data.error ? ` ${data.error}` : ""}`;
					else if (type === "message_update") {
						const evt = data.assistantMessageEvent?.type ?? "?";
						summary = `← message_update.${evt}`;
					} else summary = `← ${type}`;
				}
				const logEntry: RpcLogEntry = {
					id: randomUUID(),
					agentId,
					direction: entry.direction,
					summary,
					data,
					time: Date.now(),
				};
				// 只有用户手动开启 RPC 日志记录的 agent 才产生日志流量（落盘 + 实时广播）。
				// 未开启的 agent 不发射任何事件，避免每一条 RPC 通信都白白过一遍 IPC。
				if (this.rpcLoggingAgents.has(agentId)) {
					this.rpcLogger?.push(logEntry);
					this.enqueueLiveRpcLog(logEntry);
				}
			} catch (error) {
				void this.appLogger?.warn("agent", "rpc-log handler failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		piProcess.on("exit", (payload: { code: number | null; signal: string | null }) => {
			if (!isCurrentProcess()) return;
			try {
				void this.appLogger?.info("agent", "Pi process exit", {
					agentId,
					code: payload.code,
					signal: payload.signal,
					diagnostics: piProcess.getDiagnostics(),
				});
				options.onExit(payload);
			} catch (error) {
				void this.appLogger?.error("agent", "Pi process exit handler failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		piProcess.on("error", (error: Error) => {
			if (!isCurrentProcess()) return;
			const runtime = this.agents.get(agentId);
			if (runtime) runtime.tab.status = "error";
			const message = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Pi process error", {
				agentId,
				error: message,
				stack: error instanceof Error ? error.stack : undefined,
				diagnostics: piProcess.getDiagnostics(),
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			// 启动期 error 多半意味着进程没起来：卡片文案走 i18n，
			// 可复制的诊断详情放 debugDetails（含排查步骤），而不是静默闪退。
			this.addLocalizedMessage(agentId, "error", "diagnostic.runtimeError", "Agent 运行时发生错误。", {
				debugDetails: this.buildStartupFailureMessage(message, piProcess.getDiagnostics()),
			});
			this.emitState();
		});
	}

	/** createUnlocked 路径的进程 exit：支持压缩后自动重连，其余标 closed。 */
	private handleCreateProcessExit(
		agentId: string,
		tab: AgentTab,
		payload: { code: number | null; signal: string | null },
	) {
		// 模型配置刷新期间的进程退出由 refreshModels() 负责重连，此处静默忽略
		if (this.modelRefreshingAgents.has(agentId)) return;
		// 用户主动停止 → 不自动重连
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: user-initiated stop", {
				agentId,
				code: payload.code,
				signal: payload.signal,
			});
			return;
		}
		// 手动压缩期间退出 → compact() 的 catch 块会负责重连
		if (this.compactingAgents.has(agentId)) {
			tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: compaction in progress", {
				agentId,
				code: payload.code,
			});
			return;
		}
		// 自动压缩 / 进程干净退出（exit code 0）且有会话路径 → 尝试一次自动重连
		if (!this.autoRestartAttempted.has(agentId) && tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			tab.status = "starting";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exited cleanly; auto-restarting", {
				agentId,
				code: payload.code,
				sessionPath: tab.sessionPath,
			});
			this.reattachProcess(agentId, tab.sessionPath, {
				preserveHistory: true,
				stickyHistory: true,
			})
				.then(() => {
					tab.status = "idle";
					this.addLocalizedMessage(
						agentId,
						"system",
						"diagnostic.compactReconnected",
						"会话压缩完成，Agent 已自动重连",
					);
					this.emitState();
				})
				.catch(() => {
					tab.status = "closed";
					void this.appLogger?.error("agent", "Agent auto-restart failed", {
						agentId,
						code: payload.code,
						sessionPath: tab.sessionPath,
					});
					this.addLocalizedMessage(
						agentId,
						"error",
						"diagnostic.processReconnectFailed",
						"Agent 进程意外退出，自动重连失败",
					);
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		tab.status = "closed";
		// 非 0 退出且还没写过错误卡时，补一条可排查信息（避免用户只看到 closed）。
		if (payload.code !== 0 && payload.code !== null) {
			const runtime = this.agents.get(agentId);
			const diag = runtime?.process.getDiagnostics() ?? null;
			this.addMessage(
				agentId,
				"error",
				this.buildStartupFailureMessage(
					`pi 进程退出 code=${payload.code}${payload.signal ? ` signal=${payload.signal}` : ""}`,
					diag,
				),
			);
		}
		// 最终停止（无重连路径）：统一清理该 agent 的运行态键，避免慢泄漏
		this.clearAgentState(agentId);
		this.emitState();
	}

	/** reattach 路径的进程 exit：同样做单次自动重连保护。 */
	private handleReattachProcessExit(
		agentId: string,
		runtime: AgentRuntime,
		payload: { code: number | null; signal: string | null },
	) {
		if (this.modelRefreshingAgents.has(agentId)) return;
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			runtime.tab.status = "closed";
			this.emitState();
			return;
		}
		// 自动压缩也可能发生在重连后的进程中；继续复用同一会话文件重附加，
		// 但仍用 autoRestartAttempted 做单次保护，避免真正异常退出时无限重启。
		if (!this.autoRestartAttempted.has(agentId) && runtime.tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			runtime.tab.status = "starting";
			this.emitState();
			this.reattachProcess(agentId, runtime.tab.sessionPath, {
				preserveHistory: true,
				stickyHistory: true,
			})
				.then(() => {
					runtime.tab.status = "idle";
					this.addLocalizedMessage(
						agentId,
						"system",
						"diagnostic.compactReconnected",
						"会话压缩完成，Agent 已自动重连",
					);
					this.emitState();
				})
				.catch(() => {
					runtime.tab.status = "closed";
					this.addLocalizedMessage(
						agentId,
						"error",
						"diagnostic.processReconnectFailed",
						"Agent 进程意外退出，自动重连失败",
					);
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		runtime.tab.status = "closed";
		// 最终停止（无重连路径）：统一清理该 agent 的运行态键
		this.clearAgentState(agentId);
		this.emitState();
	}

	/**
	 * 把 pi 启动/退出失败整理成可复制的诊断文案。
	 * 目标：用户不至于只看到闪退或空白，Issue 也能直接贴日志。
	 */
	private buildStartupFailureMessage(
		rawMessage: string,
		diag: ReturnType<PiProcess["getDiagnostics"]>,
	): string {
		if (!diag) {
			return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\nplatform=${globalThis.process.platform} arch=${globalThis.process.arch}`;
		}
		const lines: string[] = [];
		if (diag.exitCode !== null) {
			lines.push(`退出码: ${diag.exitCode}${diag.exitSignal ? ` (signal: ${diag.exitSignal})` : ""}`);
		}
		const stderrText = diag.stderr.join("").trim();
		if (stderrText) {
			const snippet = stderrText.length > 600 ? "…" + stderrText.slice(-600) : stderrText;
			lines.push(`进程错误输出:\n${snippet}`);
		}
		lines.push(`pi 路径: ${diag.command}`);
		if (diag.customPiPath) lines.push(`自定义路径: ${diag.customPiPath}`);
		lines.push(`工作目录: ${diag.cwd}`);
		lines.push(`版本检测: ${diag.versionCheck ? "✓ 通过" : "✗ 失败"}`);
		lines.push(`运行环境: ${globalThis.process.platform}/${globalThis.process.arch}`);
		if (diag.blockedExtensions && diag.blockedExtensions.length > 0) {
			// 桌面端已自动隔离的扩展（如 codeisland），方便用户对照「为何 RPC 没加载该扩展」。
			lines.push(`已自动隔离扩展: ${diag.blockedExtensions.join(", ")}`);
		}
		lines.push("");
		lines.push("━━━ 排查步骤 ━━━");
		if (!diag.versionCheck) {
			lines.push("1. 在终端执行 pi --version，确认 pi 是否已安装且路径正确");
			lines.push("2. 如未安装，执行 npm install -g @earendil-works/pi-coding-agent");
			lines.push("3. macOS 若从 Dock 启动，可在设置中填写完整 pi 路径（Homebrew 常见 /opt/homebrew/bin/pi）");
		} else if (diag.exitCode !== 0 && diag.exitCode !== null) {
			lines.push("1. 在终端执行 pi --mode rpc 看是否能正常启动");
			lines.push("2. 注意终端中的错误信息（架构不匹配/权限/扩展崩溃都会体现在这里）");
		} else if (!stderrText && diag.exitCode === null) {
			lines.push("1. 桌面端已自动重试 get_state，但 pi 仍未响应。");
			lines.push("2. 在终端执行 pi --mode rpc 看是否能正常启动，注意终端中的错误信息");
		} else {
			lines.push("1. 在终端执行 pi --mode rpc 确认 pi 能否正常启动");
			lines.push("2. 检查设置中的 pi 路径是否正确");
		}
		const startFlags = this.settingsStore.get();
		const noExt = Boolean(startFlags.piRpcNoExtensions);
		const noSkills = Boolean(startFlags.piRpcNoSkills);
		lines.push("");
		lines.push("━━━ 扩展 / 技能排查 ━━━");
		if (noExt || noSkills) {
			lines.push(
				`当前启动已禁用：${[
					noExt ? "扩展 (--no-extensions)" : null,
					noSkills ? "技能 (--no-skills)" : null,
				]
					.filter(Boolean)
					.join("、")}`,
			);
			lines.push("若仍失败，更可能是 pi 本体/路径/会话文件问题，而不是扩展加载。");
		} else {
			lines.push("若怀疑某个扩展或技能导致启动失败：");
			lines.push("1. 打开 设置 → 开发设置");
			lines.push("2. 临时开启「禁用扩展启动」和/或「禁用技能启动」");
			lines.push("3. 保存后重新启动 Agent 验证");
			lines.push("若禁用后能启动，再逐个排查 ~/.pi/agent/extensions 与 skills。");
		}
		lines.push("");
		lines.push("如问题持续，可在 GitHub 提交 Issue 并附上以上信息与应用日志。");
		return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\n${lines.join("\n")}`;
	}

	private handlePiEvent(agentId: string, event: unknown) {
		// 只经下方 gated emit 转给 Web SSE。这里再发一次会让每个 text_delta 被追加两遍。
		if (!event || typeof event !== "object") return;
		const typed = event as Record<string, any>;
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		// Web SSE 必须拿到事件所属的 stream generation。abort 后立刻重发时，
		// 新的 agent_start 仍可能在旧 agent_settled 之前到达；这里给 start 预留
		// 下一代，旧 settled 则保留当前旧代，路由器即可丢弃迟到的结束帧。
		const gate = this.getStreamGate(agentId);
		const eventType = typeof typed.type === "string" ? typed.type : "";
		const eventGeneration = eventType === "agent_start"
			? gate.currentGeneration + 1
			: gate.currentGeneration;
		const shouldEmitLocalEvent =
			eventType === "agent_start" ||
			eventType === "agent_settled" ||
			!isStreamGateSealed(gate);
		if (shouldEmitLocalEvent) this.emitLocalEvent(agentId, event, eventGeneration);

		// 扩展/RPC 调用 setSessionName 后 Pi 会发 session_info_changed；
		// 同步到 tab.title，使侧边栏与手动 rename 路径看到同一标题。
		// 忽略空 name，避免把已有标题抹掉。
		if (typed.type === "session_info_changed" && runtime) {
			const name =
				typeof typed.name === "string"
					? typed.name.replace(/\s+/g, " ").trim()
					: "";
			if (name && name !== runtime.tab.title) {
				runtime.tab.title = name;
				this.emitState();
			}
		}

		if (typed.type === "agent_start" && runtime) {
			if (this.compactingAgents.has(agentId)) {
				// 某些 runtime 会在手动 compact RPC 后立刻继续 queued follow-up；
				// 此时 compact() 的 finally 不能把正在运行的新一轮置回 idle。
				this.manualCompactionFollowUpAgents.add(agentId);
			}
			// Rust's lifecycle events carry sessionId and do not emit agent_settled.
			// Remember the runtime from the reliable start event; agent_end payloads
			// are intentionally normalized differently in Rust's RPC serializer.
			if (typeof typed.sessionId === "string") this.rustRuntimeAgents.add(agentId);
			// agent_start 表示一轮新的 agent run 开始：
			// 1) 清理 recentlyAborted 与旧 compact reload claim，允许状态机恢复 running
			// 2) 推进 stream generation，解封流式闸门（唯一合法解封点）
			this.recentlyAborted.delete(agentId);
			this.consumeManualCompactionReloadClaim(agentId);
			this.notifiedAskAgents.delete(agentId);
			this.openAgentStream(agentId);
			runtime.tab.status = "running";
			this.activeAssistantMessageIds.delete(agentId);
			this.toolMessageIds.delete(agentId);
			this.activeToolCallsByAgent.delete(agentId);
			this.toolExecutingByAgent.set(agentId, null);
			this.emitState();
		}

		if (typed.type === "message_start" && typed.message?.role === "assistant") {
			// abort 封印后的残留 assistant 事件应丢弃，防止误重新激活流式状态。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.beginAssistantMessage(agentId);
			this.setStreamingAgent(agentId, true);
			// 性能计时起表（幂等：message_update start 先到则不重置）。
			// 顶层 message_start 是 mock/pi 均走的确定路径，不能只依赖 delta 事件。
			this.ensurePerfTimer(agentId);
			// 顶层 message_start（mock/pi 均走此路径）：必须允许空骨架，否则
			// text_delta 不再 upsert 时 History 无挂载点，Live 正文无处渲染。
			this.upsertAssistantMessage(agentId, typed.message, "", { allowEmpty: true });
			this.flushMessageEmit(agentId);
		}

		if (typed.type === "auto_retry_start") {
			this.upsertRetryStatusMessage(agentId, typed, "running");
			// 用户已主动中止时不重新激活 running 状态，避免 abort 后 auto-retry 事件误覆盖 state
			if (runtime && !this.recentlyAborted.has(agentId)) {
				// pi 在等待指数退避期间可能短暂结束一轮 agent run；桌面端保持 running，
				// 让用户明确知道当前不是最终失败，而是在等待下一次自动重试。
				runtime.tab.status = "running";
				this.emitState();
			}
		}

		if (typed.type === "auto_retry_end") {
			this.upsertRetryStatusMessage(
				agentId,
				typed,
				typed.success ? "success" : "error",
			);
			// 自动重试最终失败：如果用户没有主动中止，则保持 agent 的 error 状态
			// 不被后续 agent_settled 覆盖，确保侧边栏状态显示失败标记。
			if (!typed.success && runtime && !this.recentlyAborted.has(agentId)) {
				runtime.tab.status = "error";
				const reason = typed.finalError ?? typed.errorMessage ?? "API 请求失败";
				this.addMessage(agentId, "error", `请求失败：${String(reason)}`);
				this.emitState();
			}
		}

		// 自动/手动压缩事件（pi 在自动或手动压缩完成后会发出这些事件），
		// 用于记录压缩耗时和结果，便于排查压缩性能问题。
		if (typed.type === "compaction_start" || typed.type === "auto_compaction_start") {
			this.rpcCompactingAgents.add(agentId);
			if (this.compactingAgents.has(agentId)) {
				this.manualCompactionEventAgents.add(agentId);
			}
			// 用户已主动中止或出错时不重新激活 running 状态
			if (runtime && !this.recentlyAborted.has(agentId) && runtime.tab.status !== "error") {
				// 自动压缩在 agent_end 之后触发：Pi 仍在改写上下文，但不会再发 agent_start。
				// 因此桌面端必须主动保持 running，阻止用户误以为空闲并继续发送消息。
				runtime.tab.status = "running";
				this.emitState();
				void this.emitRuntimeState(agentId);
			}
			void this.appLogger?.info("agent", "Compaction started", {
				agentId,
				reason: typed.reason,
			});
		}
		if (typed.type === "compaction_end" || typed.type === "auto_compaction_end") {
			this.rpcCompactingAgents.delete(agentId);
			this.manualCompactionEventAgents.delete(agentId);
			if (runtime) {
				// 手动 compact() 会在 RPC 完成后统一重载；这里再次重载会与它
				// 竞态，短快照可能覆盖刚显示的上一条回复。自动压缩才由事件路径
				// 触发一次保留历史的重载。
				const manualReloadAlreadyOwned = this.consumeManualCompactionReloadClaim(agentId);
				if (!this.compactingAgents.has(agentId) && !manualReloadAlreadyOwned) {
					void this.loadMessages(agentId, false, undefined, {
						preserveHistory: true,
						stickyHistory: true,
					}).catch(() => undefined);
				}
				// 用户已主动中止或出错时不重新激活 running 状态
				if (!this.recentlyAborted.has(agentId) && runtime.tab.status !== "error") {
					// compaction_end 之后 Pi 仍可能因 overflow retry 或 queued follow-up 自动继续。
					// 只有 agent_settled 才表示不会再自动发起下一轮，不能在这里提前 idle。
					runtime.tab.status = "running";
				}
				this.emitState();
				void this.emitRuntimeState(agentId);
				const settledProcess = runtime.process;
				const settledGeneration = this.getStreamGate(agentId).currentGeneration;
				const timer = setTimeout(() => {
					void this.markIdleIfPiReportsNoWork(
						agentId,
						settledProcess,
						settledGeneration,
					);
				}, 300);
				timer.unref?.();
			}
			void this.appLogger?.info("agent", "Compaction ended", {
				agentId,
				reason: typed.reason,
				result: typed.result ? "success" : "failed",
				aborted: typed.aborted,
				willRetry: typed.willRetry,
				errorMessage: typed.errorMessage,
			});
		}

		if (typed.type === "agent_end") {
			// agent_end 只表示一次底层 run 结束；Pi 之后仍可能执行自动重试、自动压缩，
			// 或压缩后继续 queued follow-up。最终空闲必须等 agent_settled，避免中途误判 idle。
			if (runtime) {
				this.activeAssistantMessageIds.delete(agentId);
				this.setStreamingAgent(agentId, false);
				this.toolMessageIds.delete(agentId);
				this.textEmitter.cancel(agentId);
				this.streamingText.delete(agentId);
				this.lastSentTextByAgent.delete(agentId);
				this.textPushCountByAgent.delete(agentId);
			}
			// agent 异常结束时（如 API 返回 400、模型报错等），将错误提示写入会话，避免用户看到空白。
			// 错误信息的存放位置因 pi 版本和错误类型不同而有多种可能：
			//   1. agent_end 顶层 errorMessage
			//   2. messages 数组中 stopReason=error 的消息的 errorMessage
			//   3. messages 数组中 assistant 消息的 content 里包含 error 片段
			//   4. agent_end 顶层 stopReason=error 但无 messages
			const agentMessages = Array.isArray(typed.messages) ? typed.messages : [];
			const errorMessages = agentMessages.filter(
				(m: any) => m.stopReason === "error",
			);
			// 逐级查找错误文本：顶层 → 错误消息列表 → 仅检查最后一轮对话中 type=error 的 content 块
			const topMsg = errorMessages[errorMessages.length - 1];
			// 只从最后一条 assistant 消息中查找显式 type=error 的 content 块，
			// 避免扫描全部历史消息导致工具成功输出被误判为错误。
			const lastAssistant = agentMessages
				.filter((m: any) => m.role === "assistant")
				.pop();
			const contentError = Array.isArray(lastAssistant?.content)
				? lastAssistant.content.find((c: any) => c?.type === "error")
				: undefined;
			const errorMsg =
				(typed.errorMessage as string | undefined) ??
				topMsg?.errorMessage ??
				(typed.error as string | undefined) ??
				(typeof contentError?.text === "string" ? contentError.text : undefined) ??
				(typeof contentError?.message === "string"
					? contentError.message
					: undefined);
			if (typed.willRetry === true) {
				// agent_end.willRetry 表示 pi 已判定本次错误会进入自动重试；
				// 此时不写入最终错误，避免用户误以为会话已经失败。
				if (errorMsg && !this.retryStatusMessageIds.has(agentId)) {
					this.upsertRetryStatusMessage(
						agentId,
						{
							attempt: 0,
							maxAttempts: 0,
							delayMs: 0,
							errorMessage: String(errorMsg),
						},
						"running",
					);
				}
				// 重试中保持 running，避免侧栏和会话状态提前显示为完成或失败。
				if (runtime) runtime.tab.status = "running";
			} else if (errorMsg) {
				this.addDetailedErrorMessage(agentId, String(errorMsg));
				// 有错误且不会重试时，Agent 才进入 error 态，
				// 否则会被误置为 idle 触发"所有任务完成"通知
				if (runtime) runtime.tab.status = "error";
			} else if (
				typed.stopReason === "error" ||
				errorMessages.length > 0
			) {
				this.addDetailedErrorMessage(agentId);
				if (runtime) runtime.tab.status = "error";
			}
			if (runtime) this.emitState();
			// agent_end 后 runtimeState 可能暂时仍显示后续 compaction/retry；立即同步一次，
			// 但不要把它当作最终空闲信号，最终状态由 agent_settled 处理。
			void this.emitRuntimeState(agentId);

			// 兜底：如果 Pi 由于某些边缘情况未发送 agent_settled，
			// 定时查询 get_state 确认是否已无工作可做，避免 UI 动画永久卡住。
			// agent_settled 正常触发时 markIdleIfPiReportsNoWork 会因 status!=="running" 提前返回。
			const rustSettledFallback = this.rustRuntimeAgents.has(agentId);
			const settledProcess = runtime?.process;
			const settledGeneration = this.getStreamGate(agentId).currentGeneration;
			const settledTimer = setTimeout(() => {
				void this.markIdleIfPiReportsNoWork(agentId, settledProcess, settledGeneration);
			}, rustSettledFallback ? AgentManager.RUST_AGENT_SETTLED_TIMEOUT_MS : AgentManager.AGENT_SETTLED_TIMEOUT_MS);
			settledTimer.unref?.();
		}

		if (typed.type === "agent_settled") {
			// agent_settled 是 Pi 的最终稳定点。
			// 通知 stream gate：abort 对应的 settled 已到。
			// 若 settled 前已有 agent_start（用户立刻重发），此处才真正解封；
			// 若还没有新 start，则保持封印，防止 settled 后残留 delta 复活旧气泡。
			// abort 的 settled（或 abort 后重发时迟到的旧 settled）不算成功完成：
			// recentlyAborted 被 agent_start 清除，但 abortSettledFallbackTimers 保留到 settled，
			// 两者任一命中都说明本轮被用户中止，不得触发「已完成」提醒。
			const gateBeforeSettled = this.getStreamGate(agentId);
			const hasPendingRun =
				gateBeforeSettled.waitingForAbortSettled && gateBeforeSettled.pendingOpenAfterSettled;
			const isAbortSettled =
				this.recentlyAborted.has(agentId) || this.abortSettledFallbackTimers.has(agentId);
			this.noteAgentAbortSettled(agentId);
			this.recentlyAborted.delete(agentId);
			this.manualCompactionFollowUpAgents.delete(agentId);
			if (hasPendingRun) {
				// 这是旧 run 的 settled；新的 run 已经发出 agent_start，不能把它
				// 标成 idle、清理新一轮状态或让 Web SSE 提前收到完成语义。
				if (runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
					runtime.tab.status = "running";
					this.emitState();
					void this.emitRuntimeState(agentId);
				}
				return;
			}
			if (runtime && runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
				// agent_settled 是 Pi 的最终稳定点：没有自动重试、自动压缩、压缩 retry
				// 或 queued follow-up 会继续执行，此时才允许恢复 idle 并通知用户完成。
				runtime.tab.status = "idle";
				// 若 message_end 未到（边缘路径），仍先落盘再清 live。
				this.finalizeThinkingIntoMessage(agentId);
				this.flushMessageEmit(agentId);
				// 一轮结束：运行期缓存裁剪到最近 12 轮（含本轮），防止长会话数组无界增长
				this.trimRuntimeCache(agentId);
				this.finishThinkingChannel(agentId);
				this.activeAssistantMessageIds.delete(agentId);
				this.setStreamingAgent(agentId, false);
				this.toolMessageIds.delete(agentId);
				this.textEmitter.cancel(agentId);
				this.streamingText.delete(agentId);
				this.lastSentTextByAgent.delete(agentId);
				this.textPushCountByAgent.delete(agentId);
				this.activeToolCallsByAgent.delete(agentId);
				this.toolExecutingByAgent.set(agentId, null);
				this.rpcCompactingAgents.delete(agentId);
				this.emitState();
				void this.emitRuntimeState(agentId);

				const messages = this.messages.get(agentId) ?? [];
				const lastMessage = messages[messages.length - 1];
				// 手动停止（abort）不算正常完成：与下方 notifyAgentSettled 同一判断，
				// 停止会话后不弹「已完成」系统通知（用户主动中止，无需提醒）
				if (lastMessage?.role === "assistant" && !isAbortSettled) {
					this.notifySessionEnd(agentId, runtime.tab.title);
				}
			}
		}

		if (
			typed.type === "message_update" &&
			typed.assistantMessageEvent
		) {
			// abort 封印后的延迟 text/thinking delta 一律丢弃，避免重建气泡或串台。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.handleAssistantMessageEvent(agentId, typed);
		}

		if (
			typed.type === "message_end" &&
			typed.message?.role === "assistant"
		) {
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			if (this.activeAssistantMessageIds.has(agentId)) {
				// 先写入 History thinking 并 flush，再发 done 清 live（顺序写进测试）。
				this.finalizeThinkingIntoMessage(agentId);
				this.upsertAssistantMessage(agentId, typed.message);
				this.flushMessageEmit(agentId);
				this.finishThinkingChannel(agentId);
			}
			// 结算性能指标（幂等：message_update done 先结算则 map 已删，直接返回）
			this.settleMessagePerf(agentId, typed.message);
			// 终结 Live 正文通道（顶层 message_end 不经 handleAssistantMessageEvent）
			this.setStreamingAgent(agentId, false);
			const finalText = this.streamingText.get(agentId);
			if (finalText !== undefined) {
				this.textEmitter.flush(agentId);
				this.emitTextStreamNow(agentId, finalText, true);
			}
			this.activeAssistantMessageIds.delete(agentId);
			this.textEmitter.cancel(agentId);
			this.streamingText.delete(agentId);
			this.lastSentTextByAgent.delete(agentId);
			this.textPushCountByAgent.delete(agentId);
		}

		if (typed.type === "tool_execution_start") {
			// abort 封印后的延迟工具事件应丢弃，避免重新激活流式状态。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.upsertToolMessage(agentId, typed, "running");
			// 并行工具会先连续发多个 start；按 toolCallId 追踪，只有最后一个 end 才能表示工具阶段完成。
			const toolName = typed.toolName ?? "tool";
			const toolCallId = String(typed.toolCallId ?? `${toolName}-${Date.now()}`);
			const toolState = updateActiveToolCalls(
				this.activeToolCallsByAgent.get(agentId) ?? new Map<string, string>(),
				{ type: "start", toolCallId, toolName },
			);
			this.applyActiveToolCallState(agentId, toolState);
			// 工具调用开始时确保 agent 状态为 running
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 完整 runtime 信息异步补发；工具边沿已经同步推送，不依赖此请求的完成顺序。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_end") {
			// abort 封印后的延迟工具事件应丢弃。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.upsertToolMessage(
				agentId,
				typed,
				typed.isError ? "error" : "done",
			);
			// 工具执行结束是终态，立即 flush 把最终结果推给渲染进程，避免节流窗口内用户看不到完成状态。
			this.flushMessageEmit(agentId);
			// 清除本次 toolCall；并行批次仅在最后一个工具结束时发布 false，
			// 否则 steer 会在其他工具仍运行时过早进入 pi 队列。
			const activeToolCalls = this.activeToolCallsByAgent.get(agentId) ?? new Map<string, string>();
			const toolState = updateActiveToolCalls(activeToolCalls, {
				type: "end",
				toolCallId: String(typed.toolCallId ?? ""),
			});
			this.applyActiveToolCallState(agentId, toolState);
			// 工具调用完成后保持 agent 状态为 running，等待后续的 agent_end 事件
			// 这样在工具完成到 agent 生成回复之间，thinking bubble 仍然会显示
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 完整 runtime 信息异步补发；序号保证它不会倒灌旧工具状态。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "tool_execution_update") {
			// abort 封印后的延迟工具事件应丢弃。
			if (this.isAgentStreamSealed(agentId)) {
				return;
			}
			this.upsertToolMessage(agentId, typed, "running");
		}

		if (typed.type === "extension_ui_request") {
			this.handleUIRequest(agentId, typed);
		}

		if (typed.type === "extension_error") {
			const reason = String(typed.error ?? "Extension error");
			this.addLocalizedMessage(
				agentId,
				"error",
				"diagnostic.extensionError",
				"扩展执行错误。",
				{ debugDetails: reason },
			);
		}
	}

	/**
	 * 处理 pi 扩展发起的 UI 请求。
	 * 对话类请求写入消息流等待用户回答；fire-and-forget 请求只转发给渲染进程或忽略。
	 */
	private handleUIRequest(agentId: string, typed: Record<string, any>) {
		const method = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		// pi RPC 协议将 setWidget / dialog 字段放在顶层，不嵌套 params
		if (method === "notify") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				// 扩展的 notify 消息常带终端颜色转义（如 billion-context-pi 的更新通知
				// `\x1B[32m✔ ACP auto-updated ...\x1B[0m`），toast 不是终端，直接透传会显示乱码转义符，
				// 在进程边界统一清洗后再交给渲染层。
				message: stripAnsi(String(typed.message ?? "")),
				notifyType: typed.notifyType,
			});
			return;
		}

		if (method === "set_editor_text") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				text: String(typed.text ?? ""),
			});
			return;
		}

		if (method === "setWidget") {
			// Plan Mode 等扩展会频繁刷新 widget；只走 IPC 状态，不落入会话消息，避免 JSONL 被进度噪声污染。
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				widgetKey: String(typed.widgetKey ?? requestId),
				widgetLines: Array.isArray(typed.widgetLines) ? typed.widgetLines : undefined,
				widgetPlacement: typed.widgetPlacement,
			});
			return;
		}
		// 其他非对话 UI 方法暂不占用桌面 UI 空间。
		if (["setStatus", "setTitle"].includes(method)) return;
		if (!["select", "confirm", "input", "editor"].includes(method)) return;

		// Batch ask_question sends its form as an input title envelope. Decode it at
		// the process boundary so no renderer can mistake the raw JSON for a prompt.
		const rawTitle = String(typed.title ?? typed.question ?? "");
		const batchEnvelope = this.tryParseBatchAskEnvelope(rawTitle);
		const rawOptions = Array.isArray(typed.options)
			? typed.options.filter((option): option is string => typeof option === "string")
			: undefined;
		// The bundled extension appends this marker for non-desktop clients. Replace it
		// with the desktop's own inline field so selecting custom text never opens a
		// second request above the composer.
		const hasCustomOption = rawOptions?.some((option) => option.startsWith("✎")) ?? false;
		const effectiveOptions = hasCustomOption
			? rawOptions?.filter((option) => !option.startsWith("✎"))
			: rawOptions;
		// select 无有效选项时降级为 input 而不是静默取消：ask_question 的 options 是
		// 可选的，模型经常只问问题不给选项——自动取消会让用户完全看不到提问 UI。
		// 降级后问题文本保留为标题，用户仍可输入文字回答。
		const effectiveMethod =
			method === "select" && (!effectiveOptions || effectiveOptions.length === 0)
				? "input"
				: method;
		const request = batchEnvelope
			? {
					agentId,
					requestId,
					method: "batch_ask" as const,
					title: "",
					batchQuestions: batchEnvelope.questions,
					batchReview: batchEnvelope.review,
				}
			: {
					agentId,
					requestId,
					method: effectiveMethod,
					title: rawTitle,
					options: effectiveOptions,
					placeholder: typed.placeholder as string | undefined,
					prefill: typed.prefill as string | undefined,
					allowOther: typed.allowOther === true || hasCustomOption,
				};

		// 记录 pending UI 请求，用于 abort 时自动 cancel
		if (!this.pendingUIRequests.has(agentId)) {
			this.pendingUIRequests.set(agentId, new Map());
		}
		this.pendingUIRequests.get(agentId)!.set(requestId, { method: effectiveMethod, title: request.title });

		// The session runtime owns pending UI. Do not write an additional system
		// message, because that creates a second interactive card in the timeline.
		this.emit(ipcChannels.agentsUiRequest, request);
		this.scheduleUIRequestTimeout(agentId, requestId, typed.timeout);
		// 桌面通知由 SessionRuntimeCoordinator 统一触发（非聚焦会话才提醒，避免打扰正在看当前会话的用户）；
		// 此处不重复发，防止一条提问出现两条通知。
	}

	/**
	 * 发送 Extension UI 响应（extension_ui_response）到 pi 的 stdin。
	 * 同时更新对应卡片消息的状态。
	 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		// 写入 extension_ui_response 到 pi 的 stdin

		const extPayload: Record<string, unknown> = {
			type: "extension_ui_response",
			id: requestId,
			value: response.value,
		};
		// pi 的 ctx.ui.confirm() 检查 confirmed 字段，ctx.ui.select/input 检查 value
		if ("confirmed" in response) extPayload.confirmed = response.confirmed;
		// 取消时发 cancelled: true
		if (response.cancelled) extPayload.cancelled = true;
		runtime.process.client.sendRaw(extPayload);

		// 清理 pending 记录
		const pending = this.pendingUIRequests.get(agentId);
		if (pending) {
			pending.delete(requestId);
			if (pending.size === 0) this.pendingUIRequests.delete(agentId);
		}

		// 通知渲染进程 UI 请求已完成
		this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true, ...response });
	}

	/**
	 * pi 信任机制只对“含项目级 pi 资源”的项目触发，且 RPC 模式下 pi 的 project_trust 事件
	 * hasUI 恒为 false、ctx.ui.select 不接 RPC UI 协议，无法弹窗。
	 * 因此 pi-desktop 在启动 pi 进程前自行完成信任确认：干净项目自动信任并写入 trust.json；
	 * 含 .pi/.agents 资源且未记录的项目弹窗让用户决策。
	 */
	private static readonly TRUST_REQUIRING_RESOURCE_FILES = [
		"settings.json",
		"extensions",
		"skills",
		"prompts",
		"themes",
		"SYSTEM.md",
		"APPEND_SYSTEM.md",
	] as const;

	/**
	 * 复刻 pi 的 hasTrustRequiringProjectResources：检查项目目录或其父目录是否存在
	 * 需要信任才能加载的资源（.pi 下的配置/扩展/skills 等，或项目级 .agents/skills）。
	 * 用户全局 ~/.agents/skills 视为可信，不触发信任确认。
	 */
	private hasTrustRequiringResources(hostCwd: string): boolean {
		const configDir = join(hostCwd, ".pi");
		if (
			AgentManager.TRUST_REQUIRING_RESOURCE_FILES.some((file) => existsSync(join(configDir, file)))
		) {
			return true;
		}
		const userAgentsSkillsDir = join(
			this.wslEnvironment?.windowsHome ?? homedir(),
			".agents",
			"skills",
		);
		let currentDir = hostCwd;
		while (true) {
			const agentsSkillsDir = join(currentDir, ".agents", "skills");
			if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
				return true;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) return false;
			currentDir = parentDir;
		}
	}

	/**
	 * 启动 pi 前完成项目信任确认。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任，后续不再重复检查。
	 * - 含信任资源的项目：已信任则放行；已显式拒绝则抛错；未记录则弹窗等待用户决策。
	 */
	/**
	 * 启动 pi 前完成项目信任确认，返回需传给 pi 的信任覆盖指令。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任。
	 * - 已信任：放行，pi 查 trustStore 即可。
	 * - 未记录或曾记 false：弹窗让用户选择。不持久化 false，保证下次仍可重新选择。
	 *   - trust-remember：写 true，pi 信任加载资源。
	 *   - trust-session：用 --approve 本次覆盖，不落盘。
	 *   - deny：用 --no-approve 本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
	 */
	private async ensureProjectTrust(project: Project): Promise<"approve" | "no-approve" | undefined> {
		const cwd = this.wslEnvironment
			? toWslLinuxPath(project.path, this.wslEnvironment)
			: project.path;
		const hostCwd = this.wslEnvironment
			? toWindowsHostPath(project.path, this.wslEnvironment)
			: project.path;
		if (!this.hasTrustRequiringResources(hostCwd)) {
			// 干净项目：pi 无需加载项目级资源，pi-desktop 自动记入信任，避免每次创建 Agent 重复检查。
			void this.appLogger?.info("agent", "Agent ensure trusted directory start", { cwd });
			await this.configManager.ensureTrustedDirectory(cwd);
			void this.appLogger?.info("agent", "Agent ensure trusted directory completed", { cwd });
			return undefined;
		}
		const decision = await this.configManager.getProjectTrustDecision(cwd);
		if (decision === true) return undefined;
		// 未记录或曾记 false：弹窗让用户选择信任策略。不写 false，确保下次打开仍可重新决策。
		const choice = await this.requestProjectTrust(cwd, project.name);
		if (choice === "trust-remember") {
			await this.configManager.setProjectTrustDecision(cwd, true);
			return undefined;
		}
		if (choice === "trust-session") {
			return "approve";
		}
		// deny：本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
		return "no-approve";
	}

	/**
	 * 通过 IPC 请求渲染进程弹出项目信任确认窗，等待用户选择。
	 * 无窗口可用（如 headless）或 60 秒未响应时默认拒绝（安全优先）。
	 */
	private requestProjectTrust(cwd: string, projectName: string): Promise<ProjectTrustChoice> {
		if (this.platformDeps?.hasLiveWindow && !this.platformDeps.hasLiveWindow()) {
			return Promise.resolve<ProjectTrustChoice>("deny");
		}
		const requestId = randomUUID();
		return new Promise<ProjectTrustChoice>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingTrustRequests.delete(requestId)) {
					resolve("deny");
				}
			}, 60_000);
			this.pendingTrustRequests.set(requestId, {
				resolve: (choice) => {
					clearTimeout(timer);
					resolve(choice);
				},
			});
			this.sendToRenderer(ipcChannels.projectsTrustRequest, { requestId, cwd, projectName });
		});
	}

	/** 渲染进程回传用户对信任确认弹窗的选择，唤醒等待中的 Agent 创建流程。 */
	respondTrustRequest(requestId: string, choice: ProjectTrustChoice): void {
		const pending = this.pendingTrustRequests.get(requestId);
		if (pending) {
			this.pendingTrustRequests.delete(requestId);
			pending.resolve(choice);
		}
	}

	private handleAssistantMessageEvent(agentId: string, event: Record<string, any>) {
		// 双保险：即使调用方漏判，也在这里拦截封印 generation 的残留 delta。
		if (this.isAgentStreamSealed(agentId)) return;
		const assistantEvent = event.assistantMessageEvent as Record<string, any>;
		const eventType = assistantEvent.type as string | undefined;
		const partialMessage =
			event.message ??
			assistantEvent.message ??
			assistantEvent.partial ??
			assistantEvent.partialMessage;

		if (eventType === "start" || eventType === "message_start") {
			this.beginAssistantMessage(agentId);
			this.setStreamingAgent(agentId, true);
			// 性能计时起表（幂等：顶层 message_start 先到则不重置）
			this.ensurePerfTimer(agentId);
			// 允许空正文骨架：Live 正文走独立通道，TurnRow 需要 History 挂载点。
			this.upsertAssistantMessage(agentId, partialMessage, "", { allowEmpty: true });
			this.flushMessageEmit(agentId);
			return;
		}

		if (eventType === "text_start" || eventType === "text_end") {
			this.setStreamingAgent(agentId, true);
			// 仅在已有骨架上同步 partial；空文本不新建、不刷 timeline。
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "text_delta") {
			this.beginAssistantMessage(agentId);
			this.setStreamingAgent(agentId, true);
			this.markFirstDelta(agentId);
			this.markFirstText(agentId);
			const delta = String(assistantEvent.delta ?? "");
			// Live 正文唯一热路径：累积后经 textEmitter（50ms）推送，不增长 messages。
			const prevText = this.streamingText.get(agentId) ?? "";
			const nextText = this.extractStreamingText(agentId, partialMessage) ?? prevText + delta;
			this.streamingText.set(agentId, nextText);
			this.textEmitter.push(agentId, stripAnsi(nextText));
			// 思考切正文：只标 endedAt，不落盘、不清 live（message_end/abort 才写入）。
			if (this.thinkingSegmentByAgent.has(agentId)) {
				this.markThinkingSegmentEnded(agentId);
			}
			return;
		}

		if (eventType === "thinking_delta") {
			this.ensureThinkingSegment(agentId);
			this.markFirstDelta(agentId);
			const prev = this.streamingThinking.get(agentId) ?? "";
			const delta = String(assistantEvent.delta ?? "");
			const next = prev + delta;
			this.streamingThinking.set(agentId, next);
			this.thinkingEmitter.push(agentId, stripAnsi(next));
			this.setStreamingAgent(agentId, true);
			// Live 思考唯一热路径：不 upsert messages，避免 50ms timeline 重组。
			return;
		}

		if (eventType === "thinking_end") {
			const finalThinking = String(
				assistantEvent.content ?? this.streamingThinking.get(agentId) ?? "",
			);
			if (finalThinking) {
				this.ensureThinkingSegment(agentId);
				this.streamingThinking.set(agentId, finalThinking);
			}
			// 阶段性终态：只标 endedAt + flush live；不落盘（message_end/abort 才写 messages）。
			this.markThinkingSegmentEnded(agentId);
			return;
		}

		if (eventType === "message_end" || eventType === "done" || eventType === "error") {
			// 结算性能指标（TTFT/总耗时/TPS）并边沿推送渲染层
			this.settleMessagePerf(agentId, partialMessage);
			// 先写入 History thinking 并 flush，再发 done 清 live。
			this.finalizeThinkingIntoMessage(agentId, partialMessage);
			this.upsertAssistantMessage(agentId, partialMessage);
			// message_end/done/error 是本轮回答的最终状态，立即 flush 确保完整消息及时可见。
			this.flushMessageEmit(agentId);
			this.finishThinkingChannel(agentId);
			this.setStreamingAgent(agentId, false);
			// 独立流式正文通道终止：推一次最终累积文本后清缓冲（渲染层由历史消息接管）
			const finalText = this.streamingText.get(agentId);
			if (finalText !== undefined) {
				this.textEmitter.flush(agentId);
				this.emitTextStreamNow(agentId, finalText, true);
			}
			this.activeAssistantMessageIds.delete(agentId);
			this.textEmitter.cancel(agentId);
			this.streamingText.delete(agentId);
			this.lastSentTextByAgent.delete(agentId);
			this.textPushCountByAgent.delete(agentId);
		}
	}

	private beginAssistantMessage(agentId: string) {
		if (!this.activeAssistantMessageIds.has(agentId)) {
			this.activeAssistantMessageIds.set(agentId, randomUUID());
		}
	}

	/**
	 * 记录首个内容 delta 时刻（text/thinking 均算首 token，用户最先感知到的是二者之一）。
	 * 只记一次：思考切正文时 text_delta 不会覆盖已有的 firstDeltaAt。
	 */
	private markFirstDelta(agentId: string) {
		const perf = this.messagePerfByAgent.get(agentId);
		if (perf && perf.firstDeltaAt === 0) {
			perf.firstDeltaAt = Date.now();
		}
	}

	/**
	 * 记录正文首 delta 时刻：思考模式下 thinking_delta 先到，用户感知的「首字」是正文首字，
	 * 因此 text_delta 单独记一次（只在 text_delta 分支调用）；无思考时即首个 text_delta。
	 */
	private markFirstText(agentId: string) {
		const perf = this.messagePerfByAgent.get(agentId);
		if (perf && perf.firstTextAt === 0) {
			perf.firstTextAt = Date.now();
		}
	}

	/**
	 * 幂等起表：顶层 message_start 与 message_update start 两条路径都可能先到，
	 * 只在尚无计时器时创建，避免后者覆盖前者丢失 startedAt。
	 * 起点优先取 sendPrompt 记录的请求发出时刻（消费后删除，防止工具后续答回合
	 * 误用上一次请求起点）；无请求起点（续答/内部触发）时回退到事件到达时刻。
	 */
	private ensurePerfTimer(agentId: string) {
		if (!this.messagePerfByAgent.has(agentId)) {
			const requestedAt = this.promptRequestedAtByAgent.get(agentId);
			if (requestedAt !== undefined) this.promptRequestedAtByAgent.delete(agentId);
			this.messagePerfByAgent.set(agentId, {
				startedAt: requestedAt ?? Date.now(),
				firstDeltaAt: 0,
				firstTextAt: 0,
			});
		}
	}

	/**
	 * message_end/done/error：结算本次回复的性能指标并边沿推送渲染层（不触发 RPC，
	 * 避免流式热路径上叠加 get_state/get_session_stats 开销）。
	 * - ttftMs = 首字（正文首 delta，思考模式下用户感知的首字；无正文退回首 delta）− 请求发出时刻；
	 * - totalMs = 终态 − 请求发出时刻（本轮回复总耗时）；
	 * - tps = output tokens ÷ 生成期时长（首 delta → 终态），分母排除 TTFT 更贴近真实生成速度。
	 * 纯工具调用回合（无 text/thinking delta）只有 totalMs，ttft/tps 缺省。
	 */
	private settleMessagePerf(agentId: string, message?: Record<string, any>) {
		const perf = this.messagePerfByAgent.get(agentId);
		this.messagePerfByAgent.delete(agentId);
		if (!perf) return;
		const now = Date.now();
		const totalMs = now - perf.startedAt;
		// 首字延迟：正文首 delta 优先；纯思考/中途 abort 无正文时退回首 delta，保证有值可展示
		const firstContentAt =
			perf.firstTextAt > 0 ? perf.firstTextAt : perf.firstDeltaAt > 0 ? perf.firstDeltaAt : 0;
		const ttftMs = firstContentAt > 0 ? firstContentAt - perf.startedAt : undefined;
		// message_end 携带完整 assistant 消息，usage 兼容多种命名提取 output tokens
		const usage = (message as any)?.usage;
		const outputTokens = pickNumber(
			usage?.output,
			usage?.outputTokens,
			usage?.completion,
			usage?.completionTokens,
		);
		const tps =
			outputTokens != null &&
			outputTokens > 0 &&
			perf.firstDeltaAt > 0 &&
			now > perf.firstDeltaAt
				? outputTokens / ((now - perf.firstDeltaAt) / 1000)
				: undefined;
		this.lastPerfByAgent.set(agentId, { ttftMs, totalMs, tps, at: now });
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: { ttftMs, totalMs, tps, perfAt: now },
		});
	}

	/** 首 thinking_delta：铸造与 History 相同的稳定段 id（msg-thinking-${assistantMessageId}）。 */
	private ensureThinkingSegment(agentId: string) {
		const existing = this.thinkingSegmentByAgent.get(agentId);
		if (existing) return existing;
		this.beginAssistantMessage(agentId);
		const assistantMessageId = this.activeAssistantMessageIds.get(agentId);
		if (!assistantMessageId) {
			throw new Error(`ensureThinkingSegment: missing assistant message id for ${agentId}`);
		}
		const segment = {
			id: `msg-thinking-${assistantMessageId}`,
			assistantMessageId,
			startedAt: Date.now(),
			endedAt: 0,
		};
		this.thinkingSegmentByAgent.set(agentId, segment);
		// 保证 History 有同 id 骨架，buildTurnDisplay 才能用 liveThinkingId 挂思考步。
		this.upsertAssistantMessage(agentId, undefined, "", { allowEmpty: true });
		this.flushMessageEmit(agentId);
		return segment;
	}

	/** thinking_end / 转正文：标 endedAt 并 flush live，不写 messages。 */
	private markThinkingSegmentEnded(agentId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment) return;
		// 已结束后勿在每个 text_delta 上重复 flush/emit。
		if (segment.endedAt > 0) return;
		segment.endedAt = Date.now();
		this.thinkingSegmentByAgent.set(agentId, segment);
		const text = this.streamingThinking.get(agentId) ?? "";
		this.thinkingEmitter.flush(agentId);
		this.emitThinkingNow(agentId, stripAnsi(text));
	}

	/**
	 * 终态：把累积思考写入当前 assistant 骨架一次。
	 * 必须在 finishThinkingChannel（done）之前调用，并先 flush messages。
	 */
	private finalizeThinkingIntoMessage(agentId: string, partialMessage?: unknown) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		const fromStream = this.streamingThinking.get(agentId) ?? "";
		const fromMessage =
			partialMessage && typeof partialMessage === "object"
				? this.messageProjector.extractThinking((partialMessage as any).content)
				: "";
		const nextThinking = stripAnsi(fromStream || fromMessage || "");
		if (!nextThinking.trim()) return;

		this.beginAssistantMessage(agentId);
		const messageIdBase =
			segment?.assistantMessageId ?? this.activeAssistantMessageIds.get(agentId);
		if (!messageIdBase) return;
		let messageId = messageIdBase;

		const list = this.messages.get(agentId) ?? [];
		let existingIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：运行期 id 已不在列表（被投影身份替换）。若列表里已有同一条
		// pi 消息（正文一致）则更新它并重定向身份，避免 append 造出双份。
		if (existingIndex < 0) {
			const textForMatch =
				partialMessage && typeof partialMessage === "object"
					? this.messageProjector.extractText((partialMessage as any).content)
					: "";
			const rebindIndex = this.findSamePiMessageIndex(list, "assistant", textForMatch);
			if (rebindIndex >= 0) {
				existingIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				if (segment) {
					segment.assistantMessageId = messageId;
					segment.id = `msg-thinking-${messageId}`;
				}
				this.activeAssistantMessageIds.set(agentId, messageId);
			}
		}
		const startedAt = segment?.startedAt ?? Date.now();
		const endedAt = segment?.endedAt && segment.endedAt > 0 ? segment.endedAt : Date.now();
		if (existingIndex >= 0) {
			list[existingIndex].thinking = nextThinking;
			list[existingIndex].thinkingStartedAt = startedAt;
			list[existingIndex].thinkingEndedAt = endedAt;
			this.markMessagesDirtyFrom(agentId, existingIndex);
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text: "",
				timestamp: Date.now(),
				thinking: nextThinking,
				thinkingStartedAt: startedAt,
				thinkingEndedAt: endedAt,
			});
			this.markMessagesDirtyFrom(agentId, list.length - 1);
		}
		this.messages.set(agentId, list);
	}

	/** 发 done 并清 live 思考通道；须在 finalize + flushMessageEmit 之后调用。 */
	private finishThinkingChannel(agentId: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		const text = stripAnsi(this.streamingThinking.get(agentId) ?? "");
		this.thinkingEmitter.cancel(agentId);
		if (segment) {
			const update: ThinkingUpdate = {
				agentId,
				id: segment.id,
				text,
				startedAt: segment.startedAt,
				endedAt: segment.endedAt > 0 ? segment.endedAt : Date.now(),
				done: true,
			};
			this.emit(ipcChannels.agentsThinking, update);
		}
		this.streamingThinking.delete(agentId);
		this.thinkingSegmentByAgent.delete(agentId);
		this.lastSentThinkingByAgent.delete(agentId);
		this.thinkingPushCountByAgent.delete(agentId);
	}

	private upsertAssistantMessage(
		agentId: string,
		partialMessage?: unknown,
		fallbackDelta = "",
		options?: { allowEmpty?: boolean },
	) {
		const list = this.messages.get(agentId) ?? [];
		let messageId = this.activeAssistantMessageIds.get(agentId);
		if (!messageId) {
			messageId = randomUUID();
			this.activeAssistantMessageIds.set(agentId, messageId);
		}

		let existingIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：activeAssistantMessageIds 指向的运行期 id 在列表里已不存在
		// （loadMessages 替换为投影身份）。此时不能盲目 append——列表里可能已有同一条
		// pi 消息的投影版，append 会造出双份（同内容消息被用户消息切分到两个 run）。
		// 按内容指纹匹配既有消息：命中则更新它并把身份映射重定向到它，保持单份。
		if (existingIndex < 0) {
			const extractedTextForMatch =
				partialMessage && typeof partialMessage === "object"
					? this.messageProjector.extractText((partialMessage as any).content)
					: "";
			const rebindIndex = this.findSamePiMessageIndex(
				list,
				"assistant",
				extractedTextForMatch || fallbackDelta,
			);
			if (rebindIndex >= 0) {
				existingIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				this.activeAssistantMessageIds.set(agentId, messageId);
			}
		}
		const existing = existingIndex >= 0 ? list[existingIndex] : undefined;
		const extractedText =
			partialMessage && typeof partialMessage === "object"
				? this.messageProjector.extractText((partialMessage as any).content)
				: "";
		// stopReason（provider 归一化）：message_start 骨架为 pending，message_end 更新为
		// 真实值（stop/toolUse/aborted/error/length）。渲染层据此精确区分中间/最终回复。
		// pending 是骨架占位值：不持久化（new 分支）也不覆盖既有值（existing 分支），
		// 否则 message_end 缺 stopReason 时消息永远停 in pending，渲染层回退启发式失效。
		const extractedStopReason =
			partialMessage && typeof partialMessage === "object"
				? String((partialMessage as any).stopReason ?? "") || undefined
				: undefined;
		const finalStopReason =
			extractedStopReason && extractedStopReason !== "pending"
				? extractedStopReason
				: undefined;

		if (existing) {
			// 已有骨架：有抽出文本才覆盖；fallbackDelta 仅作追加兜底（终态路径）。
			// thinking 不在此写入——仅 finalizeThinkingIntoMessage 在终态写一次。
			if (extractedText || fallbackDelta) {
				existing.text = extractedText || `${existing.text}${fallbackDelta}`;
			}
			// 终态（message_end）带真实 stopReason 时更新；骨架占位值（pending）不覆盖旧值。
			if (finalStopReason) {
				existing.stopReason = finalStopReason;
			}
			// 保留原始时间戳，不随 delta 刷新。
			this.markMessagesDirtyFrom(agentId, existingIndex);
		} else {
			const text = extractedText || fallbackDelta;
			// 默认拒绝空消息；message_start 传 allowEmpty 以建立 Live 挂载点。
			if (!text && !options?.allowEmpty) return;
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text: text || "",
				timestamp: Date.now(),
				...(finalStopReason ? { stopReason: finalStopReason } : {}),
			});
			this.markMessagesDirtyFrom(agentId, list.length - 1);
		}

		this.messages.set(agentId, list);
		// upsertAssistantMessage 被 text_start/end 等路径调用，走节流合并；
		// message_end 等终态调用方会在调用后显式 flush，保证最终状态及时。
		this.scheduleMessageEmit(agentId);
	}


	/**
	 * 在消息列表中查找「同一条 pi 消息」的既有副本（重载后事件迟到的身份重定向）。
	 *
	 * 运行期事件消息（id=randomUUID）与文件投影消息（id=agentId-history-entryId）
	 * 的 ChatMessage.id 永不相同，只能按内容匹配：
	 * - tool：meta.toolCallId 两通道同源（pi 的 toolCallId），精确匹配；
	 * - assistant/user：正文文本（stripAnsi 后）一致视为同一消息，从后往前匹配
	 *   （同文本多条时取最近一条——重载后迟到的终态事件对应最新落盘的副本）。
	 * 空文本不参与匹配（骨架无内容可证同一性，且骨架场景 id 映射仍有效）。
	 */
	private findSamePiMessageIndex(
		list: ChatMessage[],
		role: ChatMessage["role"],
		text: string,
		toolCallId?: string,
	): number {
		const normalized = stripAnsi(text ?? "").trim();
		if (role === "tool" && toolCallId) {
			for (let index = list.length - 1; index >= 0; index -= 1) {
				const message = list[index];
				if (
					message.role === "tool" &&
					(message.meta as Record<string, unknown> | undefined)?.toolCallId === toolCallId
				) {
					return index;
				}
			}
			return -1;
		}
		if (!normalized) return -1;
		for (let index = list.length - 1; index >= 0; index -= 1) {
			const message = list[index];
			if (message.role !== role) continue;
			if (stripAnsi(message.text ?? "").trim() !== normalized) continue;
			return index;
		}
		return -1;
	}

	/**
	 * 重载（loadMessages 替换列表）后，把「进行中的消息身份」从运行期副本重定向到投影版。
	 *
	 * 场景：重载快照捕捉到流式中间态——投影含未完成 assistant（无 stopReason、部分文本），
	 * 运行期含同一条的骨架（text 恒空，preserved 保护保留在列表尾部）。若只靠
	 * upsert 指纹匹配：骨架与投影 partial 文本不同（空 vs 部分）匹配不上，message_end
	 * 更新骨架后列表里仍残留投影 partial → 双份。
	 *
	 * 规则：activeAssistantMessageIds 登记的运行期骨架（空文本、无 stopReason）仍在
	 * nextMessages 中时，若投影里存在「未完成的 assistant」（无 stopReason、有部分文本
	 * ——同一时刻只有一条流式消息，从后往前取最后一条），把身份映射重定向到投影版并
	 * 移除骨架：后续事件继续更新投影版，位置正确、单份。tool 同理按 toolCallId。
	 */
	private rebindInFlightMessages(
		agentId: string,
		nextMessages: ChatMessage[],
		projectedMessages: ChatMessage[],
	): void {
		const runningAssistantId = this.activeAssistantMessageIds.get(agentId);
		const runningInNext = runningAssistantId
			? nextMessages.find((message) => message.id === runningAssistantId)
			: undefined;
		// 运行期骨架被 preserved 保护保留在尾部（merge 未匹配到同指纹投影）：
		// 若投影里恰好有它的「未完成版」（无 stopReason、有部分文本——重载快照
		// 捕捉到的流式中间态），说明同一条消息将以两种身份并存（partial 投影版 +
		// 骨架，后续 message_end 会把骨架更新为完整版 → 双份）。把身份重定向到
		// 投影版并移除骨架：后续事件继续更新投影版，位置正确、单份。
		if (
			runningInNext &&
			runningInNext.role === "assistant" &&
			!runningInNext.stopReason &&
			!runningInNext.text.trim()
		) {
			let projectedIncomplete: ChatMessage | undefined;
			for (let index = projectedMessages.length - 1; index >= 0; index -= 1) {
				const message = projectedMessages[index];
				if (
					message.role === "assistant" &&
					!message.stopReason &&
					Boolean(message.text.trim())
				) {
					projectedIncomplete = message;
					break;
				}
			}
			if (projectedIncomplete) {
				const skeletonIndex = nextMessages.findIndex(
					(message) => message.id === runningAssistantId,
				);
				if (skeletonIndex >= 0) nextMessages.splice(skeletonIndex, 1);
				this.activeAssistantMessageIds.set(agentId, projectedIncomplete.id);
				const segment = this.thinkingSegmentByAgent.get(agentId);
				if (segment && segment.assistantMessageId === runningAssistantId) {
					segment.assistantMessageId = projectedIncomplete.id;
					segment.id = `msg-thinking-${projectedIncomplete.id}`;
				}
			}
		}
		const runningTool = this.toolMessageIds.get(agentId);
		if (runningTool) {
			for (const [toolCallId, runningToolId] of runningTool) {
				if (nextMessages.some((message) => message.id === runningToolId)) continue;
				const projectedIndex = nextMessages.findIndex(
					(message) =>
						message.role === "tool" &&
						(message.meta as Record<string, unknown> | undefined)?.toolCallId === toolCallId,
				);
				if (projectedIndex >= 0) {
					runningTool.set(toolCallId, nextMessages[projectedIndex].id);
				}
			}
		}
	}

	private upsertToolMessage(
		agentId: string,
		event: Record<string, any>,
		status: "running" | "done" | "error",
	) {
		const toolName = event.toolName || "tool";
		const toolCallId = String(event.toolCallId ?? `${toolName}-${Date.now()}`);
		let agentTools = this.toolMessageIds.get(agentId);
		if (!agentTools) {
			agentTools = new Map<string, string>();
			this.toolMessageIds.set(agentId, agentTools);
		}

		let messageId = agentTools.get(toolCallId);
		if (!messageId) {
			messageId = randomUUID();
			agentTools.set(toolCallId, messageId);
		}

		const list = this.messages.get(agentId) ?? [];
		let existingToolIndex = list.findIndex((message) => message.id === messageId);
		// 重载后事件迟到：运行期工具 id 已不在列表（被投影身份替换）。按 toolCallId
		// （两通道同源）匹配既有工具消息，更新它并重定向身份，避免 append 双份。
		if (existingToolIndex < 0) {
			const rebindIndex = this.findSamePiMessageIndex(list, "tool", "", toolCallId);
			if (rebindIndex >= 0) {
				existingToolIndex = rebindIndex;
				messageId = list[rebindIndex].id;
				agentTools.set(toolCallId, messageId);
			}
		}
		const existing = existingToolIndex >= 0 ? list[existingToolIndex] : undefined;
		const isError = status === "error" || event.isError === true;
		const args = event.args ?? existing?.meta?.args;
		const startedAt =
			typeof existing?.meta?.startedAt === "number"
				? existing.meta.startedAt
				: Date.now();
		// 工具耗时只能由 start/end 两个事件推导；start 时先保存 startedAt，end 时再写入 durationMs，
		// 避免使用消息 timestamp（会在 update/end 时刷新）导致历史恢复后耗时不可还原。
		const durationMs =
			status === "running" ? undefined : Math.max(0, Date.now() - startedAt);
		const result =
			event.result ??
			event.partialResult ??
			event.output ??
			existing?.meta?.result;
		const detailText = this.messageProjector.formatToolDetail(
			toolName,
			args,
			result,
			isError,
		);
		// detailText 整体截断（拼接后可能超单段上限）并标记 truncated/fullLength；
		// 完整结果文本按 agent 缓存在 toolFullTextByAgent（LRU），供「查看完整输出」按需读取。
		const detailDelivery = this.messageProjector.truncateDetailWithMeta(detailText);
		if (detailDelivery.truncated) {
			const fullText = this.messageProjector.extractToolResultText(result) || this.messageProjector.safeJson(result);
			if (fullText) {
				let fullTextCache = this.toolFullTextByAgent.get(agentId);
				if (!fullTextCache) {
					fullTextCache = new Map<string, string>();
					this.toolFullTextByAgent.set(agentId, fullTextCache);
				}
				fullTextCache.set(messageId, fullText);
				if (fullTextCache.size > AgentManager.TOOL_FULL_TEXT_LRU_LIMIT) {
					// LRU 淘汰最旧（Map 迭代序 = 插入序）
					const oldest = fullTextCache.keys().next().value;
					if (oldest !== undefined) fullTextCache.delete(oldest);
				}
			}
		}
		const icon = status === "running" ? "▶" : isError ? "✗" : "✓";
		const text =
			status === "running" ? `${icon} ${toolName}` : `${icon} ${toolName}`;
		// args 可能来自 event.args（对象）或 existing.meta.args（已序列化的 JSON 字符串）。
		// 如果是后者（如 tool_execution_end 不带 args），直接复用已有字符串避免 double encoding。
		const argsMeta = typeof args === "string" ? args : this.messageProjector.truncateForDetail(this.messageProjector.safeJson(args));
		// 提取 ask_question 详情用于渲染「常驻问答卡」：支持批量（questions 数组）
		// 和单问题两种格式，统一走 buildAskQuestionResultSummary（与历史投影共用），
		// 保证实时/回放得到同样形状的 _askCard。
		const askCard = buildAskQuestionResultSummary({
			toolName,
			args,
			result,
			// abort 时覆写 answer 为 null、answered 为 false，确保卡片显示"已取消"
			aborted: this.abortedDuringAsk.has(agentId),
			// 工具调用失败（✗）时不升格成「已回答」问答卡：result 是错误文案，
			// 降级为普通工具卡，detailText 仍展示错误内容。
			isError,
		});
		const meta = {
			status,
			toolName,
			toolCallId,
			startedAt,
			...(durationMs !== undefined ? { durationMs } : {}),
			args: argsMeta,
			result: this.messageProjector.truncateForDetail(this.messageProjector.extractToolResultText(result) || this.messageProjector.safeJson(result)),
			isError,
			detailText: detailDelivery.text,
			...(detailDelivery.truncated
				? { truncated: true, fullLength: detailDelivery.fullLength }
				: {}),
			// originalContent 不再存储到消息中（full file 会使会话元数据体积过大）。
			// diff 使用工具参数（oldText/newText 等）展示变动区域，无需完整文件快照。
			
			...(askCard ? { _askCard: askCard } : {}),
		};

		if (existing) {
			existing.text = text;
			existing.timestamp = Date.now();
			// 合并而非替换：重定向到投影版时保留其身份字段（entryId/_piDeckMsgSeq），
			// 否则渲染层接缝去重与编辑/删除/重发定位会因 entryId 丢失而失效。
			const mergedMeta: Record<string, unknown> = { ...(existing.meta ?? {}), ...meta };
			// 终态没有生成 askCard（错误/损坏结果）时必须显式删旧值；仅省略字段会因
			// 上面的对象合并保留旧 _askCard，导致 ✗ ask_question 仍显示“已回答”。
			if (
				toolName.toLowerCase() === "ask_question" &&
				status !== "running" &&
				!askCard
			) {
				delete mergedMeta._askCard;
			}
			existing.meta = mergedMeta;
			this.markMessagesDirtyFrom(agentId, existingToolIndex);
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "tool",
				text,
				timestamp: Date.now(),
				meta,
			});
			this.markMessagesDirtyFrom(agentId, list.length - 1);
		}

		this.messages.set(agentId, list);
		this.scheduleMessageEmit(agentId);
	}

	private addMessage(
		agentId: string,
		role: ChatMessage["role"],
		text: string,
		meta?: Record<string, unknown>,
		images?: ImageContent[],
	) {
		const list = this.messages.get(agentId) ?? [];
		list.push({
			id: randomUUID(),
			agentId,
			role,
			text,
			timestamp: Date.now(),
			meta,
			...(images && images.length > 0 ? { images } : {}),
		});
		this.messages.set(agentId, list);
		if (role === "user" || role === "assistant") this.refreshAutoTitle(agentId);
		this.scheduleMessageEmit(agentId, true);
	}

	private addLocalizedMessage(
		agentId: string,
		role: ChatMessage["role"],
		i18nKey: string,
		fallbackText: string,
		options: {
			params?: I18nParams;
			debugDetails?: string;
			meta?: Record<string, unknown>;
		} = {},
	) {
		this.addMessage(agentId, role, fallbackText, {
			...options.meta,
			i18nKey,
			...(options.params ? { i18nParams: options.params } : {}),
			...(options.debugDetails ? { debugDetails: options.debugDetails } : {}),
		});
	}

	private refreshAutoTitle(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return false;
		const project = this.getProject(runtime.tab.projectId);
		if (!project) return false;
		if (!isDefaultAgentTitle(runtime.tab.title, project, this.translate as (key: string, params?: Record<string, string | number>) => string)) return false;
		const nextTitle = inferTitleFromMessages(this.messages.get(agentId) ?? []);
		if (!nextTitle || nextTitle === runtime.tab.title) return false;
		// Agent 列表标题应和历史会话列表的“摘要名”一致；
		// 只覆盖默认标题，避免打开/重命名过的历史会话名称被第一条消息反向改掉。
		runtime.tab.title = nextTitle;
		this.emitState();
		return true;
	}

	private addDetailedErrorMessage(agentId: string, errorMessage?: string) {
		const retryMessageId = this.retryStatusMessageIds.get(agentId);
		const retryMessage = retryMessageId
			? this.messages.get(agentId)?.find((message) => message.id === retryMessageId)
			: undefined;
		const attempt = Number(retryMessage?.meta?.attempt ?? 0);
		const maxAttempts = Number(retryMessage?.meta?.maxAttempts ?? 0);
		const hasRetries = maxAttempts > 0;
		const fallback = errorMessage
			? `请求失败。${hasRetries ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : ""}`
			: `请求失败。${hasRetries ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : ""}\n\n请稍后重试。`;
		const i18nKey = errorMessage
			? hasRetries ? "diagnostic.requestFailedAfterRetries" : "diagnostic.requestFailed"
			: hasRetries ? "diagnostic.requestFailedUnknownAfterRetries" : "diagnostic.requestFailedUnknown";
		this.addLocalizedMessage(agentId, "error", i18nKey, fallback, {
			params: {
				attempt,
				maxAttempts,
			},
			debugDetails: errorMessage,
		});
	}

	private upsertRetryStatusMessage(
		agentId: string,
		event: Record<string, any>,
		status: "running" | "success" | "error",
	) {
		const list = this.messages.get(agentId) ?? [];
		let messageId = this.retryStatusMessageIds.get(agentId);
		let message = messageId ? list.find((item) => item.id === messageId) : undefined;
		if (!message) {
			messageId = randomUUID();
			message = {
				id: messageId,
				agentId,
				role: "system",
				text: "",
				timestamp: Date.now(),
			};
			list.push(message);
			this.retryStatusMessageIds.set(agentId, messageId);
		}

		const attempt = Number(event.attempt ?? message.meta?.attempt ?? 0);
		const maxAttempts = Number(event.maxAttempts ?? message.meta?.maxAttempts ?? 0);
		const delayMs = Number(event.delayMs ?? 0);
		const reasonValue = event.errorMessage ?? event.finalError ?? message.meta?.errorMessage;
		const reason = reasonValue == null ? "" : String(reasonValue);
		const delaySeconds = Math.ceil(delayMs / 1000);
		const delayText = delayMs > 0 ? `，${delaySeconds} 秒后重试` : "";
		const countText = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : String(attempt || 1);
		const params = {
			attempt,
			count: countText,
			delaySeconds,
		};
		let i18nKey: string;

		if (status === "running") {
			i18nKey = delayMs > 0
				? "diagnostic.retryScheduledAfterDelay"
				: "diagnostic.retryScheduled";
			message.text = `正在自动重试 ${countText}${delayText}`;
		} else if (status === "success") {
			i18nKey = "diagnostic.retrySucceeded";
			message.text = `自动重试成功，共重试 ${attempt} 次`;
		} else {
			i18nKey = "diagnostic.retryFailed";
			message.text = `自动重试失败，已重试 ${countText} 次`;
		}
		message.timestamp = Date.now();
		message.meta = {
			status,
			attempt,
			maxAttempts,
			delayMs,
			errorMessage: reason,
			i18nKey,
			i18nParams: params,
			...(reason && status !== "success" ? { debugDetails: reason } : {}),
		};

		this.messages.set(agentId, list);
		this.scheduleMessageEmit(agentId, true);
	}

		/**
	 * 从 get_entries 响应构建 active branch 的 entryId 有序列表。
	 * 从 leafId 沿 parentId 回溯至 root 得到有序列表。
	 * 这个列表的顺序与 get_messages 返回的消息顺序一致，
	 * 用于在 convertAgentMessages 中按位置匹配 entryId 到 message。
	 * 只保留 type=message 的 entryId（即 user/assistant/toolResult 角色消息），
	 * 剔除 session、model_change、thinking_level_change、custom 等非消息条目，
	 * 使返回的 id 列表与 get_messages 返回的 rawMessages 一一对齐。
	 */
	private buildActiveBranchEntryIds(
		entries: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
		leafId: string,
	): string[] {
		return buildActiveBranchEntryIdsForDisplay(entries, leafId);
	}

	private convertAgentMessages(
		agentId: string,
		rawMessages: unknown[],
		activeEntryIds?: string[],
	): ChatMessage[] {
		return this.messageProjector.convert(agentId, rawMessages, activeEntryIds);
	}

	/**
	 * The bundled ask_question extension wraps batch questions in one input request
	 * because Pi RPC dialogs are otherwise strictly sequential. Validate the shape
	 * before forwarding it so malformed extension data falls back to normal input.
	 */
	private tryParseBatchAskEnvelope(title: string): {
		review: boolean;
		questions: Array<Record<string, unknown>>;
	} | undefined {
		const raw = title.trim();
		if (!raw.startsWith("{")) return undefined;
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (parsed.__piDeckBatchAsk !== 1 || !Array.isArray(parsed.questions)) {
				return undefined;
			}
			const questions = parsed.questions.filter(
				(question): question is Record<string, unknown> => {
					if (!question || typeof question !== "object") return false;
					const typed = question as Record<string, unknown>;
					return (
						typeof typed.id === "string" &&
						typeof typed.question === "string" &&
						["select", "confirm", "input", "editor"].includes(String(typed.type))
					);
				},
			);
			return questions.length > 0
				? { review: parsed.review === true, questions }
				: undefined;
		} catch {
			return undefined;
		}
	}

	private scheduleUIRequestTimeout(agentId: string, requestId: string, timeout: unknown) {
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return;

		const timer = setTimeout(() => {
			if (!this.pendingUIRequests.get(agentId)?.has(requestId)) return;
			// A timeout must close both ends of the protocol. Merely hiding the
			// renderer form leaves Pi blocked on extension_ui_response indefinitely.
			this.sendUIResponse(agentId, requestId, { cancelled: true });
		}, Math.floor(timeout));
		timer.unref?.();
	}

	private scheduleIdleCheckAfterExtensionCommand(agentId: string) {
		const runtime = this.agents.get(agentId);
		const expectedProcess = runtime?.process;
		const expectedGeneration = this.getStreamGate(agentId).currentGeneration;
		const timer = setTimeout(() => {
			void this.markIdleIfPiReportsNoWork(agentId, expectedProcess, expectedGeneration);
		}, 100);
		timer.unref?.();
	}

	private async markIdleIfPiReportsNoWork(
		agentId: string,
		expectedProcess?: PiProcess,
		expectedGeneration?: number,
	) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		const observedProcess = expectedProcess ?? runtime.process;
		const observedGeneration =
			expectedGeneration ?? this.getStreamGate(agentId).currentGeneration;

		if (runtime.process !== observedProcess) return;
		const gateBefore = this.getStreamGate(agentId);
		if (
			gateBefore.currentGeneration !== observedGeneration ||
			gateBefore.pendingOpenAfterSettled
		) return;
		// Rust 运行时在最终错误路径也不会发 agent_settled；允许 error 状态
		// 走同一条 get_state 兜底，关闭 Web SSE，但保留桌面端 error 状态。
		const mayBeSettled = runtime.tab.status === "running" || runtime.tab.status === "error";
		if (!mayBeSettled) return;
		if ((this.pendingUIRequests.get(agentId)?.size ?? 0) > 0) return;
		if (this.rpcCompactingAgents.has(agentId) || this.compactingAgents.has(agentId)) return;
		if (this.activeAssistantMessageIds.has(agentId)) return;
		if (this.toolExecutingByAgent.get(agentId)) return;

		const response = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => undefined);
		if (!response?.success || !response.data) return;

		const state = response.data as {
			isStreaming?: boolean;
			isCompacting?: boolean;
			pendingMessageCount?: number;
		};
		if (state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0) return;
		const current = this.agents.get(agentId);
		if (!current || current.process !== observedProcess) return;
		const gateAfter = this.getStreamGate(agentId);
		if (
			gateAfter.currentGeneration !== observedGeneration ||
			gateAfter.pendingOpenAfterSettled
		) return;
		// 查询期间可能又收到新的 prompt；以查询返回时的实际 runtime 状态为准，
		// 避免旧的兜底定时器把新一轮运行误发成 settled。
		if (current.tab.status !== "running" && current.tab.status !== "error") return;
		const keepError = current.tab.status === "error";

		if (!keepError) runtime.tab.status = "idle";
		this.finalizeThinkingIntoMessage(agentId);
		this.flushMessageEmit(agentId);
		// 兜底确认空闲同样视为一轮结束：运行期缓存裁剪，与 agent_settled 路径一致
		this.trimRuntimeCache(agentId);
		this.finishThinkingChannel(agentId);
		this.textEmitter.cancel(agentId);
		this.streamingText.delete(agentId);
		this.lastSentTextByAgent.delete(agentId);
		this.textPushCountByAgent.delete(agentId);
		this.emitState();
		void this.emitRuntimeState(agentId);
		// Pi_Agent_Rust 不发 agent_settled；get_state 已确认真正空闲后补发
		// 一个仅供本地 Web SSE 使用的最终事件，保持 Web 连接与桌面端状态一致。
		this.emitLocalEvent(agentId, { type: "agent_settled" });
	}

	private requireRuntime(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error(`Agent not found: ${agentId}`);
		return runtime;
	}

	/**
	 * 非聚焦会话收到 Ask 类 UI 请求时的桌面通知（SessionRuntimeCoordinator 调用）。
	 * 与 notifySessionEnd 共用同一套设置门控：enableNotifications + Notification.isSupported。
	 * 每轮 run 只通知一次（去重标记在 agent_start 时清除），避免同一轮多次提问刷屏。
	 */
	notifyAskPending(agentId: string, sessionId: string, sessionTitle: string, question: string): void {
		try {
			const settings = this.settingsStore.get();
			if (!settings.enableNotifications) return;
			if (!this.platformDeps?.notifications.isSupported()) return;
			if (this.notifiedAskAgents.has(agentId)) return;
			this.notifiedAskAgents.add(agentId);

			const appName = this.platformDeps.appName || "PiDeck";
			const title = sessionTitle || appName;
			// 有具体提问内容时展示问题，否则退回通用文案（批量提问等无 title 场景）
			const questionText = question.length > 60 ? `${question.slice(0, 60)}…` : question;
			const body = questionText
				? this.translate("mainNotification.askQuestion", { title, question: questionText })
				: this.translate("mainNotification.askPending", { title });

			this.platformDeps.notifications.show({
				title: appName,
				body,
				silent: false,
				activationUrl: sessionId ? `pideck://session/${sessionId}` : "pideck://",
				onClick: () => {
					this.focusMainWindowForSession(sessionId);
				},
				onFailed: (error) => {
					void this.appLogger?.warn("agent", "Ask notification failed to show", { agentId, error: String(error) });
				},
			});
		} catch {
			// 通知失败不影响主流程，静默处理
		}
	}

	/**
	 * 会话结束时发送系统通知。
	 * 仅在设置中启用通知且 Electron Notification 可用时触发，
	 * 通知用户 agent 已完成响应，可以查看结果或继续对话；
	 * 点击通知会聚焦主窗口并切换到对应会话。
	 */
	private notifySessionEnd(agentId: string, sessionTitle: string) {
		try {
			const settings = this.settingsStore.get();
			if (!settings.enableNotifications) return;
			if (!this.platformDeps?.notifications.isSupported()) return;

			// 使用应用名称作为通知标题，在 Windows/macOS 通知中心中显示为应用标识
			const appName = this.platformDeps.appName || "PiDeck";
			const body = this.translate("mainNotification.sessionDone", { title: sessionTitle });
			const resolveSessionId = this.resolveSessionId;
			const sessionId = resolveNotificationSessionId(
				resolveSessionId ? () => resolveSessionId(agentId) : undefined,
			);

			this.platformDeps.notifications.show({
				title: appName,
				body,
				silent: false,
				activationUrl: sessionId ? `pideck://session/${sessionId}` : "pideck://",
				onClick: () => {
					this.focusMainWindowForSession(sessionId);
				},
				onFailed: (error) => {
					void this.appLogger?.warn("agent", "Session notification failed to show", { agentId, error: String(error) });
				},
			});
		} catch {
			// 通知失败不影响主流程，静默处理
		}
	}

	/**
	 * 聚焦主窗口并让渲染进程切换到指定会话。
	 * 通过通用会话聚焦通道通知 renderer 切到对应 project + session tab；
	 * sessionId 缺省（运行时尚未绑定会话）时只聚焦窗口，不做跳转。
	 */
	private focusMainWindowForSession(sessionId?: string) {
		try {
			if (this.platformDeps?.focusSessionFromNotification) {
				const focused = this.platformDeps.focusSessionFromNotification(sessionId);
				if (!focused) {
					void this.appLogger?.warn("agent", "Notification focus skipped: no main window", { sessionId });
				}
			}
		} catch (error) {
			// 聚焦失败不影响主流程，静默处理
			void this.appLogger?.warn("agent", "Notification focus failed", { sessionId, error });
		}
	}

	/**
	 * 生成带会话跳转参数的 Windows toast XML。
	 * 使用 activationType="protocol" + pideck:// 协议 URL：点击通知时 Windows 通过
	 * 注册表协议关联唤起应用（不依赖 ToastActivatorCLSID / 快捷方式匹配，更可靠），
	 * 被唤起实例的 argv 携带协议 URL，主实例据此识别要跳转的会话。
	 * sessionId 缺省时 launch 回退为 pideck:// 根地址（点击仅聚焦窗口）。
	 */


	/**
	 * 安排一次消息 emit。流式高频事件走节流合并（同一 agent 50ms 内多次调用只 emit 一次最新数组）；
	 * immediate=true 时跳过节流立即 flush，用于 message_end/tool_execution_end 等终态事件，确保最终状态不丢。
	 */
	/** 取/建 agent 的 stream gate 状态。 */
	private getStreamGate(agentId: string): StreamGateState {
		let gate = this.streamGates.get(agentId);
		if (!gate) {
			gate = createStreamGateState();
			this.streamGates.set(agentId, gate);
		}
		return gate;
	}

	/** abort 时封印当前 generation。 */
	private sealAgentStream(agentId: string): StreamGateState {
		const next = sealStreamGate(this.getStreamGate(agentId));
		this.streamGates.set(agentId, next);
		return next;
	}

	/** agent_start 时尝试推进 generation；若仍在等 abort settled，则只记 pending。 */
	private openAgentStream(agentId: string) {
		const next = openStreamGateForNewRun(this.getStreamGate(agentId));
		this.streamGates.set(agentId, next);
	}

	/** abort 后的 agent_settled：结束 waiting，必要时解封 pending start。 */
	private noteAgentAbortSettled(agentId: string) {
		this.clearAbortSettledFallback(agentId);
		const next = noteAbortSettled(this.getStreamGate(agentId));
		this.streamGates.set(agentId, next);
	}

	/**
	 * pi 偶发不发 agent_settled 时的兜底：超时后按 settled 处理，
	 * 避免用户立刻重发时新一轮永远无法接收流式事件。
	 * 同时触发 abort 升级检查：若 pi 仍未停稳，补发 abort_bash / 二次 abort。
	 */
	private scheduleAbortSettledFallback(
		agentId: string,
		process: PiProcess,
		sealedGeneration: number,
	) {
		this.clearAbortSettledFallback(agentId);
		const timer = setTimeout(() => {
			this.abortSettledFallbackTimers.delete(agentId);
			const gateBeforeFallback = this.getStreamGate(agentId);
			// 仅在仍 waiting 时生效；正常 settled 路径会先 clear 定时器。
			if (gateBeforeFallback.waitingForAbortSettled) {
				this.noteAgentAbortSettled(agentId);
			}
			// 新一轮已经在 abort settled 前开始时，本次 fallback 只能解封 gate，
			// 绝不能再查询/中止当前 process，否则会把新一轮一起杀掉。
			if (gateBeforeFallback.pendingOpenAfterSettled) return;
			// 工具执行中 abort 偶发不被 pi 及时处理（长 bash/扩展工具阻塞），
			// 若不升级，agent 会继续跑到工具结束，用户看到“停止不了”。
			void this.escalateAbortIfStillRunning(agentId, process, sealedGeneration);
		}, AgentManager.ABORT_SETTLED_FALLBACK_MS);
		timer.unref?.();
		this.abortSettledFallbackTimers.set(agentId, timer);
	}

	/**
	 * abort 升级：兜底窗口已过但 pi 仍在流式/执行，补发专用命令并验证。
	 * - abort_bash：pi 提供的杀 bash 进程树命令（RPC abort 不覆盖 bash 阻塞场景）
	 * - 二次 abort：覆盖 abort 事件与工具事件交错时被丢弃的竞态
	 * - 仍未停止则通过 notice 明确告知用户（stop 慢是可见问题，不能只写日志）
	 */
	private async escalateAbortIfStillRunning(
		agentId: string,
		abortedProcess: PiProcess,
		sealedGeneration: number,
	) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		if (runtime.process !== abortedProcess) return;
		if (this.getStreamGate(agentId).currentGeneration !== sealedGeneration) return;
		try {
			const response = await runtime.process.client
				.request({ type: "get_state" }, 5_000)
				.catch(() => undefined);
			const isStreaming =
				response?.success &&
				Boolean((response.data as { isStreaming?: boolean } | undefined)?.isStreaming);
			if (!isStreaming) return; // pi 已停，无需升级
			if (
				this.agents.get(agentId)?.process !== abortedProcess ||
				this.getStreamGate(agentId).currentGeneration !== sealedGeneration
			) return;
			void this.appLogger?.warn("agent", "Abort escalation: pi still streaming after abort", {
				agentId,
			});
			await runtime.process.client
				.request({ type: "abort_bash" }, 5_000)
				.catch(() => undefined);
			if (
				this.agents.get(agentId)?.process !== abortedProcess ||
				this.getStreamGate(agentId).currentGeneration !== sealedGeneration
			) return;
			await runtime.process.client
				.request({ type: "abort" }, 5_000)
				.catch(() => undefined);
			// 第二轮验证：仍未停则通知用户，提示可重启会话。
			const verifyTimer = setTimeout(() => {
				void this.appLogger?.warn("agent", "Abort escalation: still running after second attempt", {
					agentId,
				});
				this.emit(ipcChannels.agentsNotice, {
					agentId,
					message: "停止响应较慢，可尝试重启会话",
					i18nKey: "app.abortSlow",
					kind: "warning",
					duration: 6000,
				});
			}, AgentManager.ABORT_ESCALATION_VERIFY_MS);
			verifyTimer.unref?.();
		} catch {
			// RPC 失败（进程退出等）不再升级；agent 生命周期由 exit 路径接管。
		}
	}

	private clearAbortSettledFallback(agentId: string) {
		const timer = this.abortSettledFallbackTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.abortSettledFallbackTimers.delete(agentId);
		}
	}

	/** 手动 compact 的 RPC reload 与 compaction_end 只允许一个路径负责历史刷新。 */
	private claimManualCompactionReload(agentId: string) {
		this.manualCompactionReloadClaims.add(agentId);
	}

	private consumeManualCompactionReloadClaim(agentId: string): boolean {
		return this.manualCompactionReloadClaims.delete(agentId);
	}

	/** 当前 generation 是否已封印，封印期间所有流式事件应丢弃。 */
	private isAgentStreamSealed(agentId: string): boolean {
		return isStreamGateSealed(this.getStreamGate(agentId));
	}

	/** agent 关闭/重建时清理 gate，避免泄漏到新生命周期。 */
	private clearStreamGate(agentId: string) {
		this.clearAbortSettledFallback(agentId);
		this.streamGates.delete(agentId);
		this.recentlyAborted.delete(agentId);
		this.thinkingEmitter.cancel(agentId);
		this.cancelMessageEmit(agentId);
	}

	/** 取消节流中的消息推送（不触发 emit），用于 abort/关闭时丢弃 pending 的旧内容。 */
	private cancelMessageEmit(agentId: string) {
		const timer = this.messageFlushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.messageFlushTimers.delete(agentId);
		}
		this.pendingMessageAgents.delete(agentId);
	}

	private scheduleMessageEmit(agentId: string, immediate = false) {
		if (immediate) {
			// 终态 immediate flush 永远全量：作为渲染层增量合并的天然校准点，
			// 丢弃的增量（长度不连续）由这里的全量纠正（message_end/tool 结束/加载完成）。
			this.messageDirtyFromByAgent.delete(agentId);
			this.flushMessageEmit(agentId);
			return;
		}
		if (this.pendingMessageAgents.has(agentId)) return;
		this.pendingMessageAgents.add(agentId);
		const timer = setTimeout(() => this.flushMessageEmit(agentId), AgentManager.MESSAGE_FLUSH_INTERVAL_MS);
		// 节流定时器不应阻止进程退出
		timer.unref?.();
		this.messageFlushTimers.set(agentId, timer);
	}

	private flushMessageEmit(agentId: string) {
		const timer = this.messageFlushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.messageFlushTimers.delete(agentId);
		}
		this.pendingMessageAgents.delete(agentId);
		const all = this.messages.get(agentId) ?? [];
		const dirtyFrom = this.messageDirtyFromByAgent.get(agentId);
		this.messageDirtyFromByAgent.delete(agentId);
		const windowStart = this.displayWindowStartByAgent.get(agentId) ?? 0;
		const payload = buildMessageFlushPayload(
			agentId,
			all,
			dirtyFrom,
			windowStart,
			this.sessionFileVersionByAgent.get(agentId),
			this.computeWindowStartFilePos(agentId, all, windowStart),
			this.preserveHistoryOnNextFlush.get(agentId) ?? true,
			this.stickyHistoryOnNextFlush.has(agentId),
		);
		// trim 窗口右移滑出的旧窗口头部轮次随全量 flush 下发（渲染层并入历史前缀）；
		// 增量 flush 不携带（新轮还在写），等终态全量校准。
		if (payload.upsertFrom === undefined) {
			this.preserveHistoryOnNextFlush.delete(agentId);
			this.stickyHistoryOnNextFlush.delete(agentId);
			const slideOut = this.pendingSlideOutByAgent.get(agentId);
			if (slideOut && slideOut.length > 0) {
				// 与窗口段同口径脱敏（删 tool result 大载荷），避免前缀持有未脱敏副本
				payload.slideOut = stripToolResultForDelivery(slideOut);
				this.pendingSlideOutByAgent.delete(agentId);
			}
		}
		this.emit(ipcChannels.agentsMessage, payload);
	}

	/** 只在 isStreaming 边沿写 Set 并推轻量补丁；热路径重复 add/delete 不再打 runtime。 */
	private setStreamingAgent(agentId: string, streaming: boolean) {
		const wasStreaming = this.streamingAgents.has(agentId);
		if (streaming) {
			if (wasStreaming) return;
			this.streamingAgents.add(agentId);
		} else {
			if (!wasStreaming) return;
			this.streamingAgents.delete(agentId);
		}
		this.emitStreamingStatePatch(agentId);
	}

	/** 轻量 runtime 状态补丁：只同步本地流式标志与工具执行状态，不发 RPC。 */
	private emitStreamingStatePatch(agentId: string) {
		this.emit(ipcChannels.agentsRuntimeState, {
			agentId,
			state: {
				isStreaming: this.streamingAgents.has(agentId),
				isExecutingTool: !!this.toolExecutingByAgent.get(agentId),
				executingToolName: this.toolExecutingByAgent.get(agentId) ?? undefined,
				toolStateSequence: this.toolStateSequenceByAgent.get(agentId) ?? 0,
			} as AgentRuntimeState,
		});
	}

	/** 标记 agent 消息数组自 index 起变脏（多次标记取最小值），供增量 flush 使用。 */
	private markMessagesDirtyFrom(agentId: string, index: number) {
		const prev = this.messageDirtyFromByAgent.get(agentId);
		if (prev === undefined || index < prev) {
			this.messageDirtyFromByAgent.set(agentId, Math.max(0, index));
		}
	}

	/**
	 * 运行期缓存裁剪：agent 一轮结束后把主进程消息数组裁到最近 N 轮。
	 * 现状 40 轮 trim 只在 loadMessages 时执行，长会话运行中消息会持续追加、数组无界增长；
	 * 这里在 agent_settled（及 get_state 兜底确认空闲）后统一裁剪，使 12 轮成为硬上限。
	 * 裁剪后重算激活显示窗口（尾部 3 轮）并全量 flush——头部整轮被裁，增量下标空间失效，
	 * 渲染层以窗口化全量校准（与 loadMessages 后的窗口协议一致）。
	 * 头部系统摘要卡片（compaction/branchSummary）不属于 user 轮次，会被 trim 切掉，
	 * 裁剪前先取出、裁剪后重新 prepend，保证「已压缩 N 次」卡片持续可见。
	 */
	private trimRuntimeCache(agentId: string) {
		const list = this.messages.get(agentId);
		if (!list || list.length === 0) return;
		const summaryCards = leadingSummaryCards(list, list.length);
		const trimmedStart = turnTrimStartIndex(list, AgentManager.MAX_RUNTIME_CACHE_TURNS);
		const trimmed = list.slice(trimmedStart);
		if (trimmed.length === list.length) return;
		// 卡片恒在数组最前（index 0），trim 保留尾部时必然被整体丢弃，重新 prepend 不会重复。
		const next = summaryCards.length > 0 ? [...summaryCards, ...trimmed] : trimmed;
		// 缓存头部在文件消息空间前移 = 被裁「角色消息」数（卡片/系统消息不计入文件消息空间，
		// 若按总长度递增会把 windowStartFilePos 数值游标整体推偏）。
		// headOffset=-1 表示匿名会话等无文件场景，数值游标不可用——保持 -1，不能递增成伪造游标。
		const prevHeadOffset = this.messageHeadOffsetByAgent.get(agentId) ?? 0;
		if (prevHeadOffset >= 0) {
			this.messageHeadOffsetByAgent.set(
				agentId,
				prevHeadOffset + countRoleMessagesBefore(list, trimmedStart),
			);
		}
		// 窗口前移的滑出轮：旧窗口（冻结于上次 loadMessages/trim）与新窗口（裁剪后尾部 3 轮）
		// 的头部会滑出窗口覆盖区；抓取 [oldWindowStart, 新窗口最旧轮次起点) 随全量 flush 下发，
		// 渲染层并入历史前缀——否则锚点轮从视口消失且翻页翻不回来（2026-12 回归修复）。
		const oldWindowStart = this.displayWindowStartByAgent.get(agentId) ?? 0;
		const newWindowStartInList = findTurnPageStart(
			list.map((m) => ({ role: m.role, byteLength: 0 })),
			list.length,
			AgentManager.DISPLAY_WINDOW_TURNS,
			Number.MAX_SAFE_INTEGER,
		);
		if (newWindowStartInList > oldWindowStart) {
			const slideOut = list.slice(oldWindowStart, newWindowStartInList);
			if (slideOut.length > 0) {
				// trim 窗口滑出轮登记到待发队列，随下一次全量 flush 下发给渲染层并入 history prefix。
				const pending = this.pendingSlideOutByAgent.get(agentId) ?? [];
				this.pendingSlideOutByAgent.set(agentId, [...pending, ...slideOut]);
			}
		}
		this.messages.set(agentId, next);
		this.displayWindowStartByAgent.set(
			agentId,
			findTurnPageStart(
				next.map((m) => ({ role: m.role, byteLength: 0 })),
				next.length,
				AgentManager.DISPLAY_WINDOW_TURNS,
				Number.MAX_SAFE_INTEGER,
			),
		);
		this.markMessagesDirtyFrom(agentId, 0);
		this.flushMessageEmit(agentId);
	}

	/** 节流推送 live 思考（done=false）；无段身份时丢弃。 */
	private emitThinkingNow(agentId: string, text: string) {
		const segment = this.thinkingSegmentByAgent.get(agentId);
		if (!segment) return;
		const lastSent = this.lastSentThinkingByAgent.get(agentId) ?? "";
		const pushCount = (this.thinkingPushCountByAgent.get(agentId) ?? 0) + 1;
		const sendFull = !text.startsWith(lastSent) || pushCount >= 50;
		const update: ThinkingUpdate = {
			agentId,
			id: segment.id,
			...(!sendFull
				? { delta: text.slice(lastSent.length) }
				: { text }),
			startedAt: segment.startedAt,
			endedAt: segment.endedAt,
			done: false,
		};
		this.lastSentThinkingByAgent.set(agentId, text);
		this.thinkingPushCountByAgent.set(agentId, sendFull ? 0 : pushCount);
		this.emit(ipcChannels.agentsThinking, update);
	}

	/**
	 * 从 message_update 的 partialMessage 提取累积正文；无法提取时返回 undefined，
	 * 调用方回退到「旧累积 + delta」拼接（兼容仅带 delta 的事件格式）。
	 */
	private extractStreamingText(agentId: string, partialMessage?: unknown): string | undefined {
		if (partialMessage && typeof partialMessage === "object") {
			const text = this.messageProjector.extractText((partialMessage as any).content);
			if (text) return text;
		}
		return undefined;
	}

	/** 推送独立流式正文通道（agents:text-stream），渲染层写入 streamingTextByIdAtom。
	 *  done=true 表示本轮回答结束（message_end），渲染层据此把 streaming 置 false。
	 *  热路径不再附带 runtime patch：isStreaming 只在 setStreamingAgent 边沿推送。 */
	private emitTextStreamNow(agentId: string, text: string, done = false) {
		const lastSent = this.lastSentTextByAgent.get(agentId) ?? "";
		const pushCount = (this.textPushCountByAgent.get(agentId) ?? 0) + 1;
		const sendFull = !text.startsWith(lastSent) || pushCount >= 50;
		const messageId = this.activeAssistantMessageIds.get(agentId);
		const payload: TextStreamUpdate = {
			agentId,
			...(messageId ? { messageId } : {}),
			...(!sendFull ? { delta: text.slice(lastSent.length) } : { text }),
			done,
		};
		this.lastSentTextByAgent.set(agentId, text);
		this.textPushCountByAgent.set(agentId, sendFull ? 0 : pushCount);
		if (done) {
			this.lastSentTextByAgent.delete(agentId);
			this.textPushCountByAgent.delete(agentId);
		}
		this.emit(ipcChannels.agentsTextStream, payload);
	}

	private emitState() {
		const tabs = this.list();
		this.emit(ipcChannels.agentsState, tabs);
	}

	private emit(channel: string, payload: unknown) {
		for (const listener of this.outputListeners) listener(channel, payload);
		this.sendToRenderer(channel, payload);
	}

	private emitLocalEvent(agentId: string, event: unknown, streamGeneration?: number) {
		const generation = streamGeneration ?? this.getStreamGate(agentId).currentGeneration;
		for (const listener of this.localEventListeners) {
			try { listener(agentId, event, generation); } catch {}
		}
	}
}

type AgentRuntime = {
	tab: AgentTab;
	process: PiProcess;
};
