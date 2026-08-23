import { ipcChannels } from "../../shared/ipc";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import {
	buildSessionOriginKey,
} from "../../shared/sessionIdentity";
import type {
	AgentTab,
	AgentUiRequest,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionCommandError,
	SessionCommandResult,
	SessionRecord,
	SessionRuntimeEvent,
	SessionRuntimeTarget,
} from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { canAttachRuntimeMetadata } from "../sessions/SessionCatalog";
import { SessionCommandIpcError } from "../sessions/SessionCommandIpcError";
import type {
	SessionRuntimeBinding,
	SessionRuntimeCoordinator,
} from "../sessions/SessionRuntimeCoordinator";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SettingsStore } from "../settings/SettingsStore";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";

export type AgentSessionReplacementResult = {
	cancelled?: boolean;
	[key: string]: unknown;
};

export interface SessionRuntimeBridgeDeps {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	configManager: ConfigManager;
	sessionCatalog: SessionCatalog;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	sessionScanner: SessionScanner;
	agentManager: AgentManager;
	terminalManager: TerminalSessionManager;
	appLogger: AppLogger;
	mainCopy: (
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	) => string;
	sendToRenderer: (channel: string, ...args: unknown[]) => void;
}

export interface SessionRuntimeBridge {
	sendSessionRuntimeEnvelope(event: SessionRuntimeEvent): void;
	emitSessionRuntimeEvent(
		agentId: string,
		sourceChannel: string,
		payload: unknown,
	): boolean;
	emitSessionRuntimeDetach(binding: SessionRuntimeBinding): void;
	discardAnonymousSession(binding: SessionRuntimeBinding): void;
	createAnonymousSession(
		input: CreateAnonymousSessionInput,
	): Promise<CreateAnonymousSessionResult>;
	stopSessionRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionRuntimeTarget>>;
	stopAgentFromMonitor(
		agentId: string,
	): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>>;
	emitReplacementState(
		binding: SessionRuntimeBinding,
		includeMessages: boolean,
	): void;
	readCatalogSessionReferenceMessages(
		sessionId: string,
	): Promise<Array<{ role: string; content: string; timestamp: number }>>;
	copyCatalogSession(
		sessionId: string,
	): Promise<{ cancelled: boolean; targetSessionId?: string }>;
	exportCatalogSessionHtml(sessionId: string): Promise<{ path: string }>;
	replaceAgentSession(
		agentId: string,
		replace: () => Promise<unknown>,
	): Promise<AgentSessionReplacementResult & { targetSessionId?: string }>;
	cancelUnboundUiRequest(payload: unknown): void;
	sessionCommandIpcError(error: SessionCommandError): SessionCommandIpcError;
}

