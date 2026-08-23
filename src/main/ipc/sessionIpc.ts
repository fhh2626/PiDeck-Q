/**
 * Session IPC handlers: session list, catalog, runtime management, importers.
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 */


import { ipcChannels } from "../../shared/ipc";
import { canonicalizeSessionPath } from "../../shared/sessionIdentity";
import type {
	CreateSessionDraftInput,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	UpdateSessionRecordInput,
	SendSessionPromptInput,
	SessionUiResponseInput,
	SessionRuntimeTarget,
	SessionRuntimeInfo,
	SessionRuntimeReplacement,
	SessionRuntimeEvent,
	SessionCommandError,
	SessionCommandResult,
	SendPromptInput,
	SendPromptResult,
	SessionRecord,
	SessionProcessEvent,
} from "../../shared/types";
import { parseSessionProcessEvents } from "../sessions/sessionProcessEvents";
import { BackgroundScanCoordinator } from "../sessions/BackgroundScanCoordinator";
import {
	DEFAULT_CONTEXT_CONTROLLER_STATE,
	parseContextControllerStateFromJsonl,
} from "../sessions/contextControllerStateReader";
import type { RpcRouter } from "../transport/RpcRouter";

/**
 * 已扫描过项目的集合（模块级）：决定 catalogList 走「首次同步扫描」还是
 * 「缓存先回显 + 后台扫描推送」。进程生命周期内单调增长，无需清理。
 */
const scannedProjects = new Set<string>();

/** 后台目录扫描协调器：同项目触发去重 + 冷却合并（3 秒轮询不会演变成并发重扫）。 */
const catalogScanCoordinator = new BackgroundScanCoordinator(5000);

/**
 * 供主进程装配层（启动预扫描）触发的后台扫描调度入口。
 * 标记项目为已扫描，保证预热后首次展开项目走缓存回显路径。
 */
export function scheduleCatalogBackgroundScan(projectId: string, task: () => Promise<void>): boolean {
	scannedProjects.add(projectId);
	return catalogScanCoordinator.schedule(projectId, task);
}
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { SessionCommandIpcError } from "../sessions/SessionCommandIpcError";
import type { AgentManager } from "../pi/AgentManager";
import type { ConfigManager } from "../config/ConfigManager";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { CodexSessionImporter } from "../sessions/CodexSessionImporter";
import type { ClaudeSessionImporter } from "../sessions/ClaudeSessionImporter";
import type { OpenCodeSessionImporter } from "../sessions/OpenCodeSessionImporter";
import type { AppLogger } from "../logging/AppLogger";

export type SessionIpcDeps = {
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	sessionScanner: SessionScanner;
	sessionCatalog: SessionCatalog;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	agentManager: AgentManager;
	configManager: ConfigManager;
	codexSessionImporter: CodexSessionImporter;
	claudeSessionImporter: ClaudeSessionImporter;
	openCodeSessionImporter: OpenCodeSessionImporter;
	appLogger: AppLogger;
	terminalManager: TerminalSessionManager;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	sendToRenderer: (channel: string, ...args: unknown[]) => void;
	emitSessionRuntimeEvent: (agentId: string, channel: string, payload: unknown) => boolean;
	emitSessionRuntimeDetach: (target: SessionRuntimeTarget) => void;
	createAnonymousSession: (input: CreateAnonymousSessionInput) => Promise<CreateAnonymousSessionResult>;
	stopSessionRuntime: (target: SessionRuntimeTarget) => void;
	emitReplacementState: (runtime: SessionRuntimeInfo, includeMessages: boolean) => void;
	readCatalogSessionReferenceMessages: (sessionId: string) => Promise<unknown[]>;
	copyCatalogSession: (
		sessionId: string,
	) => Promise<{ cancelled: boolean; targetSessionId?: string }>;
	exportCatalogSessionHtml: (sessionId: string) => Promise<Record<string, unknown> & { path: string }>;
	replaceAgentSession: (agentId: string, fn: () => Promise<any>) => Promise<any>;
};

function sessionCommandIpcError(
	error: SessionCommandError,
	appLogger: Pick<AppLogger, "warn">,
	mainCopy: (key: string, params?: Record<string, string | number>) => string,
): SessionCommandIpcError {
	if (error.debugDetails) {
		void appLogger.warn("session-command", "Session command failed", {
			code: error.code,
			debugDetails: error.debugDetails,
		});
	}
	return new SessionCommandIpcError(error, mainCopy);
}

