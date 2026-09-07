import type {
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	I18nDescriptor,
	ImageContent,
	PiCommand,
	SendPromptInput,
	SendPromptResult,
	SendSessionPromptInput,
	SendSessionPromptResult,
	SessionCommandErrorCode,
	SessionCommandResult,
	SessionRecord,
	SessionRuntimeEvent,
	SessionRuntimeInfo,
	SessionRuntimeReplacement,
	SessionRuntimeTarget,
	SessionTargetedValue,
	SessionUiResponseInput,
	PendingUiRequestSnapshot,
} from "../../shared/types";
import { buildSessionOriginKey } from "../../shared/sessionIdentity";
import { normalizeAgentUiBatchQuestion } from "../../shared/askQuestion";
import type { SessionCatalogEntry } from "./SessionCatalog";

export interface SessionCatalogGateway {
	get(sessionId: string): SessionCatalogEntry | undefined;
	getRecord(sessionId: string): SessionRecord | undefined;
	update(
		sessionId: string,
		patch: {
			title?: string;
			model?: { provider: string; modelId: string };
			thinkingLevel?: string;
			updatedAt?: number;
		},
	): Promise<SessionCatalogEntry>;
	attachRuntime(input: {
		sessionId: string;
		filePath?: string;
		piSessionId?: string;
	}): Promise<unknown>;
}

export interface SessionAgentGateway {
	list(): AgentTab[];
	getMessages(agentId: string): ChatMessage[];
	isMessageCacheStale?(agentId: string): boolean;
	/** 本地流式/工具标志；缺省时 Web 只看 status。 */
	getLocalStreamingFlags?(agentId: string): {
		isStreaming: boolean;
		isExecutingTool: boolean;
	};
	create(input: CreateAgentInput): Promise<AgentTab>;
	restart(agentId: string): Promise<AgentTab>;
	stop(agentId: string): Promise<void>;
	rename(agentId: string, name: string): Promise<AgentTab>;
	abort(agentId: string): Promise<void>;
	compact(agentId: string, prompt?: string): Promise<AgentRuntimeState>;
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
	getCommands(agentId: string): Promise<unknown[]>;
	getAvailableModels(agentId: string): Promise<AvailableModel[]>;
	exportHtml(agentId: string): Promise<unknown>;
	editMessage(agentId: string, messageId: string, newText: string): Promise<void>;
	deleteMessage(agentId: string, messageId: string): Promise<void>;
	prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }>;
	setModel(agentId: string, provider: string, modelId: string): Promise<unknown>;
	setThinking(agentId: string, level: string): Promise<AgentRuntimeState>;
	/** 主动推送一次完整 runtime state（get_state）给渲染层：懒启动/重启链路在偏好应用后调用。 */
	publishRuntimeState(agentId: string): Promise<void>;
	/** 首条 prompt 后补取可能延迟创建的持久会话文件身份。 */
	refreshSessionIdentity(agentId: string): Promise<AgentTab>;
	/** AgentManager get_state 使用的启动/重连 RPC timeout，避免 Coordinator 维护第二套上限。 */
	getStartupTimeoutMs(): number;
	getForkMessages(agentId: string): Promise<Array<{ entryId: string; text: string }>>;
	forkSession(agentId: string, entryId: string): Promise<unknown>;
	sendUIResponse(
		agentId: string,
		requestId: string,
		response: SessionUiResponseInput["response"],
	): Promise<unknown> | unknown;
	/** 非聚焦会话收到 Ask 类 UI 请求时触发桌面通知（由 AgentManager 实现）
	 * 参数：agentId（去重/日志）、sessionId（点击跳转目标）、sessionTitle、question（提问内容，可空） */
	notifyAskPending(
		agentId: string,
		sessionId: string,
		sessionTitle: string,
		question: string,
	): void;
}

/**
 * 会话运行时业务日志接口（AppLogger 满足该签名）。
 * 会话全周期事件（激活/停止/重启/模型切换等）经此留痕，与性能日志（session-perf scope）区分；
 * 无实例时静默跳过（启动早期/测试环境）。
 */
export interface SessionRuntimeLogger {
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
	error(scope: string, message: string, detail?: unknown): unknown;
}

type DeliveryCacheEntry = {
	createdAt: number;
	settled: boolean;
	promise: Promise<SendSessionPromptResult>;
};

// 待回答的 UI 请求快照（Web/飞书轮询用）。契约统一走 shared/types（含
// batchQuestions/batchReview），Web 与主进程共用一份，避免两侧各维护一套。
type PendingUiRequest = PendingUiRequestSnapshot;

export type SessionRuntimeBinding = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

type RuntimeReplacement = SessionRuntimeBinding & {
	replacementId: number;
};

type DispatchLease = SessionRuntimeBinding & {
	leaseId: number;
};

class SessionRuntimeCommandError extends Error {
	constructor(
		readonly code: SessionCommandErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SessionRuntimeCommandError";
	}
}

const DELIVERY_CACHE_TTL_MS = 10 * 60_000;
const DELIVERY_CACHE_MAX_ENTRIES = 500;
/** 轮询间隔之外的少量余量，避免刚过 RPC deadline 就误杀仍在收尾的启动流程。 */
const AGENT_READY_POLLING_GRACE_MS = 1_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTerminalAgent(tab: AgentTab): boolean {
	return tab.status === "error" || tab.status === "closed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteractiveUiMethod(method: unknown): boolean {
	return method === "select" ||
		method === "confirm" ||
		method === "input" ||
		method === "editor" ||
		method === "batch_ask";
}

export class SessionRuntimeCoordinator {
	private readonly activationBySession = new Map<string, Promise<AgentTab>>();
	private readonly deliveryByRequest = new Map<string, DeliveryCacheEntry>();
	private readonly agentIdBySession = new Map<string, string>();
	private readonly sessionIdByAgent = new Map<string, string>();
	private readonly generationBySession = new Map<string, number>();
	private readonly pendingUiRequests = new Map<string, PendingUiRequest>();
	private readonly replacementByAgent = new Map<string, RuntimeReplacement>();
	private readonly replacementBySession = new Map<string, RuntimeReplacement>();
	private readonly dispatchLeasesByAgent = new Map<string, Set<DispatchLease>>();
	private readonly dispatchLeasesBySession = new Map<string, Set<DispatchLease>>();
	private readonly historyMutationTails = new Map<string, Promise<void>>();
	private replacementSequence = 0;
	private dispatchLeaseSequence = 0;
	/** 渲染层当前聚焦的会话 id；为 undefined 时视为全部会话都需要通知 */
	private focusedSessionId: string | undefined = undefined;

	constructor(
		private readonly catalog: SessionCatalogGateway,
		private readonly agents: SessionAgentGateway,
		private readonly sendAgentPrompt: (input: SendPromptInput) => Promise<SendPromptResult>,
		private readonly logger?: SessionRuntimeLogger,
	) {}

	/** 渲染层在 currentSessionId 变化时汇报聚焦会话（见 sessions:set-focused-session IPC）。 */
	setFocusedSession(sessionId: string | undefined): void {
		this.focusedSessionId = sessionId;
		// 聚焦切换高频发生（点列表即触发），用 debug 级别避免刷屏
		void this.logger?.info("session-runtime", "Focused session changed", { sessionId });
	}

	getFocusedSession(): string | undefined {
		return this.focusedSessionId;
	}

