import type { RpcRouter } from "../transport/RpcRouter";
import { ipcChannels } from "../../shared/ipc";
import type { RpcLogEntry } from "../../shared/types/rpcLog";
import type {
	AppLogLevel,
	AppLogQuery,
	AppSettings,
	AppUpdateAsset,
	AvailableModel,
	CreatePiSkillInput,
	SessionCommandResult,
	SessionRuntimeTarget,
} from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type {
	ConfigManager,
	PiAuthFile,
	PiModelsFile,
	PiSettings,
} from "../config/ConfigManager";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { SkillManager } from "../skills/SkillManager";
import { fetchModelList, invalidateModelListCache, getCachedModelList, refreshModelList } from "../pi/modelListCache";
import type { ModelSpecsStore } from "../pi/modelSpecsStore";
import { getProcessSnapshot } from "../process/ProcessMonitor";
import type { ProcessMetricsSnapshot } from "../../shared/types";
import { getWslExe } from "../wsl/wslExe";
import { listWebNetworkAddresses } from "../web/WebNetwork";
import type { MainWindowControls } from "../window/MainWindowControlsContract";
import type {
	PlatformApplication,
	PlatformPaths,
	PlatformProxy,
	PlatformShell,
	PlatformTheme,
} from "../platform/PlatformServices";

/**
 * IPC 边界校验：RPC 日志条目必须字段齐全，防止渲染层传伪造对象写盘。
 */
function isRpcLogEntry(value: unknown): value is RpcLogEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		typeof entry.agentId === "string" &&
		(entry.direction === "send" || entry.direction === "recv") &&
		typeof entry.summary === "string" &&
		typeof entry.time === "number"
	);
}

export type SystemIpcDeps = {
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	configManager: ConfigManager;
	agentManager: AgentManager;
	skillManager: SkillManager;
	appLogger: AppLogger;
	rpcLogger: RpcLogger;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	/** 进程监控停止 agent：按 agentId 走完整会话停止链路（含 detach 推送），装配层注入 */
	stopAgentFromMonitor: (
		agentId: string,
	) => Promise<SessionCommandResult<SessionRuntimeTarget | undefined>>;
	/** 模型规格存储（resources/model-specs.db 只读，发版前由 sync-model-specs.mjs 同步） */
	modelSpecsStore: ModelSpecsStore;
	mainWindowControls: MainWindowControls;
	platformApplication: PlatformApplication;
	platformPaths: PlatformPaths;
	platformShell: PlatformShell;
	platformTheme: PlatformTheme;
	toggleDevTools?: () => void;
	sendToRenderer?: (channel: string, ...args: unknown[]) => void;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	/** Check for app update; implemented by the update domain service. */
	checkForAppUpdate: (installationType?: "portable" | "installed") => Promise<import("../../shared/types").AppUpdateInfo | null>;
	/** Download update asset */
	downloadUpdateAsset: (asset: AppUpdateAsset) => Promise<import("../../shared/types").AppUpdateDownloadResult>;
	/** Install downloaded update */
	installDownloadedUpdate: (filePath: string) => Promise<void>;
	/** Open external URL */
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	/**
	 * Resolve WSL environment (lazy import in index.ts).
	 * 返回值直接喂给各 manager.configureWsl，形状必须是 WslEnvironment。
	 */
	resolveWslEnvironment?: (
		distro: string,
		user: string,
		logger: { warn: (msg: string, detail: unknown) => void },
	) => Promise<import("../wsl/WslPaths").WslEnvironment>;
	/** React to settings changes for pet system */
	/** Session scanner WSL config */
	configureSessionScannerWsl?: (env: import("../wsl/WslPaths").WslEnvironment) => Promise<void>;
	clearSessionScannerWsl?: () => void;
	/** Refresh tray context menu */
	refreshTrayContextMenu?: () => void;
	/** Notify title bar change */
	notifyTitleBarChange?: () => void;
	/** Apply native theme source */
	applyNativeThemeSource?: (settings: AppSettings) => void;
	/** Apply desktop proxy settings */
	applyDesktopProxy?: (settings: AppSettings) => Promise<void>;
	/** Test Pi proxy */
	testPiProxy?: (settings: AppSettings, proxyUrl?: string, translate?: (key: string, params?: Record<string, string | number>) => string) => Promise<import("../../shared/types").PiProxyTestResult>;
	/** Web service manager apply settings */
	applyWebServiceSettings?: (settings: AppSettings) => Promise<void>;
	/** Restart the running Web service without changing persisted settings. */
	restartWebService?: (settings: AppSettings) => Promise<void>;
	/** Session catalog set identity context */
	setSessionCatalogIdentityContext?: (ctx: { wslDistro?: string; wslUser?: string }) => void;
	/** Configure WSL for various services — null 表示切回本机路径 */
	configureSkillManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configurePromptManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configureExtensionManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configureConfigManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configureXuePromptManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	/** Session command IPC error converter */
	sessionCommandIpcError?: (error: import("../../shared/types").SessionCommandError) => Error;
	/** Restart the application */
	restartApplication: () => void;
	/** Extension manager for pi update */
	extensionManager?: {
		checkPiUpdate: () => Promise<import("../../shared/types").PiUpdateCheckResult>;
		updatePi: () => Promise<import("../../shared/types").PiCliUpdateResult>;
	};
	/** Web service manager for restart */
	webServiceManager?: { stop: () => Promise<void> };
	/** Terminal manager for restart */
	terminalManager?: { closeAll: () => void };
	/** Releases URL */
	RELEASES_URL?: string;
};