export function registerSessionIpc(router: RpcRouter, deps: SessionIpcDeps): void {
	const {
		projectStore,
		settingsStore,
		sessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
		codexSessionImporter,
		claudeSessionImporter,
		openCodeSessionImporter,
		appLogger,
		terminalManager,
		mainCopy,
		sendToRenderer,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		createAnonymousSession,
		stopSessionRuntime,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		copyCatalogSession,
		exportCatalogSessionHtml,
		replaceAgentSession,
	} = deps;

	router.handle(
		ipcChannels.sessionsList,
		async (projectId?: string) => {
			const project = projectId ? projectStore.get(projectId) : undefined;
			let projectPath = project?.path;
			// WSL 模式：将 Windows 项目路径转为 WSL /mnt/ 格式，
			// 使 WSL 会话（CWD = /mnt/c/...）能正确匹配到项目。
			if (projectPath && settingsStore.get().wslEnabled && settingsStore.get().wslDistro) {
				projectPath = projectPath
					.replace(/^([A-Za-z]):\\/, (_: string, d: string) => `/mnt/${d.toLowerCase()}/`)
					.replace(/\\/g, '/');
			}
			return sessionScanner.list(projectPath);
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogList,
		async (projectId: string, options?: { scan?: boolean }) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			let projectPath = project.path;
			const settings = settingsStore.get();
			if (settings.wslEnabled && settings.wslDistro) {
				projectPath = projectPath
					.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
					.replace(/\\/g, "/");
			}
			const { wslEnabled, wslDistro, wslUser } = settings;

			// 扫描 + 合并 + 运行时绑定（首次同步路径与后台路径共用）
			const runScanAndMerge = async (): Promise<SessionRecord[]> => {
				const summaries = await sessionScanner.list(projectPath);
				const records = await sessionCatalog.mergeScanned(
					projectId,
					summaries,
					wslEnabled ? { wslDistro, wslUser } : {},
				);
				const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(records);
				for (const binding of bindings) {
					const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
					if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
				}
				return records;
			};

			// 目录缓存中的现有记录（上次扫描/运行时创建的合并结果，启动时从磁盘加载）
			const cachedRecords = sessionCatalog.listEntries()
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => sessionCatalog.getRecord(entry.id))
				.filter((record): record is SessionRecord => Boolean(record));

			// 纯读路径：事件回调/订阅刷新专用，不再触发扫描（防止推送-拉取循环触发）
			if (options?.scan === false) return cachedRecords;

			// 首次访问该项目：缓存无数据可回显，同步扫描保证首次有结果；
			// 之后转入「缓存先回显 + 后台扫描推送」模式。
			if (!scannedProjects.has(projectId)) {
				scannedProjects.add(projectId);
				return runScanAndMerge();
			}

			// 已有缓存：立即返回，后台扫描（去重+冷却）完成后推送 catalog-refreshed，
			// 渲染层收到后以 scan:false 重新拉取合并结果。
			catalogScanCoordinator.schedule(projectId, async () => {
				try {
					await runScanAndMerge();
					sendToRenderer(ipcChannels.sessionsCatalogRefreshed, { projectId });
				} catch (error) {
					void appLogger.warn("session", "Background catalog scan failed", {
						projectId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			});
			return cachedRecords;
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogCreateDraft,
		async (input: CreateSessionDraftInput) => {
			const project = projectStore.get(input.projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			// Auto-fill model / thinkingLevel from pi config when the caller hasn't
			// provided them, so the composer bar shows the effective default.
			let model = input.model;
			let thinkingLevel = input.thinkingLevel;
			if (!model || !thinkingLevel) {
				try {
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
						// Fallback: first provider's first model from models.json
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
					if (!thinkingLevel) {
						const level = typeof settings.defaultThinkingLevel === "string"
							? settings.defaultThinkingLevel
							: undefined;
						// pi's schema uses underscore; the runtime and UI use camelCase.
						thinkingLevel = level;
					}
				} catch {
					// Config read is best-effort; draft creation must never block.
				}
			}
			const draft = await sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.title?.trim() || mainCopy("session.newTitle"),
				environment: settingsStore.get().wslEnabled ? "wsl" : "native",
				model,
				thinkingLevel,
			});
			void appLogger.info("session", "Session draft created", {
				sessionId: draft.id,
				projectId: input.projectId,
				title: draft.title,
				model: draft.model,
			});
			return draft;
		},
	);
	router.handle(
		ipcChannels.sessionsCreateAnonymous,
		async (input: CreateAnonymousSessionInput) => {
			const result = await createAnonymousSession(input);
			void appLogger.info("session", "Anonymous session created", {
				sessionId: result.session.id,
				projectId: input.projectId,
			});
			return result;
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogUpdate,
		async (sessionId: string, patch: UpdateSessionRecordInput) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) throw new Error(mainCopy("session.notFound"));
			const title = patch.title?.trim();
			if (title && title !== entry.title) {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
					if (!renamed.ok) throw sessionCommandIpcError(renamed.error, appLogger, mainCopy);
				} else if (entry.filePath) {
					await sessionScanner.rename(entry.filePath, title);
					void appLogger.info("session", "Session renamed (file)", {
						sessionId,
						oldTitle: entry.title,
						newTitle: title,
					});
				}
			}
			return sessionCatalog.update(sessionId, {
				...patch,
				title: title || undefined,
			});
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogDelete,
		async (sessionId: string) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) return false;
			// A draft may be promoted while a renderer click is in flight. Never delete
			// a catalog record that has acquired, or is acquiring, a Session runtime.
			if (
				sessionRuntimeCoordinator.getTarget(sessionId) ||
				sessionRuntimeCoordinator.isActivating(sessionId)
			) {
				throw new Error(mainCopy("session.stopBeforeDelete"));
			}
			try {
				if (entry.filePath) {
					const normalizedTarget = canonicalizeSessionPath(
						entry.filePath,
						entry.environment,
					);
					const usingAgent = agentManager.list().find((agent) => (
						agent.sessionPath &&
						agent.sessionEnvironment === entry.environment &&
						(entry.environment !== "wsl" || (
							agent.wslDistro === entry.wslDistro &&
							agent.wslUser === entry.wslUser
						)) &&
						canonicalizeSessionPath(agent.sessionPath, entry.environment) === normalizedTarget
					));
					if (usingAgent) {
						throw new Error(mainCopy("session.inUseDeleteBlocked", { title: usingAgent.title }));
					}
					await sessionScanner.delete(entry.filePath);
				}
				await sessionCatalog.remove(sessionId);
				void appLogger.info("session", "Catalog session deleted", { sessionId, filePath: entry.filePath });
				sendToRenderer(ipcChannels.sessionsCatalogRefreshed, { projectId: entry.projectId });
				return true;
			} catch (error) {
				// 会话删除失败（文件删除失败/记录移除失败/会话使用中拦截）也要留痕，便于事后追踪。
				void appLogger.error("session", "Catalog session delete failed", {
					sessionId,
					filePath: entry.filePath,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogArchive,
		async (sessionId: string) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return false;
			// 运行中的会话不能归档（同删除）：移动文件会破坏 pi 对当前写入位置的引用。
			if (
				sessionRuntimeCoordinator.getTarget(sessionId) ||
				sessionRuntimeCoordinator.isActivating(sessionId)
			) {
				throw new Error(mainCopy("session.stopBeforeDelete"));
			}
			const archivedPath = await sessionScanner.archive(entry.filePath);
			await sessionCatalog.remove(sessionId);
			void appLogger.info("session", "Session archived", { sessionId, archivedPath });
			return true;
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogUnarchive,
		async (archivedPath: string) => {
			// 校验入参：归档路径必须是 .pideck-archive 目录内的 JSONL，防路径穿越。
			if (typeof archivedPath !== "string" || !archivedPath.endsWith(".jsonl")) {
				throw new Error(mainCopy("session.invalidArchivePath"));
			}
			const restoredPath = await sessionScanner.unarchive(archivedPath);
			void appLogger.info("session", "Session restored from archive", { restoredPath });
			return true;
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogListArchived,
		async () => sessionScanner.listArchived(),
	);
	router.handle(
		ipcChannels.sessionsCatalogReadMessages,
		async (sessionId: string) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return [];
			const content = await sessionScanner.readSessionRawText(entry.filePath);
			return agentManager.readSessionDisplayMessages(entry.filePath, sessionId, content);
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogReadMessagePage,
		async (sessionId: string, before?: number, pageSize?: number, options?: { unit?: "message" | "turn"; beforeEntryId?: string }) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return { messages: [], total: 0, nextBefore: null };
			// unit=turn（2026-08 激活分页）：页边界对齐完整轮次，pageSize 复用为轮次数（上限 10）；
			// 游标协议不变（before/nextBefore 为绝对消息下标，与运行时数组同一下标空间）；
			// beforeEntryId 供已激活会话以运行时窗口首条消息为锚点首次补历史。
			if (options?.unit === "turn") {
				// 缓存优先（2026-11）：运行中会话翻历史先在主进程内存缓存切片，命中免文件 IO；
				// 未命中（缓存未覆盖/非活跃会话）回退 SessionHistoryReader 读文件。
				// 注意：缓存按 transient agentId 键控，必须经 coordinator 把稳定 sessionId
				// 解析成当前运行时 agentId；解析不到（非活跃/终端绑定）直接走文件路径。
				if (options.beforeEntryId || typeof before === "number") {
					const target = sessionRuntimeCoordinator.getTarget(sessionId);
					if (target) {
						const cached = await agentManager.tryReadRuntimeTurnPage(entry.filePath, target.agentId, {
							beforeEntryId: options.beforeEntryId,
							before,
							turnCount: pageSize,
						}).catch(() => null);
						if (cached) return cached;
					}
				}
				return agentManager.readSessionDisplayTurnPage(entry.filePath, sessionId, before, pageSize, options.beforeEntryId);
			}
			return agentManager.readSessionDisplayMessagePage(entry.filePath, sessionId, before, pageSize);
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogReadProcessEvents,
		async (sessionId: string): Promise<SessionProcessEvent[]> => {
			if (typeof sessionId !== "string" || !sessionId.trim()) return [];
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return [];
			const content = await sessionScanner.readSessionRawText(entry.filePath);
			return parseSessionProcessEvents(content);
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogReadReferenceMessages,
		(sessionId: string) => readCatalogSessionReferenceMessages(sessionId),
	);
	router.handle(
		ipcChannels.sessionsCatalogGetContextControllerState,
		async (sessionId: string) => {
			if (typeof sessionId !== "string" || !sessionId.trim()) {
				return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
			}
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
			try {
				const content = await sessionScanner.readSessionRawText(entry.filePath);
				return parseContextControllerStateFromJsonl(content);
			} catch {
				return { ...DEFAULT_CONTEXT_CONTROLLER_STATE };
			}
		},
	);
	// 按需读取消息完整文本（工具结果截断后的「查看完整输出」）：
	// 入参校验在边界（渲染层数据不可信），agentId/messageId 必须为非空字符串。
	// 运行期路径（agentId 绑定）不可用时（历史会话 _viewer 投影 / agent 已退出）
	// 回退会话文件定位（sessionId → catalog filePath），保证历史浏览同样可展开全文。
	router.handle(
		ipcChannels.sessionsCatalogReadMessageFullText,
		async (
			sessionId: unknown,
			agentId: unknown,
			messageId: unknown,
			entryId?: unknown,
		) => {
			if (
				typeof agentId !== "string" ||
				!agentId.trim() ||
				typeof messageId !== "string" ||
				!messageId.trim()
			) {
				throw new Error("Invalid message full-text request");
			}
			if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) {
				throw new Error("Invalid sessionId");
			}
			if (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim())) {
				throw new Error("Invalid entryId");
			}
			try {
				return await agentManager.readMessageFullText(
					agentId,
					messageId,
					entryId as string | undefined,
				);
			} catch (error) {
				if (typeof sessionId === "string" && sessionId.trim()) {
					const record = sessionCatalog.get(sessionId);
					if (record?.filePath) {
						return agentManager.readMessageFullTextFromFile(
							record.filePath,
							messageId,
							entryId as string | undefined,
						);
					}
				}
				throw error;
			}
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogCopy,
		async (sessionId: string) => {
			const result = await copyCatalogSession(sessionId);
			void appLogger.info("session", "Session copied", {
				sessionId,
				targetSessionId: result.cancelled ? undefined : result.targetSessionId,
			});
			return result;
		},
	);
	router.handle(
		ipcChannels.sessionsCatalogExportHtml,
		async (sessionId: string) => {
			const result = await exportCatalogSessionHtml(sessionId);
			void appLogger.info("session", "Session exported (catalog HTML)", {
				sessionId,
				path: result.path,
			});
			return result;
		},
	);
	router.handle(
		ipcChannels.sessionsSendPrompt,
		async (input: SendSessionPromptInput) => {
			const startedAt = Date.now();
			void appLogger.info("session", "Session prompt IPC received", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				messageLength: input.message.length,
				imageCount: input.images?.length ?? 0,
			});
			try {
				const result = await sessionRuntimeCoordinator.send(input);
				if (result.agentId) {
					const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
					if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
				}
				void appLogger.info("session", "Session prompt IPC completed", {
					sessionId: input.sessionId,
					requestId: input.requestId,
					agentId: result.agentId,
					accepted: result.accepted,
					delivery: "delivery" in result ? result.delivery : undefined,
					totalMs: Date.now() - startedAt,
				});
				return result;
			} catch (error) {
				void appLogger.warn("session", "Session prompt IPC failed", {
					sessionId: input.sessionId,
					requestId: input.requestId,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);
	router.handle(
		ipcChannels.sessionsUiResponse,
		(input: SessionUiResponseInput) => sessionRuntimeCoordinator.respondToUi(input),
	);
	router.handle(
		ipcChannels.sessionsRuntimeList,
		() => sessionRuntimeCoordinator.listRuntimes(),
	);
	router.handle(
		ipcChannels.sessionsRuntimeActivate,
		async (sessionId: string) => {
			const startedAt = Date.now();
			void appLogger.info("session-perf", "Runtime activation IPC started", { sessionId });
			const result = await sessionRuntimeCoordinator.activateRuntime(sessionId);
			void appLogger.info("session-perf", "Runtime activation IPC completed", {
				sessionId,
				ok: result.ok,
				activationMs: Date.now() - startedAt,
			});
			return result;
		},
	);
	// 渲染层切换会话时汇报聚焦会话；主进程据此判断 Ask 类请求是否需要桌面通知
	router.handle(
		ipcChannels.sessionsSetFocusedSession,
		(sessionId: unknown) => {
			sessionRuntimeCoordinator.setFocusedSession(
				typeof sessionId === "string" && sessionId.trim()
					? sessionId.trim()
					: undefined,
			);
		},
	);
	router.handle(
		ipcChannels.sessionsRuntimeStop,
		(target: SessionRuntimeTarget) => stopSessionRuntime(target),
	);
	router.handle(
		ipcChannels.sessionsRuntimeAbort,
		(target: SessionRuntimeTarget) => sessionRuntimeCoordinator.abortRuntime(target),
	);
	router.handle(
		ipcChannels.sessionsRuntimeRestart,
		async (target: SessionRuntimeTarget) => {
			terminalManager.closeAgent(target.agentId);
			const result = await sessionRuntimeCoordinator.restartRuntime(target);
			if (result.ok) {
				// A --no-session restart is a binding replacement, not a close. Its
				// higher generation state event clears old runtime UI without deleting
				// the transient SessionRecord from the renderer.
				if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
				emitReplacementState(result.value.runtime, false);
			}
			return result;
		},
	);
	router.handle(
		ipcChannels.sessionsRuntimeCompact,
		(target: SessionRuntimeTarget, prompt?: string) =>
			sessionRuntimeCoordinator.compactRuntime(target, prompt),
	);
	router.handle(
		ipcChannels.sessionsRuntimeState,
		(target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.getRuntimeState(target),
	);
	router.handle(
		ipcChannels.sessionsRuntimeCommands,
		(target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.listRuntimeCommands(target),
	);
	router.handle(
		ipcChannels.sessionsRuntimeListModels,
		(target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.listRuntimeModels(target),
	);
	router.handle(
		ipcChannels.sessionsRuntimeExportHtml,
		async (target: SessionRuntimeTarget) => {
			const result = await sessionRuntimeCoordinator.exportRuntimeHtml(target);
			void appLogger.info("session", "Session exported (runtime HTML)", {
				sessionId: target.sessionId,
				ok: result.ok,
			});
			return result;
		},
	);
	router.handle(
		ipcChannels.sessionsRuntimeEditMessage,
		(target: SessionRuntimeTarget, messageId: string, newText: string) =>
			sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText),
	);
	router.handle(
		ipcChannels.sessionsRuntimeDeleteMessage,
		(target: SessionRuntimeTarget, messageId: string) =>
			sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId),
	);
	router.handle(
		ipcChannels.sessionsRuntimePrepareResend,
		(target: SessionRuntimeTarget, messageId: string) =>
			sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId),
	);
	router.handle(
		ipcChannels.sessionsRuntimeSetModel,
		(
			target: SessionRuntimeTarget,
			provider: string,
			modelId: string,
		) => sessionRuntimeCoordinator.setRuntimeModel(target, provider, modelId),
	);
	router.handle(
		ipcChannels.sessionsRuntimeSetThinking,
		(target: SessionRuntimeTarget, level: string) =>
				sessionRuntimeCoordinator.setRuntimeThinking(target, level),
	);
	router.handle(
		ipcChannels.sessionsRuntimeClone,
		async (target: SessionRuntimeTarget) => {
			const validated = sessionRuntimeCoordinator.validateTarget(target);
			if (!validated.ok) return validated;
			try {
				const value = await replaceAgentSession(
					target.agentId,
					() => agentManager.cloneSession(target.agentId),
				);
				void appLogger.info("session", "Session cloned", { sessionId: target.sessionId });
				return {
					ok: true as const,
					value,
				};
			} catch (error) {
				return {
					ok: false as const,
					error: {
						code: "SESSION_COMMAND_FAILED" as const,
						debugDetails: error instanceof Error ? error.message : String(error),
					},
				};
			}
		},
	);
	// fork 与 clone 共用 replaceAgentSession：RPC 成功后刷新 sessionPath / 消息投影
	router.handle(
		ipcChannels.sessionsRuntimeGetForkMessages,
		(target: SessionRuntimeTarget) =>
			sessionRuntimeCoordinator.getRuntimeForkMessages(target),
	);
	router.handle(
		ipcChannels.sessionsRuntimeFork,
		async (target: SessionRuntimeTarget, entryId: string) => {
			const validated = sessionRuntimeCoordinator.validateTarget(target);
			if (!validated.ok) return validated;
			try {
				const value = await replaceAgentSession(
					target.agentId,
					() => agentManager.forkSession(target.agentId, entryId),
				);
				void appLogger.info("session", "Session forked", { sessionId: target.sessionId, entryId });
				return {
					ok: true as const,
					value,
				};
			} catch (error) {
				return {
					ok: false as const,
					error: {
						code: "SESSION_COMMAND_FAILED" as const,
						debugDetails: error instanceof Error ? error.message : String(error),
					},
				};
			}
		},
	);
	router.handle(
		ipcChannels.codexSessionsScan,
		async (projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await codexSessionImporter.scan(project.path);
			void appLogger.debug("session", "Codex sessions scanned", { projectId });
			return result;
		},
	);
	router.handle(
		ipcChannels.codexSessionsImport,
		async (projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await codexSessionImporter.import(project.path, sourcePaths);
			void appLogger.info("session", "Codex sessions imported", {
				projectId,
				sourceCount: sourcePaths.length,
			});
			return result;
		},
	);
	router.handle(
		ipcChannels.claudeSessionsScan,
		async (projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await claudeSessionImporter.scan(project.path);
			void appLogger.debug("session", "Claude sessions scanned", { projectId });
			return result;
		},
	);
	router.handle(
		ipcChannels.claudeSessionsImport,
		async (projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await claudeSessionImporter.import(project.path, sourcePaths);
			void appLogger.info("session", "Claude sessions imported", {
				projectId,
				sourceCount: sourcePaths.length,
			});
			return result;
		},
	);
	router.handle(
		ipcChannels.openCodeSessionsScan,
		async (projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await openCodeSessionImporter.scan(project.path);
			void appLogger.debug("session", "OpenCode sessions scanned", { projectId });
			return result;
		},
	);
	router.handle(
		ipcChannels.openCodeSessionsImport,
		async (projectId: string, sourcePaths: string[]) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const result = await openCodeSessionImporter.import(project.path, sourcePaths);
			void appLogger.info("session", "OpenCode sessions imported", {
				projectId,
				sourceCount: sourcePaths.length,
			});
			return result;
		},
	);
}