	send(input: SendSessionPromptInput): Promise<SendSessionPromptResult> {
		const sessionId = input.sessionId.trim();
		const requestId = input.requestId.trim();
		if (!sessionId) return Promise.resolve(this.rejected(input, "Session ID is required"));
		if (!requestId) return Promise.resolve(this.rejected(input, "Request ID is required"));
		// 静默扩展命令允许 message 为空、由 agentMessage 驱动（如顶栏上下文开关）。
		const hasSilentCommand = Boolean(input.silent && input.agentMessage?.trim());
		if (!input.message.trim() && !input.images?.length && !hasSilentCommand) {
			return Promise.resolve(this.rejected(input, "消息不能为空", {
				i18nKey: "diagnostic.messageRequired",
			}));
		}

		this.pruneDeliveryCache();
		const cacheKey = `${sessionId}\u0000${requestId}`;
		const existing = this.deliveryByRequest.get(cacheKey);
		if (existing) return existing.promise;

		const cacheEntry: DeliveryCacheEntry = {
			createdAt: Date.now(),
			settled: false,
			promise: Promise.resolve(this.rejected(input, "Request was not started")),
		};
		cacheEntry.promise = this.sendOnce({ ...input, sessionId, requestId })
			.finally(() => {
				cacheEntry.settled = true;
			});
		this.deliveryByRequest.set(cacheKey, cacheEntry);
		return cacheEntry.promise;
	}

	getAgentId(sessionId: string): string | undefined {
		const agentId = this.agentIdBySession.get(sessionId);
		if (!agentId) return undefined;
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (tab && !isTerminalAgent(tab)) return agentId;
		// A terminal process cannot safely receive a delayed prompt result. Remove
		// the binding even if its dispatch lease has not unwound yet, which makes
		// that result fail closed instead of reviving a dead runtime association.
		this.unbindTerminalAgent(agentId);
		return undefined;
	}

	getSessionId(agentId: string): string | undefined {
		return this.sessionIdByAgent.get(agentId);
	}

	/**
	 * 进程监控用：按 agentId 反查会话身份（sessionId + 标题）。
	 * 标题取 catalog 条目，供监控表直接展示「是哪个会话」；
	 * 无绑定或 catalog 无记录时返回 undefined（匿名/终端 agent 不关联会话）。
	 */
	getSessionInfoForAgent(
		agentId: string,
	): { sessionId: string; sessionTitle?: string } | undefined {
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (!sessionId) return undefined;
		const entry = this.catalog.get(sessionId);
		return { sessionId, sessionTitle: entry?.title };
	}

	listRuntimes(): SessionRuntimeInfo[] {
		const result: SessionRuntimeInfo[] = [];
		for (const [sessionId, agentId] of this.agentIdBySession) {
			const tab = this.agents.list().find((candidate) => candidate.id === agentId);
			if (!tab || isTerminalAgent(tab)) continue;
			result.push(this.runtimeInfo(sessionId, tab));
		}
		return result.sort((left, right) => right.createdAt - left.createdAt);
	}

	getTarget(sessionId: string): SessionRuntimeTarget | undefined {
		const agentId = this.getAgentId(sessionId);
		if (!agentId) return undefined;
		const binding = this.getRuntimeBinding(agentId);
		if (!binding || binding.sessionId !== sessionId) return undefined;
		return { sessionId, agentId, runtimeGeneration: binding.runtimeGeneration };
	}

	/** A pending activation owns the Session even before AgentManager binding completes. */
	isActivating(sessionId: string): boolean {
		return this.activationBySession.has(sessionId);
	}

	getRuntimeMessages(sessionId: string): SessionTargetedValue<ChatMessage[]> | undefined {
		const target = this.getTarget(sessionId);
		if (!target) return undefined;
		if (this.agents.isMessageCacheStale?.(target.agentId)) return undefined;
		const messages = this.agents.getMessages(target.agentId);
		// Message reads are synchronous, but the gateway can re-enter coordinator code.
		// Revalidate after the read so an A -> B replacement cannot label A's messages as B's Session state.
		if (!this.validateTarget(target).ok) return undefined;
		return { target, value: messages };
	}

	async activateRuntime(
		sessionId: string,
	): Promise<SessionCommandResult<SessionRuntimeInfo>> {
		try {
			const tab = await this.ensureRuntime(sessionId);
			void this.logger?.info("session-runtime", "Runtime activated", {
				sessionId,
				agentId: tab.id,
				status: tab.status,
			});
			return { ok: true, value: this.runtimeInfo(sessionId, tab) };
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	/**
	 * An anonymous record already has a process created with `--no-session`.
	 * Bind it directly instead of routing it through normal activation, which
	 * would otherwise create a second runtime and a persisted pi session.
	 */
	bindAnonymousRuntime(sessionId: string, agentId: string): SessionRuntimeInfo {
		const entry = this.catalog.get(sessionId);
		if (!entry?.noSession) throw new Error(`Anonymous session not found: ${sessionId}`);
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (!tab?.noSession || isTerminalAgent(tab)) {
			throw new Error(`Anonymous runtime is not available: ${agentId}`);
		}
		const runtimeGeneration = this.bind(sessionId, agentId);
		tab.runtimeGeneration = runtimeGeneration;
		void this.logger?.info("session-runtime", "Anonymous runtime bound", {
			sessionId,
			agentId,
			runtimeGeneration,
		});
		return this.runtimeInfo(sessionId, tab);
	}

	validateTarget(target: SessionRuntimeTarget): SessionCommandResult<SessionRuntimeTarget> {
		try {
			this.requireTarget(target);
			return { ok: true, value: target };
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	renameRuntime(
		target: SessionRuntimeTarget,
		name: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentTab>>> {
		return this.runTargetCommand(target, async (agentId) => {
			const result = await this.agents.rename(agentId, name);
			void this.logger?.info("session-runtime", "Runtime renamed", {
				sessionId: target.sessionId,
				agentId,
				name,
			});
			return result;
		});
	}

	abortRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.abort(agentId));
	}

	compactRuntime(
		target: SessionRuntimeTarget,
		prompt?: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.compact(agentId, prompt));
	}

	getRuntimeState(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.getRuntimeState(agentId));
	}

	listRuntimeCommands(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<PiCommand[]>>> {
		return this.runTargetCommand(target, async (agentId) => (
			await this.agents.getCommands(agentId) as PiCommand[]
		));
	}

	listRuntimeModels(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<AvailableModel[]>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.getAvailableModels(agentId));
	}

	exportRuntimeHtml(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<unknown>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.exportHtml(agentId));
	}