export function createSessionRuntimeBridge(
	deps: SessionRuntimeBridgeDeps,
): SessionRuntimeBridge {
	const {
		projectStore,
		settingsStore,
		configManager,
		sessionCatalog,
		sessionRuntimeCoordinator,
		sessionScanner,
		agentManager,
		terminalManager,
		appLogger,
		mainCopy,
		sendToRenderer,
	} = deps;

	function sendSessionRuntimeEnvelope(event: SessionRuntimeEvent): void {
		sendToRenderer(ipcChannels.sessionsRuntimeEvent, event);
	}

	function emitSessionRuntimeEvent(
		agentId: string,
		sourceChannel: string,
		payload: unknown,
	): boolean {
		const runtimeBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
		if (!runtimeBinding) return false;
		const event: SessionRuntimeEvent = {
			kind: "event",
			sessionId: runtimeBinding.sessionId,
			agentId,
			runtimeGeneration: runtimeBinding.runtimeGeneration,
			sourceChannel,
			payload,
		};
		sessionRuntimeCoordinator.observeRuntimeEvent(event);
		if (payload && typeof payload === "object" && !Array.isArray(payload)) {
			const tab = payload as Partial<AgentTab>;
			if (typeof tab.sessionPath === "string" && tab.sessionPath) {
				const entry = sessionCatalog.get(runtimeBinding.sessionId);
				if (
					canAttachRuntimeMetadata(entry, tab) &&
					(entry?.filePath !== tab.sessionPath || entry.piSessionId !== tab.sessionId)
				) {
					void sessionCatalog.attachRuntime({
						sessionId: runtimeBinding.sessionId,
						filePath: tab.sessionPath,
						piSessionId: tab.sessionId,
					}).catch(() => undefined);
				}
			}
		}
		sendSessionRuntimeEnvelope(event);
		const tab = payload && typeof payload === "object" && !Array.isArray(payload)
			? payload as Partial<AgentTab>
			: undefined;
		// A crashed anonymous process has no durable session to reopen. The regular
		// Agent state event reaches the renderer first so diagnostics remain visible
		// for the current tick, then detach removes the transient conversation.
		if (tab?.noSession && tab.status === "closed") {
			sessionRuntimeCoordinator.unbindTerminalAgent(agentId);
			discardAnonymousSession({ ...runtimeBinding, agentId });
		}
		return true;
	}

	function emitSessionRuntimeDetach(binding: SessionRuntimeBinding): void {
		sendSessionRuntimeEnvelope({
			kind: "detach",
			sessionId: binding.sessionId,
			agentId: binding.agentId,
			runtimeGeneration: binding.runtimeGeneration,
			sourceChannel: "sessions:runtime-detach",
			payload: null,
		});
	}

	/**
	 * Anonymous chats have no catalog file to rediscover. Once their runtime stops,
	 * discard the in-memory record after broadcasting detach so every renderer can
	 * remove its transient Session state.
	 */
	function discardAnonymousSession(binding: SessionRuntimeBinding): void {
		if (!sessionCatalog.get(binding.sessionId)?.noSession) return;
		sessionCatalog.removeTransient(binding.sessionId);
		emitSessionRuntimeDetach(binding);
	}

	async function activateAnonymousRuntime(
		session: SessionRecord,
		project: Project,
		input: CreateAnonymousSessionInput,
	): Promise<void> {
		let agentId: string | undefined;
		try {
			const tab = await agentManager.create({
				projectId: project.id,
				title: session.title,
				environment: session.environment,
				source: "pi",
				wslDistro: session.wslDistro,
				wslUser: session.wslUser,
				noSession: true,
			});
			agentId = tab.id;
			const runtime = sessionRuntimeCoordinator.bindAnonymousRuntime(session.id, tab.id);
			// Anonymous Agent 使用 --no-session 创建，不会经过普通 activateRuntime 的恢复流程；
			// 因此在绑定后显式应用引导页选择，确保 pi 不再按自身默认优先级启动。
			if (input.model) {
				const result = await sessionRuntimeCoordinator.setRuntimeModel(runtime, input.model.provider, input.model.modelId);
				if (!result.ok) throw new Error(result.error.code);
			}
			if (input.thinkingLevel) {
				const result = await sessionRuntimeCoordinator.setRuntimeThinking(runtime, input.thinkingLevel);
				if (!result.ok) throw new Error(result.error.code);
			}
			emitReplacementState(runtime, true);
		} catch (error) {
			if (agentId) await agentManager.stop(agentId).catch(() => undefined);
			sessionCatalog.removeTransient(session.id);
			// createUnlocked 内部已尽量把 pi 启动失败落到会话错误卡；这里兜底信任/项目查找等
			// 前置异常，保证异步匿名启动失败仍可诊断且不会留下不可用的临时行。
			void appLogger.error("agent", "Agent create IPC failed", {
				projectId: project.id,
				title: input.title,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				platform: process.platform,
				arch: process.arch,
			});
		}
	}

	async function createAnonymousSession(
		input: CreateAnonymousSessionInput,
	): Promise<CreateAnonymousSessionResult> {
		const project = projectStore.get(input.projectId);
		if (!project) throw new Error(mainCopy("project.notFound"));

		// Resolve pi-configured defaults so the composer bar shows the effective
		// model / thinking level even before the anonymous Agent is fully started.
		let model = input.model;
		let thinkingLevel = input.thinkingLevel;
		try {
			// 引导页显式选择优先于 pi 配置；下面只为缺失字段补默认值。
			const [settingsResult, modelsResult] = await Promise.all([
				configManager.getSettingsConfig(),
				configManager.getModelsConfig(),
			]);
			const settings = settingsResult.parsed;
			const defaultProvider = typeof settings.defaultProvider === "string"
				? settings.defaultProvider
				: undefined;
			const defaultModelId = typeof settings.defaultModel === "string"
				? settings.defaultModel
				: undefined;
			if (!model && defaultProvider && defaultModelId) {
				model = { provider: defaultProvider, modelId: defaultModelId };
			} else if (!model) {
				const providers = modelsResult.parsed?.providers;
				if (providers) {
					const firstProviderName = Object.keys(providers)[0];
					const firstProvider = firstProviderName ? providers[firstProviderName] : undefined;
					const firstModel = firstProvider?.models?.[0];
					if (firstProviderName && firstModel?.id) {
						model = { provider: firstProviderName, modelId: firstModel.id };
					}
				}
			}
			const level = typeof settings.defaultThinkingLevel === "string"
				? settings.defaultThinkingLevel
				: undefined;
			if (!thinkingLevel) thinkingLevel = level;
		} catch {
			// Config read is best-effort.
		}

		const session = sessionCatalog.createAnonymous({
			projectId: project.id,
			title: input.title?.trim() || mainCopy("session.anonymousTitle", { project: project.name }),
			environment: settingsStore.get().wslEnabled ? "wsl" : "native",
			model,
			thinkingLevel,
		});
		// Agent 启动可能包含 spawn/get_state/历史准备；匿名会话先返回可选中的 Session，
		// 再后台绑定 runtime。这样欢迎页点击后能立即进入输入框，启动失败仍通过 detach/日志收敛。
		void activateAnonymousRuntime(session, project, input).catch(() => undefined);
		sendToRenderer(ipcChannels.sessionsCatalogRefreshed, { projectId: session.projectId });
		return { session };
	}

	async function stopSessionRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionRuntimeTarget>> {
		const anonymous = sessionCatalog.get(target.sessionId)?.noSession === true;
		const result = await sessionRuntimeCoordinator.stopRuntime(target);
		if (result.ok) {
			terminalManager.closeAgent(target.agentId);
			if (anonymous) discardAnonymousSession(target);
			else emitSessionRuntimeDetach(target);
		}
		return result;
	}

	/**
	 * 进程监控「停止 agent」入口：调用方只有 agentId，由 coordinator 反查会话并走
	 * 完整停止链路（保留/解绑 + 关终端 + detach 推送）。与 stopSessionRuntime 的
	 * 区别仅在于 target 的来源；不这么做的话渲染层收不到 detach，会话运行标记
	 * 会停留在 running（用户可见的「停止后蓝点不变」现象）。
	 */
	async function stopAgentFromMonitor(
		agentId: string,
	): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>> {
		const result = await sessionRuntimeCoordinator.stopAgentById(agentId);
		if (!result.ok) return result;
		terminalManager.closeAgent(agentId);
		if (result.value) emitSessionRuntimeDetach(result.value);
		return result;
	}

	function emitReplacementState(
		binding: SessionRuntimeBinding,
		includeMessages: boolean,
	): void {
		const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
		if (!tab) return;
		emitSessionRuntimeEvent(binding.agentId, ipcChannels.agentsState, tab);
		if (includeMessages) {
			// 与 flush 同一窗口协议：只下发显示窗口段 + windowStart/totalLength/fileVersion，
			// 渲染层合并逻辑一处生效（窗口前历史由 disk 轮次分页 prepend）
			emitSessionRuntimeEvent(binding.agentId, ipcChannels.agentsMessage, {
				agentId: binding.agentId,
				...agentManager.getMessageWindow(binding.agentId),
			});
		}
	}

	async function readCatalogSessionReferenceMessages(
		sessionId: string,
	): Promise<Array<{ role: string; content: string; timestamp: number }>> {
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath) return [];
		return sessionScanner.readMessages(entry.filePath);
	}

	async function copyCatalogSession(
		sessionId: string,
	): Promise<{ cancelled: boolean; targetSessionId?: string }> {
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath) throw new Error(mainCopy("session.fileNotFound"));
		const result = await agentManager.cloneSessionFile(entry.projectId, entry.filePath, entry.environment) as {
			cancelled?: boolean;
			sessionPath?: string;
		};
		if (result.cancelled || !result.sessionPath) return { cancelled: true };
		const copied = await sessionCatalog.ensureRuntimeTarget({
			projectId: entry.projectId,
			title: entry.title,
			source: entry.source,
			environment: entry.environment,
			filePath: result.sessionPath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
			importedSourceId: entry.importedSourceId,
		});
		return { cancelled: false, targetSessionId: copied.id };
	}

	async function exportCatalogSessionHtml(sessionId: string): Promise<{ path: string }> {
		const entry = sessionCatalog.get(sessionId);
		if (!entry?.filePath) throw new Error(mainCopy("session.fileNotFound"));
		const result = await agentManager.exportSessionHtml(entry.projectId, entry.filePath);
		if (!result || typeof result !== "object" || !("path" in result) || typeof result.path !== "string") {
			throw new Error(mainCopy("session.exportFailed"));
		}
		return { path: result.path };
	}

	async function replaceAgentSession(
		agentId: string,
		replace: () => Promise<unknown>,
	): Promise<AgentSessionReplacementResult & { targetSessionId?: string }> {
		const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
		const originEntry = originBinding
			? sessionCatalog.get(originBinding.sessionId)
			: undefined;
		const originKey = originEntry?.filePath
			? buildSessionOriginKey({
				source: originEntry.source,
				environment: originEntry.environment,
				filePath: originEntry.filePath,
				wslDistro: originEntry.wslDistro,
				wslUser: originEntry.wslUser,
				importedSourceId: originEntry.importedSourceId,
			})
			: undefined;
		return sessionRuntimeCoordinator.replaceBoundRuntime({
			agentId,
			replace: async () => {
				const result = await replace();
				return result && typeof result === "object" && !Array.isArray(result)
					? result as AgentSessionReplacementResult
					: {};
			},
			resolveTargetSessionId: async () => {
				const tab = agentManager.list().find((candidate) => candidate.id === agentId);
				if (!tab?.sessionPath) {
					throw new Error(`Replacement runtime has no session path: ${agentId}`);
				}
				const environment = tab.sessionEnvironment ?? originEntry?.environment ?? "native";
				const target = await sessionCatalog.ensureRuntimeTarget({
					projectId: tab.projectId,
					title: tab.title,
					source: tab.sessionSource ?? originEntry?.source ?? "pi",
					environment,
					filePath: tab.sessionPath,
					wslDistro: tab.wslDistro ?? (environment === "wsl" ? originEntry?.wslDistro : undefined),
					wslUser: tab.wslUser ?? (environment === "wsl" ? originEntry?.wslUser : undefined),
					importedSourceId: tab.importedSourceId ?? originEntry?.importedSourceId,
					piSessionId: tab.sessionId,
				});
				return target.id;
			},
			canRestoreOrigin: () => {
				const tab = agentManager.list().find((candidate) => candidate.id === agentId);
				if (!originKey || !tab?.sessionPath) return false;
				return buildSessionOriginKey({
					source: tab.sessionSource ?? "pi",
					environment: tab.sessionEnvironment ?? "native",
					filePath: tab.sessionPath,
					wslDistro: tab.wslDistro,
					wslUser: tab.wslUser,
					importedSourceId: tab.importedSourceId,
				}) === originKey;
			},
			onDetached: emitSessionRuntimeDetach,
			onAttached: (binding) => emitReplacementState(binding, true),
			onRestored: (binding) => emitReplacementState(binding, false),
		});
	}

	function cancelUnboundUiRequest(payload: unknown): void {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
		const request = payload as Partial<AgentUiRequest>;
		if (
			typeof request.agentId !== "string" ||
			typeof request.requestId !== "string" ||
			request.completed === true ||
			!(["select", "confirm", "input", "editor", "batch_ask"] as const).some(
				(method) => method === request.method,
			)
		) {
			return;
		}
		void appLogger.warn("session", "Cancelled unbound runtime UI request", {
			agentId: request.agentId,
			requestId: request.requestId,
			method: request.method,
		});
		void agentManager.sendUIResponse(request.agentId, request.requestId, { cancelled: true });
	}

	function sessionCommandIpcError(error: SessionCommandError): SessionCommandIpcError {
		if (error.debugDetails) {
			void appLogger?.warn("session-command", "Session command failed", {
				code: error.code,
				debugDetails: error.debugDetails,
			});
		}
		return new SessionCommandIpcError(error, mainCopy);
	}

	return {
		sendSessionRuntimeEnvelope,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		discardAnonymousSession,
		createAnonymousSession,
		stopSessionRuntime,
		stopAgentFromMonitor,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		copyCatalogSession,
		exportCatalogSessionHtml,
		replaceAgentSession,
		cancelUnboundUiRequest,
		sessionCommandIpcError,
	};
}