export function registerSystemIpc(router: RpcRouter, deps: SystemIpcDeps): void {
	const {
		piLocator,
		settingsStore,
		configManager,
		agentManager,
		skillManager,
		appLogger,
		rpcLogger,
		sessionRuntimeCoordinator,
		modelSpecsStore,
		mainWindowControls,
		platformApplication,
		platformPaths,
		platformShell,
		platformTheme,
		toggleDevTools,
		sendToRenderer,
		mainCopy,
		checkForAppUpdate,
		downloadUpdateAsset,
		installDownloadedUpdate,
		openExternalUrl: doOpenExternalUrl,
		resolveWslEnvironment,
		configureSessionScannerWsl,
		clearSessionScannerWsl,
		refreshTrayContextMenu,
		notifyTitleBarChange,
		applyNativeThemeSource,
		applyDesktopProxy,
		testPiProxy,
		applyWebServiceSettings,
		restartWebService,
		setSessionCatalogIdentityContext,
		configureSkillManagerWsl,
		configurePromptManagerWsl,
		configureExtensionManagerWsl,
		configureConfigManagerWsl,
		configureXuePromptManagerWsl,
		sessionCommandIpcError,
		extensionManager,
		RELEASES_URL,
		restartApplication,
	} = deps;

	// ── Pi 检测 ──────────────────────────────────────────────────────

	router.handle(ipcChannels.piCheck, async () => {
		const settings = settingsStore.get();
		const status = await piLocator.check(
			settings.customPiPath,
			settings.wslEnabled,
			settings.wslDistro,
			settings.wslUser,
			settings.piRuntimePreference,
			settings.piTypescriptPath,
			settings.piRustPath,
		);
		void appLogger.info("pi", "Pi check completed", {
			installed: status.installed,
			version: status.version,
			command: status.command,
			error: status.error,
		});
		return status;
	});

	router.handle(ipcChannels.piCheckCustom, async (customPath: string) => {
		const status = await piLocator.validateCustomPath(customPath);
		if (status.installed && status.command) {
			await settingsStore.update({ customPiPath: status.command });
		}
		void appLogger.info("pi", "Custom pi path checked", {
			installed: status.installed,
			version: status.version,
			command: status.command,
			error: status.error,
		});
		return status;
	});

	// ── 模型列表 ────────────────────────────────────────────────────

	router.handle(ipcChannels.projectsListModels, async (_projectId?: string) => {
		try {
			// 读缓存；无缓存时优先通过 Pi RPC 获取模型，失败再回退 --list-models。
			const models = await fetchModelList(piLocator, settingsStore);
			void appLogger.info("pi", "Model list resolved", {
				count: models.length,
				cached: getCachedModelList() === models,
				providers: [...new Set(models.map((m) => m.provider))].slice(0, 8),
			});
			return models;
		} catch (error) {
			void appLogger.warn("pi", "Failed to list models via Pi RPC/text fallback", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	});

	// ── 模型规格（resources/model-specs.db，发版前由 sync-model-specs.mjs 同步）──

	router.handle(
		ipcChannels.projectsGetModelSpec,
		async (providerName: unknown, modelId: unknown) => {
			// 边界校验：渲染层输入不可信，拒绝非字符串/超长输入
			if (
				typeof providerName !== "string" ||
				typeof modelId !== "string" ||
				providerName.length > 128 ||
				modelId.length > 256
			) {
				return null;
			}
			try {
				return (await modelSpecsStore.lookup(providerName, modelId)) ?? null;
			} catch (error) {
				void appLogger.warn("models", "Model spec lookup failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}
		},
	);

	// ── WSL ──────────────────────────────────────────────────────────

	const wslExe = getWslExe();
	const wslExePath = wslExe.command;
	const wslShell = wslExe.shell;

	router.handle(ipcChannels.wslListDistros, async () => {
		if (process.platform !== "win32") return [] as string[];
		try {
			const { execFile } = await import("node:child_process");
			return new Promise<string[]>((resolve) => {
				execFile(wslExePath, ["-l", "-q"], { encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
					(err, stdout) => {
						if (err) { resolve([]); return; }
						const distros = stdout.split(/\r?\n/)
							.map((s) => s.trim())
							.filter((s) => s.length > 0 && !s.includes("\\") && !s.includes("\x00"));
						resolve(distros);
					});
			});
		} catch { return [] as string[]; }
	});

	router.handle(ipcChannels.wslValidateConnection, async (distro: string, user: string) => {
		if (process.platform !== "win32") {
			return { ok: false, whoami: "", piVersion: "", error: mainCopy("wsl.windowsOnly") };
		}
		try {
			const { execFile } = await import("node:child_process");
			const [whoamiRes, piVersionRes] = await Promise.all([
				new Promise<string>((resolve, reject) => {
					execFile(wslExePath, ["-d", distro, "-u", user, "whoami"],
						{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
						(err, stdout) => {
							if (err) { reject(err); return; }
							resolve(stdout.trim());
						});
				}),
				new Promise<string>((resolve) => {
					execFile(wslExePath, ["-d", distro, "-u", user, "pi", "--version"],
						{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
						(err, stdout) => {
							if (err) { resolve(""); return; }
							resolve(stdout.trim());
						});
				}),
			]);
			return {
				ok: true,
				whoami: whoamiRes,
				piVersion: piVersionRes,
				error: piVersionRes ? "" : mainCopy("wsl.piNotInstalled"),
			};
		} catch (err) {
			void appLogger.warn("wsl", "WSL connection validation failed", {
				distro,
				user,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				ok: false,
				whoami: "",
				piVersion: "",
				error: mainCopy("wsl.connectionFailed"),
			};
		}
	});

	// ── Pi 安装 / NPM ────────────────────────────────────────────────

	const userHomeDir = platformPaths?.home ?? process.cwd();

	router.handle(ipcChannels.piExecInstall, async (command: string): Promise<import("../../shared/types").PiInstallExecResult> => {
		void appLogger.info("pi", "Executing install command", { command });
		try {
			const { execFile } = await import("node:child_process");
			const result = await new Promise<import("../../shared/types").PiInstallExecResult>((resolve) => {
				const isWin = process.platform === "win32";
				if (isWin) {
					const child = execFile(
						process.env.ComSpec || "cmd.exe",
						["/d", "/s", "/c", command],
						{
							cwd: userHomeDir,
							timeout: 120_000,
							// 复用 PiLocator 搜索目录拼 PATH：桌面端继承的注册表 PATH 不含版本管理器
							// （mise/fnm/volta/scoop 等）在 shell 会话里动态注入的目录，终端可用而
							// 桌面端“找不到 npm”即源于此；前置搜索目录后 npm 才能被 cmd 解析到。
							env: { ...piLocator.createProcessEnv(), npm_config_fund: "false", npm_config_audit: "false" },
							windowsHide: true,
							encoding: "utf8",
							shell: false,
						},
						(error: unknown, stdout: string, stderr: string) => {
							const execError = error as { code?: number | string } | null;
							resolve({
								success: !error,
								exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
								stdout: stdout || "",
								stderr: stderr || "",
							});
						},
					);
				} else {
					execFile(
						"/bin/sh",
						["-c", command],
						{
							cwd: userHomeDir,
							timeout: 120_000,
							env: { ...piLocator.createProcessEnv(), npm_config_fund: "false", npm_config_audit: "false" },
							encoding: "utf8",
						},
						(error: unknown, stdout: string, stderr: string) => {
							const execError = error as { code?: number | string } | null;
							resolve({
								success: !error,
								exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
								stdout: stdout || "",
								stderr: stderr || "",
							});
						},
					);
				}
			});
			void appLogger.info("pi", "Install command completed", {
				success: result.success,
				exitCode: result.exitCode,
				stdoutLength: result.stdout.length,
				stderrLength: result.stderr.length,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void appLogger.error("pi", "Install command threw", { error: message });
			return { success: false, exitCode: -1, stdout: "", stderr: message };
		}
	});

	router.handle(ipcChannels.piCheckNpm, async (): Promise<import("../../shared/types").NpmAvailabilityResult> => {
		try {
			const { execFile } = await import("node:child_process");
			const result = await new Promise<import("../../shared/types").NpmAvailabilityResult>((resolve) => {
				const isWin = process.platform === "win32";
				if (isWin) {
					execFile(
						process.env.ComSpec || "cmd.exe",
						["/d", "/s", "/c", "npm --version"],
						{
							// 同 piExecInstall：npm 可能只存在于版本管理器动态目录中，
							// 必须用 PiLocator 搜索目录（含注册表 PATH）重建子进程 PATH。
							env: piLocator.createProcessEnv(),
							timeout: 10_000, encoding: "utf8", windowsHide: true, shell: false,
						},
						(error, stdout) => {
							if (error) {
								resolve({ available: false, error: error.message });
							} else {
								resolve({ available: true, version: stdout.trim() });
							}
						},
					);
				} else {
					execFile(
						"npm",
						["--version"],
						{
							// 非 Windows：/bin/sh -lc 已能拿到登录 shell PATH；仍叠加搜索目录
							// 兜底 GUI 启动时 Homebrew/fnm/mise 等动态路径缺失的场景。
							env: piLocator.createProcessEnv(),
							timeout: 10_000, encoding: "utf8",
						},
						(error, stdout) => {
							if (error) {
								resolve({ available: false, error: error.message });
							} else {
								resolve({ available: true, version: stdout.trim() });
							}
						},
					);
				}
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { available: false, error: message };
		}
	});

	// ── Pi 更新 ──────────────────────────────────────────────────────

	if (extensionManager) {
		router.handle(ipcChannels.piUpdateCheck, async () => {
			const result = await extensionManager.checkPiUpdate();
			void appLogger.info("pi", "Pi update check completed", { currentVersion: result.currentVersion, latestVersion: result.latestVersion, hasUpdate: result.hasUpdate, error: result.error });
			return result;
		});
		router.handle(ipcChannels.piUpdate, async () => {
			const result = await extensionManager.updatePi();
			void appLogger.info("pi", "Pi update command completed", { updated: result.updated, bytes: result.output.length });
			return result;
		});
	}

	// ── 应用信息 ─────────────────────────────────────────────────────

	router.handle(ipcChannels.appInfo, () => ({
		version: platformApplication?.version ?? "0.0.0",
		releasesUrl: RELEASES_URL ?? "https://github.com/ayuayue/pi-desktop/releases",
		platform: process.platform,
	}));

	router.handle(ipcChannels.appNetworkAddresses, () => listWebNetworkAddresses());

	router.handle(ipcChannels.appPreferredSystemLanguages, () => {
		return platformApplication?.getPreferredSystemLanguages?.() ?? [];
	});

	// ── 应用更新 ─────────────────────────────────────────────────────

	router.handle(ipcChannels.appCheckUpdate, () =>
		checkForAppUpdate(settingsStore.get().installationType),
	);
	router.handle(ipcChannels.appDownloadUpdate, async (asset: AppUpdateAsset) =>
		downloadUpdateAsset(asset),
	);
	router.handle(ipcChannels.appInstallUpdate, async (filePath: string) =>
		installDownloadedUpdate(filePath),
	);

	// ── 应用日志 ─────────────────────────────────────────────────────

	// 进程监控：Electron 各进程 + pi agent 子进程内存/CPU 快照（手动刷新，不做高频轮询）
	router.handle(ipcChannels.processMetrics, async (): Promise<ProcessMetricsSnapshot> => {
		const agents = deps.agentManager.listAgentPids().map((agent) => {
			// 进程监控表展示会话身份：按 agentId 反查关联的会话 id/标题，
			// 让用户知道每个 agent 对应哪个会话（而不是只看到内部 id）
			const sessionInfo = deps.sessionRuntimeCoordinator.getSessionInfoForAgent(
				agent.agentId,
			);
			return { ...agent, ...(sessionInfo ?? {}) };
		});
		return getProcessSnapshot(agents);
	});

	router.handle(ipcChannels.stopAgent, async (agentId: unknown) => {
		// 输入校验：agentId 必须是字符串，否则拒绝（渲染层数据不可信）
		if (typeof agentId !== "string" || !agentId) {
			throw new Error("invalid agentId");
		}
		// 走完整会话停止链路（coordinator 反查会话 + 解绑 + detach 推送），
		// 不能只调 agentManager.stop——那会跳过会话状态收尾，渲染层运行标记不熄灭
		const result = await deps.stopAgentFromMonitor(agentId);
		if (!result.ok) {
			throw new Error(result.error.debugDetails ?? `failed to stop agent ${agentId}`);
		}
	});

	router.handle(ipcChannels.logsList, async (query: AppLogQuery) =>
		appLogger.list(query),
	);
	router.handle(ipcChannels.logsListPage, async (query: AppLogQuery) =>
		appLogger.listPage(query),
	);
	router.handle(ipcChannels.rendererLog, async (
		level: AppLogLevel, scope: string, message: string, detail?: unknown,
	) => {
		const safeLevel = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
		await appLogger.log(safeLevel as AppLogLevel, scope, message, detail);
	});
	router.handle(ipcChannels.logsClear, async () => appLogger.clear());
	router.handle(ipcChannels.logsOpenFolder, async () => {
		await appLogger.ensureDirectory();
		if (platformShell) {
			await platformShell.openPath(appLogger.getDirectory());
		}
	});
	router.handle(ipcChannels.logsSize, async () => appLogger.getSize());

	// ── RPC 日志 ─────────────────────────────────────────────────────

	const resolveRpcRuntimeAgent = (target?: SessionRuntimeTarget) => {
		if (!target) return undefined;
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) {
			if (sessionCommandIpcError) throw sessionCommandIpcError((validated as { ok: false; error: import("../../shared/types").SessionCommandError }).error);
			return undefined;
		}
		return target.agentId;
	};

	router.handle(ipcChannels.rpcLogsGetSize, async (target?: SessionRuntimeTarget) =>
		rpcLogger.getSize(resolveRpcRuntimeAgent(target)),
	);
	router.handle(ipcChannels.rpcLogsGet, async (options?: { target?: SessionRuntimeTarget; days?: number; limit?: number }) =>
		rpcLogger.getFromFile({ agentId: resolveRpcRuntimeAgent(options?.target), days: options?.days, limit: options?.limit }),
	);
	// 实时查看弹窗的初始历史：直接读主进程环形缓冲，不读磁盘
	router.handle(ipcChannels.rpcLogsGetLive, async (agentId?: string) =>
		rpcLogger.getLive(typeof agentId === "string" ? agentId : undefined),
	);
	// 实时查看弹窗“保存到文件”：直接合并写入该 agent 的自动日志文件（按 id 去重），
	// 不再弹目录选择——开启记录后日志本就自动落盘，保存只是把弹窗内容对齐到文件。
	// 返回实际写入的文件路径列表，供渲染层 toast 提示用户保存位置。
	// 渲染层传来的条目不可信，数量与字段都要校验。
	router.handle(ipcChannels.rpcLogsSave, async (options?: { entries?: unknown }) => {
		const rawEntries = Array.isArray(options?.entries) ? options.entries : [];
		const entries = rawEntries
			.slice(0, 10_000) // 上限：防止一次 IPC 携带超大批次
			.filter((value): value is RpcLogEntry => isRpcLogEntry(value));
		if (entries.length === 0) return [];
		return rpcLogger.appendEntries(entries);
	});
	router.handle(ipcChannels.rpcLogsClear, async (target?: SessionRuntimeTarget) =>
		rpcLogger.clear(resolveRpcRuntimeAgent(target)),
	);
	router.handle(ipcChannels.rpcLoggingSet, async (target: SessionRuntimeTarget, enabled: boolean) => {
		agentManager.setRpcLogging(resolveRpcRuntimeAgent(target)!, enabled);
		return enabled;
	});
	router.handle(ipcChannels.rpcLoggingGet, async (target: SessionRuntimeTarget) =>
		agentManager.isRpcLogging(resolveRpcRuntimeAgent(target)!),
	);

	// ── 外部链接 / 重启 / 窗口控制 ──────────────────────────────────

	router.handle(ipcChannels.appOpenExternal, async (url: string, forceSystem?: boolean) => {
		await doOpenExternalUrl(url, forceSystem);
	});

	router.handle(ipcChannels.appRestart, () => {
		restartApplication();
	});

	router.handle(ipcChannels.appWindowMinimize, () => {
		mainWindowControls.minimize();
	});

	router.handle(ipcChannels.appWindowToggleMaximize, () => {
		return mainWindowControls.toggleMaximize();
	});
	router.handle(ipcChannels.appWindowIsMaximized, () => {
		return mainWindowControls.getWindowState().isMaximized;
	});
	router.handle(ipcChannels.appWindowToggleAlwaysOnTop, () => {
		return mainWindowControls.toggleAlwaysOnTop();
	});
	router.handle(ipcChannels.appWindowClose, () => {
		mainWindowControls.close();
	});
	router.handle(ipcChannels.appBeginWindowDrag, () => {
		mainWindowControls.beginWindowDrag?.();
	});

	// ── 设置 ─────────────────────────────────────────────────────────

	router.handle(ipcChannels.settingsGet, () => settingsStore.get());

	router.handle(ipcChannels.settingsUpdate, async (patch: Partial<AppSettings>) => {
		const prevSettings = settingsStore.get();
		const settings = await settingsStore.update(patch);
		// 设置变更审计已下沉到 SettingsStore.update 内部统一留痕（覆盖所有直写路径），此处不重复记录

		platformApplication.hideApplicationMenu();

		if (
			"desktopProxyEnabled" in patch ||
			"desktopProxyUrl" in patch ||
			"desktopProxyBypass" in patch
		) {
			if (applyDesktopProxy) await applyDesktopProxy(settings);
		}
		if ("theme" in patch) {
			if (patch.theme && (patch.theme === "system" || patch.theme === "light" || patch.theme === "dark")) {
				platformTheme.setSource(patch.theme);
			} else if (applyNativeThemeSource) {
				applyNativeThemeSource(settings);
			}
		}
		if ("language" in patch) {
			if (refreshTrayContextMenu) refreshTrayContextMenu();
		}
		if ("useNativeTitleBar" in patch || "closeToTray" in patch) {
			mainWindowControls.notifyTitleBarChange(settings);
		}
		if ("zoomFactor" in patch && typeof settings.zoomFactor === "number") {
			mainWindowControls.notifyTitleBarChange(settings);
		}
		if (
			"webServiceEnabled" in patch ||
			"webServiceHost" in patch ||
			"webServicePort" in patch
		) {
			try {
				if (applyWebServiceSettings) await applyWebServiceSettings(settings);
			} catch (error) {
				const debugDetails = error instanceof Error ? error.message : String(error);
				void appLogger.warn("web", "Failed to apply web service settings", { error: debugDetails });
				if (settings.webServiceEnabled) {
					await settingsStore.update({ webServiceEnabled: false });
				}
				throw new Error(mainCopy(
					debugDetails === "WEB_SERVICE_INVALID_PORT"
						? "webService.invalidPort"
						: "webService.startFailed",
				));
			}
		}
		if (
			"piRuntimePreference" in patch ||
			"piTypescriptPath" in patch ||
			"piRustPath" in patch
		) {
			invalidateModelListCache();
			void refreshModelList(piLocator, settingsStore).catch(() => undefined);
		}
		// WSL 设置变更时同步更新会话扫描器和配置管理器
		if ("wslEnabled" in patch || "wslDistro" in patch || "wslUser" in patch) {
			if (setSessionCatalogIdentityContext) {
				setSessionCatalogIdentityContext(
					settings.wslEnabled
						? { wslDistro: settings.wslDistro, wslUser: settings.wslUser }
						: {},
				);
			}
			if (settings.wslEnabled && settings.wslDistro && settings.wslUser && resolveWslEnvironment) {
				const environment = await resolveWslEnvironment(settings.wslDistro, settings.wslUser, {
					warn: (msg: string, detail: unknown) => console.warn("[PiDeck] " + String(msg), detail),
				});
				if (configureSessionScannerWsl) await configureSessionScannerWsl(environment);
				if (configureSkillManagerWsl) configureSkillManagerWsl(environment);
				if (configurePromptManagerWsl) configurePromptManagerWsl(environment);
				if (configureExtensionManagerWsl) configureExtensionManagerWsl(environment);
				if (configureConfigManagerWsl) configureConfigManagerWsl(environment);
				if (configureXuePromptManagerWsl) configureXuePromptManagerWsl(environment);
			} else {
				if (clearSessionScannerWsl) clearSessionScannerWsl();
				if (configureSkillManagerWsl) configureSkillManagerWsl(null);
				if (configurePromptManagerWsl) configurePromptManagerWsl(null);
				if (configureExtensionManagerWsl) configureExtensionManagerWsl(null);
				if (configureConfigManagerWsl) configureConfigManagerWsl(null);
				if (configureXuePromptManagerWsl) configureXuePromptManagerWsl(null);
			}
		}
		return settings;
	});

	router.handle(ipcChannels.settingsRestartWebService, async () => {
		if (!restartWebService) throw new Error("restartWebService not available");
		await restartWebService(settingsStore.get());
	});

	router.handle(ipcChannels.settingsTestPiProxy, async () => {
		if (!testPiProxy) throw new Error("testPiProxy not available");
		const result = await testPiProxy(settingsStore.get(), undefined, mainCopy);
		void appLogger.info("settings", "Pi proxy tested", {
			success: result.success,
			elapsedMs: result.elapsedMs,
			statusCode: result.statusCode,
			error: result.error,
		});
		return result;
	});

	// ── Skills CRUD ──────────────────────────────────────────────────

	router.handle(ipcChannels.skillsList, () => skillManager.list());
	router.handle(ipcChannels.skillsCreate, async (input: CreatePiSkillInput) => {
		const result = await skillManager.create(input);
		void appLogger.info("skill", "Skill created", { name: input.name, locationId: input.locationId });
		return result;
	});
	router.handle(ipcChannels.skillsToggle, async (path: string, enabled: boolean) => {
		const result = await skillManager.toggle(path, enabled);
		void appLogger.info("skill", "Skill toggled", { path, enabled });
		return result;
	});
	router.handle(ipcChannels.skillsDelete, async (path: string) => {
		const result = await skillManager.delete(path);
		void appLogger.info("skill", "Skill deleted", { path });
		return result;
	});
	router.handle(ipcChannels.skillsOpenFolder, (path?: string) =>
		skillManager.openFolder(path),
	);

	// ── 配置管理 ─────────────────────────────────────────────────────

	router.handle(ipcChannels.configGetModels, () =>
		configManager.getModelsConfig(),
	);
	router.handle(ipcChannels.configGetAuth, () =>
		configManager.getAuthConfig(),
	);
	router.handle(ipcChannels.configGetSettings, () =>
		configManager.getSettingsConfig(),
	);
	router.handle(ipcChannels.configGetTrust, () =>
		configManager.getTrustConfig(),
	);
	router.handle(ipcChannels.projectsTrustResponse,
		(requestId: string, choice: "trust-remember" | "trust-session" | "deny") =>
			agentManager.respondTrustRequest(requestId, choice),
	);
	router.handle(ipcChannels.configSaveModels, async (data: PiModelsFile) => {
		const result = await configManager.saveModelsConfig(data);
		invalidateModelListCache();
		// 配置保存后立即后台重取，下次打开选择器直接命中新缓存。
		void refreshModelList(piLocator, settingsStore).catch(() => undefined);
		void appLogger.info("config", "Models config saved", { providerCount: Object.keys(data?.providers ?? {}).length });
		return result;
	});
	router.handle(ipcChannels.configSaveAuth, async (data: PiAuthFile) => {
		const result = await configManager.saveAuthConfig(data);
		invalidateModelListCache();
		// auth 影响「可用模型」过滤（pi 只列已认证 provider），保存后同样后台重取。
		void refreshModelList(piLocator, settingsStore).catch(() => undefined);
		void appLogger.info("config", "Auth config saved", { authCount: Object.keys(data ?? {}).length });
		return result;
	});
	router.handle(ipcChannels.configSaveSettings, async (settings: PiSettings) => {
		const result = await configManager.saveSettingsConfig(settings);
		void appLogger.info("config", "Pi settings config saved", { keys: Object.keys(settings ?? {}) });
		return result;
	});
	router.handle(ipcChannels.configSaveRaw, async (fileName: string, rawJson: string) => {
		const result = await configManager.saveRawConfig(fileName, rawJson);
		void appLogger.info("config", "Raw config saved", { fileName, bytes: Buffer.byteLength(rawJson, "utf8") });
		return result;
	});
	router.handle(ipcChannels.configExport, () =>
		configManager.exportConfig(),
	);
	router.handle(ipcChannels.configImport, async (packageJson: string) => {
		const result = await configManager.importConfig(packageJson);
		void appLogger.info("config", "Config imported", { bytes: Buffer.byteLength(packageJson, "utf8"), valid: result.valid });
		return result;
	});
	router.handle(ipcChannels.configFetchModels, async (
		payload: { baseUrl: string; apiKey: string; apiType?: string },
	) => {
		const result = await configManager.fetchProviderModels(payload.baseUrl, payload.apiKey, payload.apiType);
		void appLogger.info("config", "Provider models fetched", {
			baseUrl: payload.baseUrl,
			apiType: payload.apiType,
			modelCount: Array.isArray(result) ? result.length : undefined,
		});
		return result;
	});
	router.handle(ipcChannels.configTestProvider, async (
		payload: { baseUrl: string; apiKey: string; modelId: string; apiType?: string; headers?: Record<string, string> },
	) => {
		const result = await configManager.testProviderConnection(
			payload.baseUrl, payload.apiKey, payload.modelId, payload.apiType, payload.headers,
		);
		void appLogger.info("config", "Provider connection tested", {
			baseUrl: payload.baseUrl,
			apiType: payload.apiType,
			modelId: payload.modelId,
			success: result.success,
			error: result.error,
		});
		return result;
	});

	// ── 开发者控制台 ─────────────────────────────────────────────────

	router.handle(ipcChannels.appToggleDevTools, () => {
		if (mainWindowControls) {
			mainWindowControls.toggleDevTools();
		} else {
			toggleDevTools?.();
		}
	});
}
