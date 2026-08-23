import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import {
	mainProcessT,
	normalizeMainProcessLocale,
	type MainProcessLocale,
	type MainProcessTranslationKey,
} from "../../shared/i18n/mainProcessCopy";
import { toAbsoluteSessionPath } from "../../shared/sessionIdentity";
import type {
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionRecord,
} from "../../shared/types";
import { ProjectStore } from "../projects/ProjectStore";
import { FileSystemService } from "../fs/FileSystemService";
import { SessionScanner } from "../sessions/SessionScanner";
import { SessionCatalog } from "../sessions/SessionCatalog";
import { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import {
	DEFAULT_CONTEXT_CONTROLLER_STATE,
	parseContextControllerStateFromJsonl,
} from "../sessions/contextControllerStateReader";
import { CodexSessionImporter } from "../sessions/CodexSessionImporter";
import { ClaudeSessionImporter } from "../sessions/ClaudeSessionImporter";
import { OpenCodeSessionImporter } from "../sessions/OpenCodeSessionImporter";
import { SettingsStore } from "../settings/SettingsStore";
import { SecurityStore } from "../security/SecurityStore";
import { applyDesktopProxy } from "../settings/DesktopProxy";
import { GitService } from "../git/GitService";
import { WorktreeService } from "../git/WorktreeService";
import { ConfigManager } from "../config/ConfigManager";
import { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import { PromptManager } from "../prompts/PromptManager";
import { XuePromptManager } from "../prompts/XuePromptManager";
import { SkillManager } from "../skills/SkillManager";
import { ExtensionManager } from "../extensions/ExtensionManager";
import { ProjectResourceManager } from "../projects/ProjectResourceManager";
import { listVisibleProjects } from "../ipc/projectsIpc";
import { AppLogger } from "../logging/AppLogger";
import { setAppLogger } from "../logging/sharedLogger";
import { RpcLogger } from "../logging/RpcLogger";
import { UsageStatsService } from "../usageStats/UsageStatsService";
import { PiLocator } from "../pi/PiLocator";
import { AgentManager } from "../pi/AgentManager";
import { fetchModelList, refreshModelList } from "../pi/modelListCache";
import { ModelSpecsStore } from "../pi/modelSpecsStore";
import { VisionBridgeConfigManager } from "../settings/visionBridgeConfig";
import { createAppUpdateService } from "../update/AppUpdateService";
import { WebServiceManager } from "../web/WebServiceManager";
import type { Backend, CreateBackendOptions } from "./Backend";
import { createSessionRuntimeBridge } from "./sessionRuntimeBridge";
import { registerBackendRpc } from "./registerBackendRpc";
import { startBackendStartupTasks } from "./backendStartupTasks";
import { createTrashPath } from "../fs/trash";

export async function createBackend(options: CreateBackendOptions): Promise<Backend> {
	const { router, host, platform, runtime } = options;
	const paths = platform.paths;
	const appInfo = platform.application;

	function currentMainProcessLocale(): MainProcessLocale {
		const language = settingsStore.get().language;
		if (language === "pseudo") return "en-US";
		return normalizeMainProcessLocale(
			language === "system" ? appInfo.getLocale() : language,
		);
	}

	function mainCopy(
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	): string {
		return mainProcessT(currentMainProcessLocale(), key, params);
	}

	const appLogger = new AppLogger({
		directory: join(paths.userData, "logs"),
	});
	setAppLogger(appLogger);
	const rpcLogger = new RpcLogger({
		directory: join(paths.userData, "logs", "rpc"),
	});

	const trashPath = createTrashPath({
		trashItem: (p) => platform.shell.trashItem(p),
		logger: appLogger,
	});

	const projectStore = new ProjectStore({
		projectsFile: join(paths.userData, "projects.json"),
		chatPathFile: join(paths.userData, "chat-path.json"),
		defaultChatProjectPath: join(paths.userData, "chat-workspace"),
	});
	const fileSystemService = new FileSystemService(trashPath);
	const sessionScanner = new SessionScanner(
		mainCopy,
		paths.home,
		trashPath,
		paths.downloads,
		paths.userData,
	);
	const codexSessionImporter = new CodexSessionImporter(mainCopy, paths.home);
	const claudeSessionImporter = new ClaudeSessionImporter(mainCopy, paths.home);
	const openCodeSessionImporter = new OpenCodeSessionImporter(mainCopy, paths.home);
	const settingsStore = new SettingsStore({
		desktopSettingsFile: join(paths.userData, "settings.json"),
		piAgentSettingsFile: join(paths.home, ".pi", "agent", "settings.json"),
		getSystemLocale: () => appInfo.getLocale(),
	});
	const securityStore = new SecurityStore({
		settingsStore,
		log: (domain, message, details) => void appLogger?.info(domain, message, details),
		userDataDir: paths.userData,
	});

	const usageStatsService = new UsageStatsService({
		agentDir: join(paths.home, ".pi", "agent"),
		logger: {
			info: (message) => void appLogger?.info("usage-stats", message),
			warn: (message) => void appLogger?.warn("usage-stats", message),
		},
	});
	const gitService = new GitService(trashPath);
	const worktreeService = new WorktreeService(mainCopy, trashPath);
	const piLocator = new PiLocator(mainCopy, paths.home);
	const configManager = new ConfigManager(
		join(paths.home, ".pi", "agent"),
		mainCopy,
		platform.fetch ?? globalThis.fetch,
	);
	const promptManager = new PromptManager(
		paths.home,
		mainCopy,
		() => settingsStore.get(),
		(patch) => settingsStore.update(patch),
		{
			openPath: (p) => platform.shell.openPath(p),
			trashPath,
		},
	);
	const wasmLocateDir = appInfo.isPackaged
		? join(paths.resourcesPath, "app.asar.unpacked", "node_modules", "sql.js", "dist")
		: join(paths.appPath, "node_modules", "sql.js", "dist");
	const xuePromptManager = new XuePromptManager(
		paths.home,
		join(appInfo.isPackaged ? paths.resourcesPath : paths.appPath, appInfo.isPackaged ? "" : "resources", "xueprompts.db"),
		wasmLocateDir,
		appInfo.isPackaged,
	);
	const skillManager = new SkillManager(paths.home, mainCopy, {
		openPath: (p) => platform.shell.openPath(p),
		trashPath,
	});
	const extensionManager = new ExtensionManager(
		piLocator,
		() => settingsStore.get(),
		() => settingsStore.get(),
		(patch) => settingsStore.update(patch),
		mainCopy,
		trashPath,
	);
	const projectResourceManager = new ProjectResourceManager(
		(projectId) => projectStore.get(projectId),
		mainCopy,
		trashPath,
	);

	let getSessionIdForAgent: ((agentId: string) => string | undefined) | undefined;

	const agentManager = new AgentManager(
		(id) => projectStore.get(id),
		(channel, ...args) => host.sendToRenderer(channel, ...args),
		settingsStore,
		configManager,
		rpcLogger,
		appLogger,
		undefined,
		mainCopy,
		// 每次 spawn Agent 前异步刷新模型列表缓存（防用户直接改 models.json/auth.json 不生效）。
		() => {
			if (piLocator && settingsStore) {
				void refreshModelList(piLocator, settingsStore).catch(() => undefined);
			}
		},
		securityStore,
		// spawn pi 前预检并修复旧版私有头行或路径与 session header 粘连的损坏文件。
		(filePath) => sessionScanner.repairCorruptSessionHeader(filePath),
		(agentId) => getSessionIdForAgent?.(agentId),
		{
			appName: appInfo.name,
			appPath: paths.appPath,
			resourcesPath: paths.resourcesPath,
			isPackaged: appInfo.isPackaged,
			notifications: platform.notifications,
			focusSessionFromNotification: (s) => host.focusSessionFromNotification(s),
			hasLiveWindow: () => host.hasLiveWindow(),
		},
	);

	// 声明 webServiceManager 变量，稍后在 sessionRuntimeCoordinator 初始化后挂载完整回调
	let webServiceManager: WebServiceManager;

	const terminalManager = new TerminalSessionManager(
		(agentId) => agentManager.getCwd(agentId),
		(channel, payload) => host.sendToRenderer(channel, payload),
	);

	await settingsStore.load();
	platform.application.hideApplicationMenu();
	const initialSessionSettings = settingsStore.get();
	const sessionCatalog = new SessionCatalog(
		join(paths.userData, "session-catalog.json"),
		initialSessionSettings.wslEnabled
			? { wslDistro: initialSessionSettings.wslDistro, wslUser: initialSessionSettings.wslUser }
			: {},
		// 会话路径统一绝对化：pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，
		// get_state 返回的 sessionFile 是相对 cwd 的；与扫描器绝对路径 originKey 不一致
		// 会导致同一会话在侧栏出现两条记录。加载与写入边界都经此归一化。
		(projectId, filePath, environment) => {
			const project = projectStore.get(projectId);
			if (!project) return filePath;
			return toAbsoluteSessionPath(filePath, project.path, environment);
		},
	);
	await sessionCatalog.load();

	const sendAgentPrompt = async (
		input: SendPromptInput,
	): Promise<SendPromptResult> => {
		const result = await agentManager.sendPrompt(input);
		void appLogger.info("agent", "Prompt sent", {
			agentId: input.agentId,
			messageLength: input.message.length,
			imageCount: input.images?.length ?? 0,
			streamingBehavior: input.streamingBehavior,
		});
		return result;
	};

	const sessionRuntimeCoordinator = new SessionRuntimeCoordinator(
		sessionCatalog,
		agentManager,
		sendAgentPrompt,
		appLogger,
	);
	getSessionIdForAgent = (agentId) => sessionRuntimeCoordinator.getSessionId(agentId);

	const runtimeBridge = createSessionRuntimeBridge({
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
		sendToRenderer: host.sendToRenderer,
	});

	webServiceManager = new WebServiceManager({
		devRendererUrl: runtime?.devRendererUrl,
		// 订阅 pi agent 事件流，供 Web SSE 端点转发给浏览器。
		subscribePiEvents: (handler) => agentManager.addLocalEventListener(
			(agentId, event) => handler(agentId, event as never),
		),
		// agentId → sessionId 路由：pi 事件只有 agentId，SSE 连接按 session 订阅。
		getSessionIdForAgent: (agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
		listProjects: () => projectStore.list(),
		createProject: (path) => projectStore.add(
			path,
			undefined,
			settingsStore.get().wslEnabled ? "wsl" : "windows",
		),
		deleteProject: async (projectId) => {
			if (!projectStore.get(projectId) || projectStore.get(projectId)?.kind === "chat") return false;
			await projectStore.remove(projectId);
			host.sendToRenderer(
				ipcChannels.projectsChanged,
				listVisibleProjects(projectStore, settingsStore),
			);
			return true;
		},
		listModels: () => fetchModelList(piLocator, settingsStore),
		listSessions: (projectId) => {
			const project = projectStore.get(projectId);
			return sessionScanner.list(project?.path);
		},
		getSessionRuntimeMessages: (sessionId) =>
			sessionRuntimeCoordinator.getRuntimeMessages(sessionId),
		listCatalogSessions: async (projectId) => {
			if (!projectId) {
				return sessionCatalog.listEntries()
					.map((entry) => sessionCatalog.getRecord(entry.id))
					.filter((record): record is SessionRecord => Boolean(record));
			}
			const project = projectStore.get(projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			let projectPath = project.path;
			const settings = settingsStore.get();
			if (settings.wslEnabled && settings.wslDistro) {
				projectPath = projectPath
					.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
					.replace(/\\/g, "/");
			}
			const summaries = await sessionScanner.list(projectPath);
			const { wslEnabled, wslDistro, wslUser } = settings;
			const records = await sessionCatalog.mergeScanned(
				projectId,
				summaries,
				wslEnabled ? { wslDistro, wslUser } : {},
			);
			const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(records);
			for (const binding of bindings) {
				const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
				if (tab) runtimeBridge.emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
			}
			return records;
		},
		createSessionDraft: async (input) => {
			const project = projectStore.get(input.projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			const record = await sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.title?.trim() || mainCopy("session.newTitle"),
				environment: settingsStore.get().wslEnabled ? "wsl" : "native",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
			host.sendToRenderer(ipcChannels.sessionsCatalogRefreshed, { projectId: input.projectId });
			return record;
		},
		createAnonymousSession: runtimeBridge.createAnonymousSession,
		updateSessionRecord: async (sessionId, patch) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) throw new Error(mainCopy("session.notFound"));
			const title = patch.title?.trim();
			if (title && title !== entry.title) {
				const target = sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
					if (!renamed.ok) throw runtimeBridge.sessionCommandIpcError(renamed.error);
				} else if (entry.filePath) {
					await sessionScanner.rename(entry.filePath, title);
				}
			}
			const record = await sessionCatalog.update(sessionId, {
				...patch,
				title: title || undefined,
			});
			host.sendToRenderer(ipcChannels.sessionsCatalogRefreshed, { projectId: record.projectId });
			return record;
		},
		deleteSessionRecord: async (sessionId) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) return false;
			if (
				sessionRuntimeCoordinator.getTarget(sessionId) ||
				sessionRuntimeCoordinator.isActivating(sessionId)
			) {
				throw new Error(mainCopy("session.stopBeforeDelete"));
			}
			const projectId = entry.projectId;
			if (entry.filePath) await sessionScanner.delete(entry.filePath);
			await sessionCatalog.remove(sessionId);
			host.sendToRenderer(ipcChannels.sessionsCatalogRefreshed, { projectId });
			return true;
		},
		copySessionRecord: (sessionId) => runtimeBridge.copyCatalogSession(sessionId),
		exportSessionRecordHtml: (sessionId) => runtimeBridge.exportCatalogSessionHtml(sessionId),
		readSessionReferenceMessages: (sessionId) =>
			runtimeBridge.readCatalogSessionReferenceMessages(sessionId),
		readSessionMessages: async (sessionId) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return [];
			const content = await sessionScanner.readSessionRawText(entry.filePath);
			return agentManager.readSessionDisplayMessages(entry.filePath, sessionId, content);
		},
		readSessionMessagePage: async (sessionId, before, pageSize) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry?.filePath) return { messages: [], total: 0, nextBefore: null };
			return agentManager.readSessionDisplayMessagePage(entry.filePath, sessionId, before, pageSize);
		},
		sendSessionPrompt: async (input) => {
			const result = await sessionRuntimeCoordinator.send(input);
			if (result.agentId) {
				const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
				if (tab) runtimeBridge.emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
			}
			return result;
		},
		getContextControllerState: async (sessionId) => {
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
		listSessionRuntimes: () => sessionRuntimeCoordinator.listRuntimes(),
		listPendingUiRequests: () => sessionRuntimeCoordinator.listPendingUiRequests(),
		respondToUi: (input) => sessionRuntimeCoordinator.respondToUi(input),
		listSessionRuntimeModels: (target) => sessionRuntimeCoordinator.listRuntimeModels(target),
		stopSessionRuntime: runtimeBridge.stopSessionRuntime,
		abortSessionRuntime: (target) => sessionRuntimeCoordinator.abortRuntime(target),
		restartSessionRuntime: async (target) => {
			terminalManager.closeAgent(target.agentId);
			const result = await sessionRuntimeCoordinator.restartRuntime(target);
			if (result.ok) {
				if (!result.value.session.noSession) runtimeBridge.emitSessionRuntimeDetach(target);
				runtimeBridge.emitReplacementState(result.value.runtime, false);
			}
			return result;
		},
		compactSessionRuntime: (target, prompt) =>
			sessionRuntimeCoordinator.compactRuntime(target, prompt),
		getSessionRuntimeState: (target) =>
			sessionRuntimeCoordinator.getRuntimeState(target),
		listSessionRuntimeCommands: (target) =>
			sessionRuntimeCoordinator.listRuntimeCommands(target),
		exportSessionRuntimeHtml: (target) =>
			sessionRuntimeCoordinator.exportRuntimeHtml(target),
		editSessionRuntimeMessage: (target, messageId, newText) =>
			sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText),
		deleteSessionRuntimeMessage: (target, messageId) =>
			sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId),
		prepareSessionRuntimeResend: (target, messageId) =>
			sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId),
		setSessionRuntimeModel: (target, provider, modelId) =>
			sessionRuntimeCoordinator.setRuntimeModel(target, provider, modelId),
		setSessionRuntimeThinking: (target, level) =>
			sessionRuntimeCoordinator.setRuntimeThinking(target, level),
		cloneSessionRuntime: async (target) => {
			const validated = sessionRuntimeCoordinator.validateTarget(target);
			if (!validated.ok) return validated;
			try {
				return {
					ok: true as const,
					value: await runtimeBridge.replaceAgentSession(
						target.agentId,
						() => agentManager.cloneSession(target.agentId),
					),
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
	});

	agentManager.onOutput((sourceChannel, payload) => {
		if (sourceChannel === ipcChannels.agentsState && Array.isArray(payload)) {
			for (const tab of payload) {
				if (tab && typeof tab === "object" && typeof tab.id === "string") {
					runtimeBridge.emitSessionRuntimeEvent(tab.id, sourceChannel, tab);
				}
			}
			return;
		}
		if (payload && typeof payload === "object" && "agentId" in payload) {
			const agentId = (payload as { agentId?: unknown }).agentId;
			if (typeof agentId !== "string") return;
			const forwarded = runtimeBridge.emitSessionRuntimeEvent(agentId, sourceChannel, payload);
			if (!forwarded && sourceChannel === ipcChannels.agentsUiRequest) {
				runtimeBridge.cancelUnboundUiRequest(payload);
			}
		}
	});

	await appLogger.info("app", "Application started", {
		version: appInfo.version,
		platform: process.platform,
		arch: process.arch,
		installationType: settingsStore.get().installationType,
	});

	await applyDesktopProxy(settingsStore.get(), platform.proxy);

	const modelSpecsStore = new ModelSpecsStore(
		appInfo.isPackaged
			? join(paths.resourcesPath, "model-specs.db")
			: join(paths.appPath, "resources", "model-specs.db"),
		undefined,
		wasmLocateDir,
		appInfo.isPackaged,
	);

	const visionBridge = new VisionBridgeConfigManager(configManager);

	const appUpdateService = createAppUpdateService({
		logger: appLogger,
		translate: mainCopy,
		emitProgress: (progress) => {
			host.sendToRenderer(ipcChannels.appUpdateProgress, progress);
		},
		platformApp: platform.application,
		platformPaths: platform.paths,
		platformShell: platform.shell,
		platformDownloads: platform.downloads,
	});

	registerBackendRpc({
		router,
		host,
		platform,
		mainCopy,
		getLocale: currentMainProcessLocale,
		runtimeBridge,
		services: {
			projectStore,
			fileSystemService,
			sessionScanner,
			sessionCatalog,
			sessionRuntimeCoordinator,
			codexSessionImporter,
			claudeSessionImporter,
			openCodeSessionImporter,
			settingsStore,
			securityStore,
			worktreeService,
			gitService,
			piLocator,
			agentManager,
			configManager,
			promptManager,
			xuePromptManager,
			skillManager,
			extensionManager,
			projectResourceManager,
			webServiceManager,
			terminalManager,
			appLogger,
			rpcLogger,
			usageStatsService,
			modelSpecsStore,
			visionBridge,
			appUpdateService,
		},
	});

	let postWindowStarted = false;
	let disposed = false;

	return {
		appLogger,
		settingsStore,
		mainCopy,
		resolveSessionIdForAgent: (agentId: string) => sessionRuntimeCoordinator.getSessionId(agentId),
		hasActiveStreaming: () => agentManager.hasActiveStreaming(),
		startAfterWindowCreated: () => {
			if (postWindowStarted || disposed) return;
			postWindowStarted = true;
			startBackendStartupTasks({
				paths,
				host,
				services: {
					projectStore,
					sessionScanner,
					settingsStore,
					piLocator,
					configManager,
					promptManager,
					xuePromptManager,
					skillManager,
					extensionManager,
					webServiceManager,
					appLogger,
				},
			});
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			webServiceManager?.stop().catch(() => undefined);
			terminalManager?.closeAll();
			agentManager?.stopAll();
		},
	};
}