	editRuntimeMessage(
		target: SessionRuntimeTarget,
		messageId: string,
		newText: string,
	): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runHistoryMutationCommand(
			target,
			(agentId) => this.agents.editMessage(agentId, messageId, newText),
		);
	}

	deleteRuntimeMessage(
		target: SessionRuntimeTarget,
		messageId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runHistoryMutationCommand(
			target,
			(agentId) => this.agents.deleteMessage(agentId, messageId),
		);
	}

	prepareRuntimeResend(
		target: SessionRuntimeTarget,
		messageId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<{ text: string; images?: ImageContent[] }>>> {
		return this.runHistoryMutationCommand(
			target,
			(agentId) => this.agents.prepareResendFromMessage(agentId, messageId),
		);
	}

	/** 列出可 fork 的用户消息 entryId（供 UI 在 meta.entryId 缺失时回退匹配）。 */
	getRuntimeForkMessages(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<Array<{ entryId: string; text: string }>>>> {
		return this.runTargetCommand(
			target,
			(agentId) => this.agents.getForkMessages(agentId),
		);
	}

	/** 按 entryId 执行 pi /fork；成功后调用方需走 replaceAgentSession 刷新绑定。 */
	forkRuntimeSession(
		target: SessionRuntimeTarget,
		entryId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<unknown>>> {
		return this.runTargetCommand(
			target,
			(agentId) => this.agents.forkSession(agentId, entryId),
		);
	}

	setRuntimeModel(
		target: SessionRuntimeTarget,
		provider: string,
		modelId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 先调运行中 Agent；成功后再写 catalog。
			// 若先写后失败：用户点「取消重启」时 catalog 已是新模型，下次启动会误套上；
			// 且 ConfirmDialog 点确定也会走 onCancel，回滚与确认会互相踩。
			// needsRestart 由渲染层在用户确认后再 updateRecord + 重启。
			await this.agents.setModel(agentId, provider, modelId);
			await this.catalog.update(target.sessionId, {
				model: { provider, modelId },
				updatedAt: Date.now(),
			});
			void this.logger?.info("session-runtime", "Runtime model changed", {
				sessionId: target.sessionId,
				agentId,
				provider,
				modelId,
			});
			return this.agents.getRuntimeState(agentId);
		});
	}

	setRuntimeThinking(
		target: SessionRuntimeTarget,
		level: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, async (agentId) => {
			const state = await this.agents.setThinking(agentId, level);
			const effectiveLevel = state.thinkingLevel ?? level;
			await this.catalog.update(target.sessionId, {
				thinkingLevel: effectiveLevel,
				updatedAt: Date.now(),
			});
			void this.logger?.info("session-runtime", "Runtime thinking changed", {
				sessionId: target.sessionId,
				agentId,
				requestedLevel: level,
				effectiveLevel,
			});
			return state;
		});
	}

	async stopRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionRuntimeTarget>> {
		let reservation: RuntimeReplacement | undefined;
		try {
			this.requireTarget(target);
			reservation = this.reserveBoundRuntime(target.sessionId, target.agentId);
			await this.agents.stop(target.agentId);
			this.requireCurrentReservation(reservation);
			this.releaseRuntimeReplacement(reservation);
			reservation = undefined;
			this.unbindAgentUnchecked(target.agentId);
			void this.logger?.info("session-runtime", "Runtime stopped", {
				sessionId: target.sessionId,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			});
			return { ok: true, value: target };
		} catch (error) {
			return this.commandFailure(error);
		} finally {
			if (reservation && this.replacementByAgent.get(target.agentId) === reservation) {
				this.releaseRuntimeReplacement(reservation);
			}
		}
	}

	/**
	 * 按 agentId 停止 agent（进程监控「停止」入口用，调用方只有 agentId）。
	 * 通过 sessionIdByAgent 反查会话并构造完整 target，复用 stopRuntime 的
	 * 保留/解绑收尾，确保会话运行时状态同步；无会话绑定（游离 agent）时幂等直停。
	 */
	async stopAgentById(
		agentId: string,
	): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>> {
		try {
			const binding = this.getRuntimeBinding(agentId);
			if (!binding) {
				await this.agents.stop(agentId);
				void this.logger?.info("session-runtime", "Agent stopped (unbound)", { agentId });
				return { ok: true, value: undefined };
			}
			const target: SessionRuntimeTarget = {
				sessionId: binding.sessionId,
				agentId,
				runtimeGeneration: binding.runtimeGeneration,
			};
			return await this.stopRuntime(target);
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	async restartRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionRuntimeReplacement>> {
		try {
			this.requireTarget(target);
			const tab = await this.restartSession(target.sessionId, target.agentId);
			const session = this.catalog.getRecord(target.sessionId);
			if (!session) {
				throw new SessionRuntimeCommandError("SESSION_NOT_FOUND", "Session no longer exists");
			}
			void this.logger?.info("session-runtime", "Runtime restarted", {
				sessionId: target.sessionId,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			});
			return {
				ok: true,
				value: {
					previousTarget: target,
					runtime: this.runtimeInfo(target.sessionId, tab),
					session: { ...session },
				},
			};
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	bindExistingAgent(sessionId: string, agentId: string): number {
		if (!this.catalog.get(sessionId)) throw new Error(`Session not found: ${sessionId}`);
		return this.bind(sessionId, agentId);
	}

	attachCatalogRuntimes(records: SessionRecord[]): Array<{
		sessionId: string;
		agentId: string;
		runtimeGeneration: number;
	}> {
		const bindings: Array<{
			sessionId: string;
			agentId: string;
			runtimeGeneration: number;
		}> = [];
		const availableAgents = this.agents.list().filter((tab) => (
			!isTerminalAgent(tab) &&
			!this.replacementByAgent.has(tab.id) &&
			!this.hasDispatchLease(undefined, tab.id)
		));
		for (const record of records) {
			if (
				!record.filePath ||
				this.replacementBySession.has(record.id) ||
				this.hasDispatchLease(record.id)
			) continue;
			const target = buildSessionOriginKey({
				source: record.source,
				environment: record.environment,
				filePath: record.filePath,
				wslDistro: record.wslDistro,
				wslUser: record.wslUser,
				importedSourceId: record.importedSourceId,
			});
			const tab = availableAgents.find((candidate) => (
				candidate.projectId === record.projectId &&
				candidate.sessionPath &&
				buildSessionOriginKey({
					source: candidate.sessionSource ?? "pi",
					environment: candidate.sessionEnvironment ?? "native",
					filePath: candidate.sessionPath,
					wslDistro: candidate.wslDistro,
					wslUser: candidate.wslUser,
					importedSourceId: candidate.importedSourceId,
				}) === target
			));
			if (!tab) continue;
			bindings.push({
				sessionId: record.id,
				agentId: tab.id,
				runtimeGeneration: this.bind(record.id, tab.id),
			});
		}
		return bindings;
	}

	observeRuntimeEvent(event: SessionRuntimeEvent): void {
		const binding = this.getRuntimeBinding(event.agentId);
		if (
			!binding ||
			binding.sessionId !== event.sessionId ||
			binding.runtimeGeneration !== event.runtimeGeneration ||
			event.sourceChannel !== "agents:ui-request" ||
			!isRecord(event.payload)
		) {
			return;
		}
		const requestId = typeof event.payload.requestId === "string"
			? event.payload.requestId.trim()
			: "";
		if (!requestId) return;
		const key = this.uiRequestKey(event.sessionId, requestId);
		if (event.payload.completed === true) {
			this.pendingUiRequests.delete(key);
			return;
		}
		if (!isInteractiveUiMethod(event.payload.method)) return;
		const options = Array.isArray(event.payload.options)
			? event.payload.options.filter((option): option is string => typeof option === "string")
			: undefined;
		// batch_ask 的完整表单（逐题渲染/评审）随快照下发给 Web/飞书；
		// 逐题走共享 normalizer（shared/askQuestion）收窄：坏数据最多退化成少几题，
		// 不崩轮询；选项里的 null/数字也被过滤，渲染层读 option.label 不会炸。
		const batchQuestions = Array.isArray(event.payload.batchQuestions)
			? event.payload.batchQuestions
					.map((question) => normalizeAgentUiBatchQuestion(question))
					.filter((question): question is NonNullable<typeof question> => question !== undefined)
			: undefined;
		this.pendingUiRequests.set(key, {
			sessionId: event.sessionId,
			agentId: event.agentId,
			runtimeGeneration: event.runtimeGeneration,
			requestId,
			method: String(event.payload.method),
			title: typeof event.payload.title === "string" ? event.payload.title : "",
			options,
			placeholder: typeof event.payload.placeholder === "string" ? event.payload.placeholder : undefined,
			prefill: typeof event.payload.prefill === "string" ? event.payload.prefill : undefined,
			allowOther: event.payload.allowOther === true,
			...(batchQuestions && batchQuestions.length > 0 ? { batchQuestions } : {}),
			...(event.payload.batchReview === true ? { batchReview: true } : {}),
		});

		// 非聚焦会话收到 Ask 类请求时触发桌面通知：用户切到别的会话时
		// 也能第一时间知道另一个会话需要确认，不用手动切回去才发现。
		if (this.focusedSessionId !== event.sessionId) {
			const title = this.catalog.get(event.sessionId)?.title
				?? this.catalog.getRecord(event.sessionId)?.title
				?? "";
			// 带 agentId（每轮去重）、sessionId（点击跳转）与提问内容（展示在通知气泡里）
			const question = typeof event.payload.title === "string" ? event.payload.title : "";
			this.agents.notifyAskPending(event.agentId, event.sessionId, title, question);
		}
	}

	/** Web / 飞书以外的只读快照：手机端轮询后渲染确认卡片。 */
	listPendingUiRequests(sessionId?: string): PendingUiRequestSnapshot[] {
		const items: PendingUiRequestSnapshot[] = [];
		for (const pending of this.pendingUiRequests.values()) {
			if (sessionId && pending.sessionId !== sessionId) continue;
			items.push({ ...pending });
		}
		return items;
	}

	async respondToUi(input: SessionUiResponseInput): Promise<void> {
		const binding = this.getRuntimeBinding(input.agentId);
		if (
			!binding ||
			binding.sessionId !== input.sessionId ||
			binding.runtimeGeneration !== input.runtimeGeneration ||
			this.agentIdBySession.get(input.sessionId) !== input.agentId
		) {
			throw new Error("Session runtime binding changed before UI response");
		}
		const key = this.uiRequestKey(input.sessionId, input.requestId);
		const pending = this.pendingUiRequests.get(key);
		if (
			!pending ||
			pending.agentId !== input.agentId ||
			pending.runtimeGeneration !== input.runtimeGeneration
		) {
			throw new Error("Session UI request is not pending");
		}
		this.pendingUiRequests.delete(key);
		try {
			await this.agents.sendUIResponse(input.agentId, input.requestId, input.response);
		} catch (error) {
			this.pendingUiRequests.set(key, pending);
			throw error;
		}
	}

	getRuntimeBinding(agentId: string): {
		sessionId: string;
		runtimeGeneration: number;
	} | undefined {
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (!sessionId || this.agentIdBySession.get(sessionId) !== agentId) return undefined;
		return {
			sessionId,
			runtimeGeneration: this.generationBySession.get(sessionId) ?? 0,
		};
	}

	async replaceBoundRuntime<T extends { cancelled?: boolean }>(input: {
		agentId: string;
		replace: () => Promise<T>;
		resolveTargetSessionId: (result: T) => Promise<string>;
		canRestoreOrigin: () => boolean;
		onDetached: (binding: SessionRuntimeBinding) => void;
		onAttached: (binding: SessionRuntimeBinding) => void;
		onRestored: (binding: SessionRuntimeBinding) => void;
	}): Promise<T & { targetSessionId?: string }> {
		const replacement = this.beginRuntimeReplacement(input.agentId);
		if (!replacement) return input.replace();

		try {
			input.onDetached(replacement);
			const result = await input.replace();
			if (result.cancelled) {
				const restored = this.restoreRuntimeReplacement(replacement);
				input.onRestored(restored);
				return result;
			}
			const targetSessionId = await input.resolveTargetSessionId(result);
			const attached = this.completeRuntimeReplacement(replacement, targetSessionId);
			// The target binding is committed before observers run. Snapshot failures
			// must not roll the agent back onto the detached origin Session.
			input.onAttached(attached);
			return { ...result, targetSessionId };
		} catch (error) {
			if (this.replacementByAgent.get(input.agentId) === replacement) {
				let canRestoreOrigin = false;
				try {
					canRestoreOrigin = input.canRestoreOrigin();
				} catch {
					// An unprovable runtime identity is handled fail-closed.
				}
				if (canRestoreOrigin) {
					const restored = this.restoreRuntimeReplacement(replacement);
					input.onRestored(restored);
				} else {
					this.failClosedRuntimeReplacement(replacement);
				}
			}
			throw error;
		}
	}

	unbindAgent(agentId: string): void {
		this.assertNoDispatchLease(undefined, agentId);
		this.unbindAgentUnchecked(agentId);
	}

	/** Fail closed after a process reaches a terminal state, including mid-dispatch. */
	unbindTerminalAgent(agentId: string): void {
		this.unbindAgentUnchecked(agentId);
	}

	private unbindAgentUnchecked(agentId: string): void {
		const replacement = this.replacementByAgent.get(agentId);
		if (replacement) this.releaseRuntimeReplacement(replacement);
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (sessionId) {
			this.agentIdBySession.delete(sessionId);
			this.clearPendingUiRequests(sessionId, agentId);
		}
		this.sessionIdByAgent.delete(agentId);
	}

	async restartSession(sessionId: string, agentId: string): Promise<AgentTab> {
		const entry = this.catalog.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		const mappedAgentId = this.getAgentId(sessionId);
		if (mappedAgentId && mappedAgentId !== agentId) {
			throw new Error("Session runtime changed before restart");
		}

		const reservation = this.reserveBoundRuntime(sessionId, agentId);
		try {
			let tab = await this.agents.restart(agentId);
			if (tab.status === "starting") tab = await this.waitUntilReady(tab);
			if (isTerminalAgent(tab)) {
				this.unbindAgentUnchecked(agentId);
				throw new Error(`Failed to restart session runtime (${tab.status})`);
			}
			try {
				await this.applyPreferences(entry, tab.id);
			} catch (error) {
				await this.agents.stop(tab.id).catch(() => undefined);
				this.unbindAgentUnchecked(agentId);
				throw new Error(`Failed to apply session preferences: ${errorMessage(error)}`);
			}

			this.requireCurrentReservation(reservation);
			this.releaseRuntimeReplacement(reservation);
			this.unbindAgentUnchecked(agentId);
			const runtimeGeneration = this.bind(sessionId, tab.id);
			tab.runtimeGeneration = runtimeGeneration;
			if (tab.sessionPath && !entry.noSession) {
				await this.catalog.attachRuntime({
					sessionId,
					filePath: tab.sessionPath,
					piSessionId: tab.sessionId,
				});
			}
			// 与 activate 同链路：绑定完成后推送完整 runtime state，渲染层底栏即时反映真实模型。
			await this.agents.publishRuntimeState(tab.id).catch(() => undefined);
			return tab;
		} finally {
			if (this.replacementByAgent.get(agentId) === reservation) {
				this.releaseRuntimeReplacement(reservation);
			}
		}
	}

	private async sendOnce(input: SendSessionPromptInput): Promise<SendSessionPromptResult> {
		const pipelineStartedAt = Date.now();
		void this.logger?.info("session-perf", "Prompt pipeline started", {
			sessionId: input.sessionId,
			requestId: input.requestId,
		});
		let tab: AgentTab;
		try {
			void this.logger?.info("session-perf", "Runtime activation started", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
			tab = await this.ensureRuntime(input.sessionId);
			void this.logger?.info("session-perf", "Runtime activation completed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: tab.id,
				activationMs: Date.now() - pipelineStartedAt,
			});
		} catch (error) {
			return this.rejected(input, errorMessage(error));
		}

		let lease: DispatchLease;
		try {
			lease = this.acquireDispatchLease(input.sessionId, tab.id);
		} catch (error) {
			return this.rejected(input, errorMessage(error));
		}

		try {
			if (!this.isCurrentDispatchLease(lease)) {
				return this.unknownDelivery(input, "Session runtime binding changed before prompt dispatch");
			}

			let result: SendPromptResult;
			const dispatchStartedAt = Date.now();
			void this.logger?.info("session-perf", "Prompt dispatch started", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: lease.agentId,
			});
			try {
				result = await this.sendAgentPrompt({
					agentId: lease.agentId,
					message: input.message,
					images: input.images,
					streamingBehavior: input.streamingBehavior,
					agentMessage: input.agentMessage,
					description: input.description,
					requestId: input.requestId,
					silent: input.silent,
				});
				void this.logger?.info("session-perf", "Prompt dispatch completed", {
					sessionId: input.sessionId,
					requestId: input.requestId,
					agentId: lease.agentId,
					accepted: result.accepted,
					dispatchMs: Date.now() - dispatchStartedAt,
				});
			} catch (error) {
				result = {
					accepted: false,
					error: errorMessage(error),
					delivery: "unknown",
				};
			}
			if (!this.isCurrentDispatchLease(lease)) {
				return this.unknownDelivery(input, "Session runtime binding changed during prompt dispatch");
			}
			const currentTab = this.agents.list().find((candidate) => (
				candidate.id === lease.agentId && !isTerminalAgent(candidate)
			));
			if (!currentTab) {
				return this.unknownDelivery(input, "Session runtime stopped during prompt dispatch");
			}
			const noSession = this.catalog.get(input.sessionId)?.noSession;
			if (currentTab.sessionPath && !noSession) {
				// Prompt acceptance is the latency-sensitive boundary. Catalog persistence is
				// recovery metadata and must not keep the composer in a sending state; failures
				// are intentionally isolated from the already accepted prompt.
				void this.catalog.attachRuntime({
					sessionId: input.sessionId,
					filePath: currentTab.sessionPath,
					piSessionId: currentTab.sessionId,
				}).catch(() => undefined);
			} else if (result.accepted && !noSession) {
				// Some Pi-compatible runtimes create their JSONL shortly after accepting the
				// first prompt. Resolve it in the background, then attach the original draft
				// Session so SessionCatalog can fold any scanner-created duplicate into it.
				void this.attachDelayedSessionIdentity(lease).catch(() => undefined);
			}
			if (!this.isCurrentDispatchLease(lease)) {
				return this.unknownDelivery(input, "Session runtime binding changed after prompt dispatch");
			}
			return {
				...result,
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: lease.agentId,
				sessionPath: currentTab.sessionPath,
				runtimeGeneration: lease.runtimeGeneration,
			};
		} finally {
			this.releaseDispatchLease(lease);
		}
	}

	private async attachDelayedSessionIdentity(lease: DispatchLease): Promise<void> {
		const tab = await this.agents.refreshSessionIdentity(lease.agentId);
		const binding = this.getRuntimeBinding(lease.agentId);
		if (
			!tab.sessionPath ||
			tab.noSession ||
			!binding ||
			binding.sessionId !== lease.sessionId ||
			binding.runtimeGeneration !== lease.runtimeGeneration ||
			this.agentIdBySession.get(lease.sessionId) !== lease.agentId
		) return;
		await this.catalog.attachRuntime({
			sessionId: lease.sessionId,
			filePath: tab.sessionPath,
			piSessionId: tab.sessionId,
		});
	}

	private ensureRuntime(sessionId: string): Promise<AgentTab> {
		const existing = this.activationBySession.get(sessionId);
		if (existing) return existing;
		const activation = this.activate(sessionId).finally(() => {
			this.activationBySession.delete(sessionId);
		});
		this.activationBySession.set(sessionId, activation);
		return activation;
	}

	private async activate(sessionId: string): Promise<AgentTab> {
		const entry = this.catalog.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		if (this.replacementBySession.has(sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${sessionId}`);
		}

		const mappedAgentId = this.getAgentId(sessionId);
		if (mappedAgentId) {
			const mappedTab = this.agents.list().find((candidate) => candidate.id === mappedAgentId);
			if (mappedTab) return this.waitUntilReady(mappedTab);
		}

		let tab = entry.filePath ? this.findAgentBySessionPath(entry) : undefined;
		if (tab && isTerminalAgent(tab)) {
			await this.agents.stop(tab.id);
			tab = undefined;
		}
		if (tab?.status === "starting") tab = await this.waitUntilReady(tab);

		const created = !tab;
		if (!tab) {
			// deckSessionId = catalog 会话身份（SessionRecord.id），与 UI 保存安全等级覆盖用的 key 同源，
			// 确保扩展按 PIDECK_SESSION_ID 能命中 sessionLevels（历史扫描会话为文件路径，新会话为 UUID）。
			tab = await this.agents.create({
				projectId: entry.projectId,
				title: entry.title,
				deckSessionId: sessionId,
				sessionPath: entry.filePath,
				environment: entry.environment,
				source: entry.source,
				wslDistro: entry.wslDistro,
				wslUser: entry.wslUser,
				importedSourceId: entry.importedSourceId,
				noSession: entry.noSession,
			});
		}
		if (tab.status === "starting") tab = await this.waitUntilReady(tab);
		if (isTerminalAgent(tab)) {
			if (created) await this.agents.stop(tab.id).catch(() => undefined);
			throw this.startupFailure(tab);
		}

		try {
			await this.applyPreferences(entry, tab.id);
		} catch (error) {
			if (created) await this.agents.stop(tab.id).catch(() => undefined);
			throw new Error(`Failed to apply session preferences: ${errorMessage(error)}`);
		}

		const runtimeGeneration = this.bind(sessionId, tab.id);
		tab.runtimeGeneration = runtimeGeneration;
		if (tab.sessionPath && !entry.noSession) {
			await this.catalog.attachRuntime({
				sessionId,
				filePath: tab.sessionPath,
				piSessionId: tab.sessionId,
			});
		}
		// 绑定完成后主动推送完整 runtime state：emitSessionRuntimeEvent 依赖 binding 才转发，
		// 且在偏好应用（setModel/setThinking）之后执行，渲染层底栏拿到的是真实模型而不是旧残留。
		await this.agents.publishRuntimeState(tab.id).catch(() => undefined);
		return tab;
	}

	private findAgentBySessionPath(entry: SessionCatalogEntry): AgentTab | undefined {
		if (!entry.filePath) return undefined;
		const target = buildSessionOriginKey({
			source: entry.source,
			environment: entry.environment,
			filePath: entry.filePath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
			importedSourceId: entry.importedSourceId,
		});
		return this.agents.list().find((tab) => (
			!this.replacementByAgent.has(tab.id) &&
			tab.sessionPath &&
			buildSessionOriginKey({
				source: tab.sessionSource ?? "pi",
				environment: tab.sessionEnvironment ?? "native",
				filePath: tab.sessionPath,
				wslDistro: tab.wslDistro,
				wslUser: tab.wslUser,
				importedSourceId: tab.importedSourceId,
			}) === target
		));
	}

	private async applyPreferences(
		entry: SessionCatalogEntry,
		agentId: string,
	): Promise<void> {
		if (entry.model) {
			await this.agents.setModel(agentId, entry.model.provider, entry.model.modelId);
		}
		if (entry.thinkingLevel) {
			const state = await this.agents.setThinking(agentId, entry.thinkingLevel);
			if (state.thinkingLevel && state.thinkingLevel !== entry.thinkingLevel) {
				await this.catalog.update(entry.id, {
					thinkingLevel: state.thinkingLevel,
					updatedAt: Date.now(),
				});
			}
		}
	}

	private async waitUntilReady(initialTab: AgentTab): Promise<AgentTab> {
		let tab = initialTab;
		try {
			const startedAt = Date.now();
			const startupTimeoutMs = this.agents.getStartupTimeoutMs() + AGENT_READY_POLLING_GRACE_MS;
			while (tab.status === "starting") {
				if (Date.now() - startedAt >= startupTimeoutMs) {
					throw new Error("Timed out while starting session runtime");
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
				const current = this.agents.list().find((candidate) => candidate.id === tab.id);
				if (!current) throw new Error("Session runtime stopped while starting");
				tab = current;
			}
			if (isTerminalAgent(tab)) {
				throw this.startupFailure(tab);
			}
			return tab;
		} catch (error) {
			// A starting runtime that times out (or reaches a terminal state while
			// being polled) must not remain discoverable by sessionPath on retry.
			// Otherwise every later send waits on the same dead runtime forever.
			if (tab.status === "starting" || isTerminalAgent(tab)) {
				await this.agents.stop(initialTab.id).catch(() => undefined);
				this.unbindAgentUnchecked(initialTab.id);
			}
			throw error;
		}
	}

	/** 保留 pi 启动阶段的 stderr/路径等诊断，避免 Web 端只能看到无意义的 status。 */
	private startupFailure(tab: AgentTab): Error {
		try {
			const diagnostic = [...this.agents.getMessages(tab.id)]
				.reverse()
				.find((message) => message.role === "error");
			const debugDetails = diagnostic?.meta?.debugDetails;
			if (typeof debugDetails === "string" && debugDetails.trim()) {
				return new Error(debugDetails);
			}
			if (diagnostic?.text?.trim()) return new Error(diagnostic.text);
		} catch {
			// 诊断读取失败不能覆盖原始启动状态；下面返回稳定的兜底错误。
		}
		return new Error(`Failed to start session runtime (${tab.status})`);
	}

	private bind(sessionId: string, agentId: string): number {
		this.assertNoDispatchLease(sessionId, agentId);
		if (this.replacementByAgent.has(agentId)) {
			throw new Error(`Session runtime replacement already in progress: ${agentId}`);
		}
		if (this.replacementBySession.has(sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${sessionId}`);
		}
		const previousAgentId = this.agentIdBySession.get(sessionId);
		if (
			previousAgentId === agentId &&
			this.sessionIdByAgent.get(agentId) === sessionId
		) {
			return this.generationBySession.get(sessionId) ?? 0;
		}
		if (previousAgentId && previousAgentId !== agentId) {
			this.sessionIdByAgent.delete(previousAgentId);
			this.clearPendingUiRequests(sessionId, previousAgentId);
		}
		const previousSessionId = this.sessionIdByAgent.get(agentId);
		if (previousSessionId && previousSessionId !== sessionId) {
			this.agentIdBySession.delete(previousSessionId);
			this.clearPendingUiRequests(previousSessionId, agentId);
		}
		this.clearPendingUiRequests(sessionId);
		const runtimeGeneration = (this.generationBySession.get(sessionId) ?? 0) + 1;
		this.generationBySession.set(sessionId, runtimeGeneration);
		this.agentIdBySession.set(sessionId, agentId);
		this.sessionIdByAgent.set(agentId, sessionId);
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (tab) tab.runtimeGeneration = runtimeGeneration;
		return runtimeGeneration;
	}

	private beginRuntimeReplacement(agentId: string): RuntimeReplacement | undefined {
		const binding = this.getRuntimeBinding(agentId);
		if (!binding) return undefined;
		this.assertNoDispatchLease(binding.sessionId, agentId);
		if (this.replacementByAgent.has(agentId)) {
			throw new Error(`Session runtime replacement already in progress: ${agentId}`);
		}
		if (this.replacementBySession.has(binding.sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${binding.sessionId}`);
		}
		const runtimeGeneration = binding.runtimeGeneration + 1;
		this.generationBySession.set(binding.sessionId, runtimeGeneration);
		this.agentIdBySession.delete(binding.sessionId);
		this.sessionIdByAgent.delete(agentId);
		this.clearPendingUiRequests(binding.sessionId, agentId);
		const replacement: RuntimeReplacement = {
			...binding,
			agentId,
			runtimeGeneration,
			replacementId: ++this.replacementSequence,
		};
		this.replacementByAgent.set(agentId, replacement);
		this.replacementBySession.set(binding.sessionId, replacement);
		return replacement;
	}

	private completeRuntimeReplacement(
		replacement: RuntimeReplacement,
		targetSessionId: string,
	): SessionRuntimeBinding {
		this.requireCurrentReplacement(replacement);
		if (!this.catalog.get(targetSessionId)) {
			throw new Error(`Session not found: ${targetSessionId}`);
		}
		const targetAgentId = this.getAgentId(targetSessionId);
		if (targetAgentId && targetAgentId !== replacement.agentId) {
			throw new Error(`Session runtime target already bound: ${targetSessionId}`);
		}
		const targetReplacement = this.replacementBySession.get(targetSessionId);
		if (targetReplacement && targetReplacement !== replacement) {
			throw new Error(`Session runtime replacement reservation conflict: ${targetSessionId}`);
		}
		this.releaseRuntimeReplacement(replacement);
		return {
			sessionId: targetSessionId,
			agentId: replacement.agentId,
			runtimeGeneration: this.bind(targetSessionId, replacement.agentId),
		};
	}

	private restoreRuntimeReplacement(
		replacement: RuntimeReplacement,
	): SessionRuntimeBinding {
		this.requireCurrentReplacement(replacement);
		this.releaseRuntimeReplacement(replacement);
		return {
			sessionId: replacement.sessionId,
			agentId: replacement.agentId,
			runtimeGeneration: this.bind(replacement.sessionId, replacement.agentId),
		};
	}

	private failClosedRuntimeReplacement(replacement: RuntimeReplacement): void {
		this.requireCurrentReplacement(replacement);
		this.releaseRuntimeReplacement(replacement);
	}

	private releaseRuntimeReplacement(replacement: RuntimeReplacement): void {
		if (this.replacementByAgent.get(replacement.agentId) === replacement) {
			this.replacementByAgent.delete(replacement.agentId);
		}
		if (this.replacementBySession.get(replacement.sessionId) === replacement) {
			this.replacementBySession.delete(replacement.sessionId);
		}
	}

	private requireCurrentReplacement(replacement: RuntimeReplacement): void {
		if (this.replacementByAgent.get(replacement.agentId) !== replacement) {
			throw new Error("Session runtime replacement binding changed");
		}
		if (this.replacementBySession.get(replacement.sessionId) !== replacement) {
			throw new Error("Session runtime replacement reservation changed");
		}
		if (
			this.sessionIdByAgent.has(replacement.agentId) ||
			this.agentIdBySession.get(replacement.sessionId) === replacement.agentId
		) {
			throw new Error("Session runtime replacement acquired a competing binding");
		}
	}

	private reserveBoundRuntime(sessionId: string, agentId: string): RuntimeReplacement {
		const binding = this.getRuntimeBinding(agentId);
		if (
			!binding ||
			binding.sessionId !== sessionId ||
			this.agentIdBySession.get(sessionId) !== agentId
		) {
			throw new Error("Session runtime changed before reservation");
		}
		this.assertNoDispatchLease(sessionId, agentId);
		if (this.replacementByAgent.has(agentId)) {
			throw new Error(`Session runtime replacement already in progress: ${agentId}`);
		}
		if (this.replacementBySession.has(sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${sessionId}`);
		}
		const reservation: RuntimeReplacement = {
			...binding,
			agentId,
			replacementId: ++this.replacementSequence,
		};
		this.replacementByAgent.set(agentId, reservation);
		this.replacementBySession.set(sessionId, reservation);
		return reservation;
	}

	private requireCurrentReservation(reservation: RuntimeReplacement): void {
		if (
			this.replacementByAgent.get(reservation.agentId) !== reservation ||
			this.replacementBySession.get(reservation.sessionId) !== reservation
		) {
			throw new Error("Session runtime reservation changed");
		}
		const binding = this.getRuntimeBinding(reservation.agentId);
		if (
			!binding ||
			binding.sessionId !== reservation.sessionId ||
			binding.runtimeGeneration !== reservation.runtimeGeneration
		) {
			throw new Error("Session runtime binding changed during reservation");
		}
	}

	private runtimeInfo(sessionId: string, tab: AgentTab): SessionRuntimeInfo {
		const target = this.getTarget(sessionId);
		if (!target || target.agentId !== tab.id) {
			throw new SessionRuntimeCommandError(
				"SESSION_RUNTIME_CHANGED",
				"Session runtime binding changed while building runtime state",
			);
		}
		const streamingFlags = this.agents.getLocalStreamingFlags?.(tab.id);
		return {
			...target,
			projectId: tab.projectId,
			cwd: tab.cwd,
			status: tab.status,
			sessionPath: tab.sessionPath,
			createdAt: tab.createdAt,
			compactionCount: tab.compactionCount,
			noSession: tab.noSession,
			isStreaming: streamingFlags?.isStreaming,
			isExecutingTool: streamingFlags?.isExecutingTool,
		};
	}

	private requireTarget(target: SessionRuntimeTarget): SessionRuntimeBinding {
		if (!this.catalog.get(target.sessionId)) {
			throw new SessionRuntimeCommandError(
				"SESSION_NOT_FOUND",
				`Session not found: ${target.sessionId}`,
			);
		}
		const binding = this.getRuntimeBinding(target.agentId);
		if (!binding || this.agentIdBySession.get(target.sessionId) !== target.agentId) {
			throw new SessionRuntimeCommandError(
				"SESSION_RUNTIME_UNAVAILABLE",
				"Session runtime is not available",
			);
		}
		if (
			binding.sessionId !== target.sessionId ||
			binding.runtimeGeneration !== target.runtimeGeneration
		) {
			throw new SessionRuntimeCommandError(
				"SESSION_RUNTIME_CHANGED",
				"Session runtime binding changed",
			);
		}
		return { ...target };
	}

	private async runHistoryMutationCommand<T>(
		target: SessionRuntimeTarget,
		operation: (agentId: string) => Promise<T>,
	): Promise<SessionCommandResult<SessionTargetedValue<T>>> {
		const sessionId = target.sessionId;
		const previous = this.historyMutationTails.get(sessionId) ?? Promise.resolve();

		const current = previous
			.catch(() => undefined)
			.then(() => this.runTargetCommand(target, operation));

		const tail = current.then(() => undefined, () => undefined);
		this.historyMutationTails.set(sessionId, tail);

		try {
			return await current;
		} finally {
			if (this.historyMutationTails.get(sessionId) === tail) {
				this.historyMutationTails.delete(sessionId);
			}
		}
	}

	private async runTargetCommand<T>(
		target: SessionRuntimeTarget,
		operation: (agentId: string) => Promise<T>,
	): Promise<SessionCommandResult<SessionTargetedValue<T>>> {
		let lease: DispatchLease | undefined;
		try {
			this.requireTarget(target);
			lease = this.acquireDispatchLease(target.sessionId, target.agentId);
			if (lease.runtimeGeneration !== target.runtimeGeneration) {
				throw new SessionRuntimeCommandError(
					"SESSION_RUNTIME_CHANGED",
					"Session runtime generation changed before command dispatch",
				);
			}
			const value = await operation(lease.agentId);
			if (!this.isCurrentDispatchLease(lease)) {
				throw new SessionRuntimeCommandError(
					"SESSION_RUNTIME_CHANGED",
					"Session runtime binding changed during command dispatch",
				);
			}
			return {
				ok: true,
				value: {
					target: {
						sessionId: lease.sessionId,
						agentId: lease.agentId,
						runtimeGeneration: lease.runtimeGeneration,
					},
					value,
				},
			};
		} catch (error) {
			return this.commandFailure(error);
		} finally {
			if (lease) this.releaseDispatchLease(lease);
		}
	}

	private commandFailure<T>(error: unknown): SessionCommandResult<T> {
		if (error instanceof SessionRuntimeCommandError) {
			return {
				ok: false,
				error: { code: error.code, debugDetails: error.message },
			};
		}
		// 模型在本地 models.json 存在但运行中 Agent 未加载：标记 needsRestart，
		// 渲染层据此弹出「重启 Agent 生效」引导（而非误报会话不存在）。
		if (error instanceof Error && (error as Error & { needsRestart?: boolean }).needsRestart) {
			return {
				ok: false,
				error: {
					code: "SESSION_MODEL_NOT_FOUND",
					debugDetails: error.message,
					needsRestart: true,
					// 提取 "Model not found: xxx" 中的模型标识，让 i18n 文案 {model} 有值
					params: { model: this.extractModelFromNotFound(error.message) ?? error.message },
				},
			};
		}
		const message = errorMessage(error);
		const lower = message.toLowerCase();
		const model = this.extractModelFromNotFound(message);

		const rawCode = typeof (error as { code?: unknown })?.code === "string"
			? (error as { code: string }).code
			: undefined;

		let code: SessionCommandErrorCode;
		if (
			rawCode === "SESSION_ENTRY_NOT_FOUND" ||
			rawCode === "SESSION_ENTRY_AMBIGUOUS" ||
			rawCode === "MESSAGE_NOT_FOUND"
		) {
			code = "MESSAGE_NOT_FOUND";
		} else if (rawCode === "SESSION_MODEL_NOT_FOUND") {
			code = "SESSION_MODEL_NOT_FOUND";
		} else if (rawCode === "SESSION_NOT_FOUND") {
			code = "SESSION_NOT_FOUND";
		} else if (rawCode === "SESSION_RUNTIME_BUSY") {
			code = "SESSION_RUNTIME_BUSY";
		} else if (rawCode === "SESSION_RUNTIME_CHANGED") {
			code = "SESSION_RUNTIME_CHANGED";
		} else if (rawCode === "SESSION_RUNTIME_UNAVAILABLE") {
			code = "SESSION_RUNTIME_UNAVAILABLE";
		} else if (rawCode === "SESSION_COMMAND_FAILED") {
			code = "SESSION_COMMAND_FAILED";
		} else {
			// 字符串 fallback
			// 消息定位失败（编辑/删除/重发缓存与文件都未命中、活跃分支未找到条目等）先于泛化 "not found" 识别：
			// 否则会误报成 SESSION_NOT_FOUND（「会话已不存在」），而会话其实还在。
			code =
				lower.includes("message not found") ||
				lower.includes("message was not found") ||
				lower.includes("session_entry_not_found") ||
				lower.includes("session_entry_ambiguous") ||
				(lower.includes("entry") && lower.includes("not found"))
					? "MESSAGE_NOT_FOUND"
					// set_model 的 "Model not found: provider/model"（本地 models.json 也没有该模型，
					// 如手误/列表错位产生的假模型）是「模型不存在」而非「会话不存在」——
					// 若落到泛化 "not found" 分支会误报成「会话已不存在」误导排查。
					: lower.includes("model not found")
						? "SESSION_MODEL_NOT_FOUND"
						: lower.includes("session not found") || (lower.includes("not found") && !lower.includes("message") && !lower.includes("entry"))
							? "SESSION_NOT_FOUND"
							: lower.includes("busy") || lower.includes("in progress") || lower.includes("stream")
								? "SESSION_RUNTIME_BUSY"
								: lower.includes("binding") || lower.includes("generation") || lower.includes("changed")
									? "SESSION_RUNTIME_CHANGED"
									: lower.includes("runtime") && lower.includes("available")
										? "SESSION_RUNTIME_UNAVAILABLE"
										: "SESSION_COMMAND_FAILED";
		}
		return {
			ok: false,
			error: {
				code,
				debugDetails: message,
				// 仅模型不存在类错误带 model 参数（i18n 文案占位）；其余错误不附加
				...(code === "SESSION_MODEL_NOT_FOUND" && model ? { params: { model } } : {}),
			},
		};
	}

	/**
	 * 从 "Model not found: <provider/model>" 类错误消息提取模型标识。
	 * 支持 "Model not found: xxx" / "model not found:xxx" 两种分隔；
	 * 未匹配返回 undefined（由调用方决定兜底）。
	 */
	private extractModelFromNotFound(message: string): string | undefined {
		const match = /model not found\s*:?\s*(.+)$/i.exec(message);
		return match?.[1]?.trim() || undefined;
	}

	private acquireDispatchLease(sessionId: string, agentId: string): DispatchLease {
		if (this.replacementBySession.has(sessionId) || this.replacementByAgent.has(agentId)) {
			throw new Error("Session runtime replacement is in progress");
		}
		const binding = this.getRuntimeBinding(agentId);
		if (!binding || binding.sessionId !== sessionId) {
			throw new Error("Session runtime binding changed before prompt dispatch");
		}
		const lease: DispatchLease = {
			...binding,
			agentId,
			leaseId: ++this.dispatchLeaseSequence,
		};
		this.addDispatchLease(this.dispatchLeasesBySession, sessionId, lease);
		this.addDispatchLease(this.dispatchLeasesByAgent, agentId, lease);
		return lease;
	}

	private addDispatchLease(
		leases: Map<string, Set<DispatchLease>>,
		key: string,
		lease: DispatchLease,
	): void {
		const current = leases.get(key) ?? new Set<DispatchLease>();
		current.add(lease);
		leases.set(key, current);
	}

	private releaseDispatchLease(lease: DispatchLease): void {
		for (const [leases, key] of [
			[this.dispatchLeasesBySession, lease.sessionId],
			[this.dispatchLeasesByAgent, lease.agentId],
		] as const) {
			const current = leases.get(key);
			if (!current) continue;
			current.delete(lease);
			if (current.size === 0) leases.delete(key);
		}
	}

	private isCurrentDispatchLease(lease: DispatchLease): boolean {
		if (
			!this.dispatchLeasesBySession.get(lease.sessionId)?.has(lease) ||
			!this.dispatchLeasesByAgent.get(lease.agentId)?.has(lease)
		) return false;
		const binding = this.getRuntimeBinding(lease.agentId);
		return Boolean(
			binding &&
			binding.sessionId === lease.sessionId &&
			binding.runtimeGeneration === lease.runtimeGeneration &&
			this.agentIdBySession.get(lease.sessionId) === lease.agentId
		);
	}

	private hasDispatchLease(sessionId?: string, agentId?: string): boolean {
		return Boolean(
			(sessionId && this.dispatchLeasesBySession.get(sessionId)?.size) ||
			(agentId && this.dispatchLeasesByAgent.get(agentId)?.size)
		);
	}

	private assertNoDispatchLease(sessionId?: string, agentId?: string): void {
		if (this.hasDispatchLease(sessionId, agentId)) {
			throw new Error("Session runtime prompt dispatch is in progress");
		}
	}

	private uiRequestKey(sessionId: string, requestId: string): string {
		return `${sessionId}\u0000${requestId}`;
	}

	private clearPendingUiRequests(sessionId: string, agentId?: string): void {
		for (const [key, pending] of this.pendingUiRequests) {
			if (pending.sessionId === sessionId && (!agentId || pending.agentId === agentId)) {
				this.pendingUiRequests.delete(key);
			}
		}
	}

	private pruneDeliveryCache(): void {
		const now = Date.now();
		for (const [key, entry] of this.deliveryByRequest) {
			if (entry.settled && now - entry.createdAt > DELIVERY_CACHE_TTL_MS) {
				this.deliveryByRequest.delete(key);
			}
		}
		if (this.deliveryByRequest.size <= DELIVERY_CACHE_MAX_ENTRIES) return;
		for (const [key, entry] of this.deliveryByRequest) {
			if (!entry.settled) continue;
			this.deliveryByRequest.delete(key);
			if (this.deliveryByRequest.size <= DELIVERY_CACHE_MAX_ENTRIES) break;
		}
	}

	private rejected(
		input: Pick<SendSessionPromptInput, "sessionId" | "requestId">,
		error: string,
		descriptor: I18nDescriptor = {
			i18nKey: "diagnostic.promptRejected",
			debugDetails: error,
		},
	): SendSessionPromptResult {
		return {
			accepted: false,
			delivery: "rejected",
			error,
			...descriptor,
			sessionId: input.sessionId,
			requestId: input.requestId,
		};
	}

	private unknownDelivery(
		input: Pick<SendSessionPromptInput, "sessionId" | "requestId">,
		error: string,
	): SendSessionPromptResult {
		return {
			accepted: false,
			delivery: "unknown",
			error,
			i18nKey: "diagnostic.promptDeliveryUnknown",
			debugDetails: error,
			sessionId: input.sessionId,
			requestId: input.requestId,
		};
	}
}
