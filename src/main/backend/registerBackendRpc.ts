import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type {
	MainProcessLocale,
	MainProcessTranslationKey,
} from "../../shared/i18n/mainProcessCopy";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";
import type { AgentManager } from "../pi/AgentManager";
import type { PiLocator } from "../pi/PiLocator";
import type { ModelSpecsStore } from "../pi/modelSpecsStore";
import { fetchModelList, getCachedModelList } from "../pi/modelListCache";
import { testPiProxy } from "../pi/PiProxyTester";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { FileSystemService } from "../fs/FileSystemService";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { ConfigManager } from "../config/ConfigManager";
import type { PromptManager } from "../prompts/PromptManager";
import type { XuePromptManager } from "../prompts/XuePromptManager";
import type { SkillManager } from "../skills/SkillManager";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { SecurityStore } from "../security/SecurityStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { applyDesktopProxy } from "../settings/DesktopProxy";
import type { VisionBridgeConfigManager } from "../settings/visionBridgeConfig";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { CodexSessionImporter } from "../sessions/CodexSessionImporter";
import type { ClaudeSessionImporter } from "../sessions/ClaudeSessionImporter";
import type { OpenCodeSessionImporter } from "../sessions/OpenCodeSessionImporter";
import type { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import type { UsageStatsService } from "../usageStats/UsageStatsService";
import type { WebServiceManager } from "../web/WebServiceManager";
import type { createAppUpdateService } from "../update/AppUpdateService";
import { RELEASES_URL } from "../update/AppUpdateService";
import type { RpcRouter } from "../transport/RpcRouter";
import type { BackendHost } from "./Backend";
import type { SessionRuntimeBridge } from "./sessionRuntimeBridge";
import { registerUsageStatsIpc } from "../ipc/usageStatsIpc";
import { registerEditorsIpc } from "../ipc/editorsIpc";
import { registerBackgroundsIpc } from "../ipc/backgroundsIpc";
import { registerProjectsIpc } from "../ipc/projectsIpc";
import { registerScratchPadIpc } from "../ipc/scratchPadIpc";
import { registerSecurityIpc } from "../ipc/securityIpc";
import { registerVisionIpc } from "../ipc/visionIpc";
import { registerSessionIpc, scheduleCatalogBackgroundScan } from "../ipc/sessionIpc";
import { registerGitIpc } from "../ipc/gitIpc";
import { registerSystemIpc } from "../ipc/systemIpc";
import { registerStoreIpc } from "../ipc/storeIpc";
import { registerTerminalIpc } from "../ipc/terminalIpc";
import { registerFilesIpc } from "../ipc/filesIpc";
import type { PlatformServices } from "../platform/PlatformServices";
import { resolveBackgroundsDir } from "../backgrounds/BackgroundPaths";
import { BackgroundImageService } from "../backgrounds/BackgroundImageService";
import { createTrashPath } from "../fs/trash";

export interface RegisterBackendRpcDeps {
	router: RpcRouter;
	host: BackendHost;
	platform: PlatformServices;
	mainCopy: (
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	) => string;
	getLocale: () => MainProcessLocale;
	runtimeBridge: SessionRuntimeBridge;
	services: {
		projectStore: ProjectStore;
		fileSystemService: FileSystemService;
		sessionScanner: SessionScanner;
		sessionCatalog: SessionCatalog;
		sessionRuntimeCoordinator: SessionRuntimeCoordinator;
		codexSessionImporter: CodexSessionImporter;
		claudeSessionImporter: ClaudeSessionImporter;
		openCodeSessionImporter: OpenCodeSessionImporter;
		settingsStore: SettingsStore;
		securityStore: SecurityStore;
		worktreeService: WorktreeService;
		gitService: GitService;
		piLocator: PiLocator;
		agentManager: AgentManager;
		configManager: ConfigManager;
		promptManager: PromptManager;
		xuePromptManager: XuePromptManager;
		skillManager: SkillManager;
		extensionManager: ExtensionManager;
		projectResourceManager: ProjectResourceManager;
		webServiceManager: WebServiceManager;
		terminalManager: TerminalSessionManager;
		appLogger: AppLogger;
		rpcLogger: RpcLogger;
		usageStatsService: UsageStatsService | null;
		modelSpecsStore: ModelSpecsStore;
		visionBridge: VisionBridgeConfigManager;
		appUpdateService: ReturnType<typeof createAppUpdateService>;
	};
}

export function registerBackendRpc(deps: RegisterBackendRpcDeps): void {
	const { router, host, platform, mainCopy, getLocale, runtimeBridge, services } = deps;
	const paths = platform.paths;
	const {
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
	} = services;

	// 用量统计：业务在 UsageStatsService，handler 薄层只校验/适配
	registerUsageStatsIpc(router, usageStatsService);

	registerEditorsIpc(router, {
		settingsStore,
		appLogger,
		dialogs: platform.dialogs,
		openPath: platform.shell.openPath,
	});

	const backgroundsDir = resolveBackgroundsDir(paths.userData);
	const backgroundImageService = new BackgroundImageService({
		directory: backgroundsDir,
		trashPath: createTrashPath({
			trashItem: (p) => platform.shell.trashItem(p),
			logger: appLogger,
		}),
		logger: appLogger,
	});
	registerBackgroundsIpc(router, {
		backgroundImageService,
		dialogs: platform.dialogs,
	});

	registerProjectsIpc(router, {
		projectStore,
		settingsStore,
		gitService,
		worktreeService,
		agentManager,
		appLogger,
		projectResourceManager,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		dialogs: platform.dialogs,
		sendToRenderer: host.sendToRenderer,
	});

	registerScratchPadIpc(router, {
		appLogger,
		userDataDir: paths.userData,
		trashPath: createTrashPath({
			trashItem: (p) => platform.shell.trashItem(p),
			logger: appLogger,
		}),
		dialogs: platform.dialogs,
	});

	// 安全管理：配置读写 + 会话等级覆盖（SecurityStore 负责持久化与策略快照）
	registerSecurityIpc(router, {
		securityStore,
		log: (domain, message, details) => void appLogger.info(domain, message, details),
	});

	// 视觉桥配置（~/.pi/agent/pi-deck-vision.json）界面化编辑；运行时由 pi-deck-vision 扩展消费
	registerVisionIpc(router, {
		visionBridge,
		log: (message, ...args) => appLogger.info("vision", message, ...args),
	});

	registerSessionIpc(router, {
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
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		sendToRenderer: host.sendToRenderer,
		emitSessionRuntimeEvent: runtimeBridge.emitSessionRuntimeEvent,
		emitSessionRuntimeDetach: runtimeBridge.emitSessionRuntimeDetach,
		createAnonymousSession: runtimeBridge.createAnonymousSession,
		stopSessionRuntime: runtimeBridge.stopSessionRuntime,
		emitReplacementState: runtimeBridge.emitReplacementState,
		readCatalogSessionReferenceMessages: runtimeBridge.readCatalogSessionReferenceMessages,
		copyCatalogSession: runtimeBridge.copyCatalogSession,
		exportCatalogSessionHtml: runtimeBridge.exportCatalogSessionHtml,
		replaceAgentSession: runtimeBridge.replaceAgentSession,
	});

	// ── 启动预扫描（2026-08 展开项目卡顿优化）──
	// 延迟 3s 启动、项目间错开 1.5s 逐个调度后台扫描：预热 catalog 缓存，
	// 用户首次展开项目时直接命中缓存回显，不再同步全量扫描卡 UI。
	// 错开 + 协调器去重/冷却（sessionIpc 内）保证不与用户触发的扫描并发重扫。
	const prewarmTimer = setTimeout(() => {
		const projects = projectStore.list();
		projects.forEach((project, index) => {
			const timer = setTimeout(() => {
				scheduleCatalogBackgroundScan(project.id, async () => {
					try {
						const settings = settingsStore.get();
						let projectPath = project.path;
						if (settings.wslEnabled && settings.wslDistro) {
							projectPath = projectPath
								.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
								.replace(/\\/g, "/");
						}
						const summaries = await sessionScanner.list(projectPath);
						await sessionCatalog.mergeScanned(
							project.id,
							summaries,
							settings.wslEnabled ? { wslDistro: settings.wslDistro, wslUser: settings.wslUser } : {},
						);
					} catch (error) {
						void appLogger.warn("session", "Catalog prewarm scan failed", {
							projectId: project.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				});
			}, index * 1500);
			timer.unref?.();
		});
	}, 3000);
	prewarmTimer.unref?.();

	registerGitIpc(router, {
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		getLocale,
		gitService,
		piLocator,
		projectStore,
		settingsStore,
		worktreeService,
	});

	registerSystemIpc(router, {
		piLocator,
		settingsStore,
		configManager,
		agentManager,
		skillManager,
		appLogger,
		rpcLogger,
		sessionRuntimeCoordinator,
		modelSpecsStore,
		// 进程监控停止 agent：按 agentId 走完整会话停止链路（含 detach 推送）
		stopAgentFromMonitor: runtimeBridge.stopAgentFromMonitor,
		mainWindowControls: host.mainWindowControls,
		platformApplication: platform.application,
		platformPaths: platform.paths,
		platformShell: platform.shell,
		platformTheme: platform.theme,
		toggleDevTools: () => host.mainWindowControls.toggleDevTools(),
		sendToRenderer: host.sendToRenderer,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		checkForAppUpdate: appUpdateService.checkForAppUpdate,
		downloadUpdateAsset: appUpdateService.downloadUpdateAsset,
		openDownloadedUpdate: appUpdateService.openDownloadedUpdate,
		openExternalUrl: host.openExternalUrl,
		extensionManager,
		// 设置变更副作用（代理 / 主题 / WSL / Web 服务）
		applyDesktopProxy: (settings) => applyDesktopProxy(settings, platform.proxy),
		testPiProxy,
		applyWebServiceSettings: (settings) => webServiceManager.applySettings(settings),
		restartWebService: (settings) => webServiceManager.restart(settings),
		applyNativeThemeSource: (settings) => platform.theme.setSource(settings.theme === "system" || settings.theme === "light" || settings.theme === "dark" ? settings.theme : "system"),
		refreshTrayContextMenu: () => host.refreshTrayContextMenu(),
		notifyTitleBarChange: () => {
			// Title bar change notification
		},
		setSessionCatalogIdentityContext: (ctx) => sessionCatalog.setIdentityContext(ctx),
		resolveWslEnvironment: async (distro, user, logger) => {
			const { resolveWslEnvironment: resolveWsl } = await import("../wsl/WslEnvironment");
			return resolveWsl(distro, user, logger);
		},
		configureSessionScannerWsl: (env) => sessionScanner.configureWsl(env),
		clearSessionScannerWsl: () => sessionScanner.clearWsl(),
		configureSkillManagerWsl: (env) => skillManager.configureWsl(env),
		configurePromptManagerWsl: (env) => promptManager.configureWsl(env),
		configureExtensionManagerWsl: (env) => extensionManager.configureWsl(env),
		configureConfigManagerWsl: (env) => configManager.configureWsl(env),
		configureXuePromptManagerWsl: (env) => xuePromptManager.configureWsl(env),
		sessionCommandIpcError: runtimeBridge.sessionCommandIpcError,
		// 重启路径需要同步 isQuitting / 停服务，避免 closeToTray 吞掉 relaunch
		restartApplication: host.restartApplication,
		webServiceManager,
		terminalManager,
		RELEASES_URL,
	});

	registerStoreIpc(router, {
		promptManager,
		skillManager,
		xuePromptManager,
		extensionManager,
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
	});

	registerTerminalIpc(router, {
		appLogger,
		sessionRuntimeCoordinator,
		terminalManager,
		toSessionCommandIpcError: runtimeBridge.sessionCommandIpcError,
	});

	// ── 配置管理 ──────────────────────────────────────

	// 后台预取 pi --list-models 缓存：registerIpc 完成后异步执行一次，
	// 使用户首次打开模型/思考选择器时不需要等待 fork pi 进程。
	// 已有缓存或在途请求时不会重复 fork。
	if (typeof piLocator !== "undefined" && typeof settingsStore !== "undefined") {
		setTimeout(() => {
			if (!getCachedModelList()) {
				void fetchModelList(piLocator, settingsStore).catch(() => {
					// 预取失败静默；用户首次点击选择器时会自动重试。
				});
			}
		}, 500);
	}

	// 预载模型规格索引（sql.js WASM + 全表读入约数十 ms，后台完成避免首次失焦卡顿）
	modelSpecsStore.warm();

	registerFilesIpc(router, {
		fileSystemService,
		projectStore,
		settingsStore,
		appLogger,
		dialogs: platform.dialogs,
		platformShell: platform.shell,
		getAuthorizedRoots: () => [
			...projectStore.list().map((project) => project.path),
			promptManager.getDir(),
			...skillManager.getDirs(),
			join(paths.home, ".pi", "agent"),
			paths.userData,
		],
	});

	// renderer 挂载后读取 pending 跳转目标；只在 renderer 完成实际聚焦后 ACK，
	// 防止 live push 后 reload 又重复消费旧通知，也防止旧 ACK 清掉新通知。
	router.handle(ipcChannels.appGetFocusTargetPending, () => host.peekPendingFocusTarget());
	router.handle(ipcChannels.appAcknowledgeFocusTarget, (id: string) => {
		if (typeof id !== "string" || id.length === 0 || id.length > 128) return;
		host.acknowledgeFocusTarget(id);
	});
}
