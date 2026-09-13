import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { ipcChannels } from "../../shared/ipc";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SkillManager } from "../skills/SkillManager";
import type { PromptManager } from "../prompts/PromptManager";
import type { XuePromptManager } from "../prompts/XuePromptManager";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import {
	BUILT_IN_EXTENSIONS,
	LEGACY_BUILT_IN_EXTENSION_NAMES,
} from "../extensions/builtInExtensions";
import { migrateLegacyBuiltInEntries } from "../extensions/legacyBuiltInMigration";
import type { StartupBarrier } from "../utils/StartupBarrier";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { SettingsStore } from "../settings/SettingsStore";
import type { WebServiceManager } from "../web/WebServiceManager";
import {
	detectExternalEditors,
	mergeDetectedExternalEditors,
} from "../editors/EditorDetector";
import type { BackendHost } from "./Backend";
import type { PlatformPaths } from "../platform/PlatformServices";

export interface BackendStartupTasksDeps {
	paths: PlatformPaths;
	host: BackendHost;
	/** 应用版本，用于旧入口备份目录按版本分档。 */
	appVersion: string;
	/**
	 * 启动屏障：内置扩展迁移必须被登记进来，AgentManager 在 spawn pi 前 await 它，
	 * 否则迁移尚未完成就有进程起来，旧全局入口和内置 -e 版会同时加载。
	 */
	startupBarrier: StartupBarrier;
	services: {
		projectStore: ProjectStore;
		sessionScanner: SessionScanner;
		settingsStore: SettingsStore;
		piLocator: PiLocator;
		configManager: ConfigManager;
		promptManager: PromptManager;
		xuePromptManager: XuePromptManager;
		skillManager: SkillManager;
		extensionManager: ExtensionManager;
		webServiceManager: WebServiceManager;
		appLogger: AppLogger;
	};
}

/**
 * 删除用户扩展目录中的 PiDeck 自有扩展文件（历史部署或已下线扩展）。
 * 内置扩展现改为 -e 从 app resources 加载，用户目录不应再有 pi-deck-* 副本。
 *
 * 注意：这里只处理**确定由 PiDeck 生成**的文件名（pi-deck-* / 内置扩展名）。
 * 与用户可能自有的同名文件（如 change-pi-prompt.ts）走不同的路径，
 * 见 legacyBuiltInMigration。
 */
async function removeStalePiDeckExtension(
	extensionName: string,
	agentDir: string,
	appLogger: AppLogger,
): Promise<void> {
	const targetPath = join(agentDir, "extensions", extensionName);
	await rm(targetPath, { force: true });
	appLogger.info("extension", "Removed legacy/stale extension", { path: targetPath });
}

/**
 * 升级迁移：清掉历史版本复制到 `<agentDir>/extensions` 的内置扩展与已下线扩展，
 * 并把「曾是自用全局入口、现已内置」的扩展按指纹备份后移除。
 *
 * agent 目录由调用方统一解析（本机 + 已启用的 WSL），WSL 路径必须来自
 * resolveWslEnvironment().windowsHome，不能手拼 `\\wsl$\<distro>\home\<user>`：
 * root 用户 home 是 `/root`，其他用户的 home 也可能不在默认位置。
 */
async function migrateLegacyBuiltInExtensions(
	agentDirs: readonly string[],
	appVersion: string,
	appLogger: AppLogger,
): Promise<void> {
	const legacyNames = [
		...BUILT_IN_EXTENSIONS,
		...LEGACY_BUILT_IN_EXTENSION_NAMES,
		"pi-deck-project-trust.ts",
		"pi-deck-file-capture.ts",
	];
	// PiDeck 自有文件：名字由我们控制，残留直接清。
	for (const agentDir of agentDirs) {
		for (const name of legacyNames) {
			await removeStalePiDeckExtension(name, agentDir, appLogger).catch(() => undefined);
		}
	}
	// 同名的自用/用户入口：只在正面识别后备份迁移，识别不了则保留。
	const result = await migrateLegacyBuiltInEntries(agentDirs, appVersion);
	for (const moved of result.moved) {
		void appLogger.info("extension", "Backed up legacy built-in extension entry", {
			file: moved.fileName,
			fingerprint: moved.fingerprint,
			backup: moved.backup,
		});
	}
	for (const warning of result.warnings) {
		void appLogger.warn("extension", "Legacy extension entry left in place", { detail: warning });
	}
	// 迁移完成即可：屏障登记在调用方（startBackendStartupTasks），避免本函数依赖调度细节。
}

/** 补齐指定 configDir 下 settings.json 的缺失默认项 */
async function ensurePiSettingsDefaults(configDir: string, piVersionHint?: string): Promise<void> {
	const filePath = join(configDir, "settings.json");
	let current: Record<string, unknown> = {};
	try {
		const raw = await readFile(filePath, "utf8");
		current = JSON.parse(raw) as Record<string, unknown>;
	} catch { /* 文件不存在或解析失败，使用空对象 */ }

	let changed = false;
	const defaults: Record<string, unknown> = {
		theme: "dark",
		hideThinkingBlock: false,
		defaultProjectTrust: "ask",
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		retry: { enabled: true, maxRetries: 3 },
	};

	if (piVersionHint && !current.lastChangelogVersion) {
		current.lastChangelogVersion = piVersionHint;
		changed = true;
	}

	for (const [key, defaultValue] of Object.entries(defaults)) {
		if (!(key in current)) {
			current[key] = defaultValue;
			changed = true;
		}
	}

	if (changed) {
		await mkdir(configDir, { recursive: true });
		await writeFile(filePath, JSON.stringify(current, null, 2), "utf8");
		console.log("[PiDeck] Ensured pi settings defaults at:", filePath);
	}
}

/** 对当前环境和 WSL 环境（如果启用）都补齐 settings.json 默认项 */
async function ensureAllPiSettingsDefaults(
	agentDirs: readonly string[],
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<void> {
	const s = settingsStore.get();
	let piVersion = "";
	if (piLocator) {
		piVersion = (await piLocator.check(
			s.customPiPath,
			s.wslEnabled,
			s.wslDistro,
			s.wslUser,
			s.piRuntimePreference,
			s.piTypescriptPath,
			s.piRustPath,
		).catch(() => null))?.version ?? "";
	}

	for (const agentDir of agentDirs) {
		await ensurePiSettingsDefaults(agentDir, piVersion).catch(() => {});
	}
}

async function detectExternalEditorsOnFirstLaunch(
	settingsStore: SettingsStore,
	appLogger: AppLogger,
): Promise<void> {
	const current = settingsStore.get().externalEditors;
	if (Object.values(current).some((editor) => editor.command)) return;
	const detected = await detectExternalEditors();
	if (detected.length === 0) return;
	await settingsStore.update({
		externalEditors: mergeDetectedExternalEditors(current, detected),
	});
	void appLogger.info("editor", "External editors detected on first launch", { count: detected.length });
}

export function startBackendStartupTasks(deps: BackendStartupTasksDeps): void {
	const { paths, host, appVersion, startupBarrier, services } = deps;
	const {
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
	} = services;

	// WSL 环境在整个启动流程里只解析一次：下面三处都依赖它，各解一次会多次跑
	// `wsl.exe printenv HOME`（最多 8s）且可能拿到不一致结果。
	// 必须用 windowsHome 而不是手拼 `\\wsl$\<distro>\home\<user>`：后面对 root
	// 用户和自定义 home 的用户都会错路径，导致迁移/默认项静默作用到不存在的目录。
	const resolveWslEnv = async (): Promise<WslEnvironment | null> => {
		const { wslEnabled, wslDistro, wslUser } = settingsStore.get();
		if (!wslEnabled || !wslDistro || !wslUser) return null;
		const { resolveWslEnvironment } = await import("../wsl/WslEnvironment");
		return resolveWslEnvironment(wslDistro, wslUser, {
			warn: (msg: string, detail: unknown) =>
				void appLogger.warn("wsl", msg, detail instanceof Error ? detail.message : detail),
		});
	};

	/** 解析后的 WSL 环境→需要处理的 agent 目录列表（本机永久包含）。 */
	const agentDirsOf = (wslEnv: WslEnvironment | null): string[] => {
		const dirs = [join(paths.home, ".pi", "agent")];
		if (wslEnv) dirs.push(join(wslEnv.windowsHome, ".pi", "agent"));
		return dirs;
	};

	// 根据已解析的 WSL 环境配置各扫描器/管理器，使其能同时看到 WSL 中的 pi 目录。
	const applyWslConfig = async (wslEnv: WslEnvironment | null): Promise<void> => {
		if (wslEnv) {
			await sessionScanner.configureWsl(wslEnv);
			skillManager.configureWsl(wslEnv);
			promptManager.configureWsl(wslEnv);
			extensionManager.configureWsl(wslEnv);
			if (configManager) configManager.configureWsl(wslEnv);
			if (xuePromptManager) xuePromptManager.configureWsl(wslEnv);
		} else {
			sessionScanner.clearWsl();
			skillManager.configureWsl(null);
			promptManager.configureWsl(null);
			extensionManager.configureWsl(null);
			if (configManager) configManager.configureWsl(null);
			if (xuePromptManager) xuePromptManager.configureWsl(null);
		}
	};

	// WSL 解析失败不能带下其他任务：先把它隔离成一个不会抛的 promise。
	const wslEnvPromise = resolveWslEnv().catch((error) => {
		console.error("Failed to resolve WSL environment:", error);
		return null;
	});

	void wslEnvPromise
		.then((wslEnv) => applyWslConfig(wslEnv))
		.catch((error) => {
			console.error("Failed to sync WSL config:", error);
		});

	// 扩展迁移：等 WSL 环境就绪后对本机与 WSL 两个 agent 目录一起做，并登记到
	// 启动屏障，由 AgentManager 在首次 spawn pi 前 await。
	startupBarrier.add(
		wslEnvPromise
			.then((wslEnv) =>
				migrateLegacyBuiltInExtensions(agentDirsOf(wslEnv), appVersion, appLogger),
			)
			.catch((error) => {
				console.error("Failed to migrate legacy built-in extensions:", error);
			}),
	);

	void wslEnvPromise
		.then((wslEnv) => ensureAllPiSettingsDefaults(agentDirsOf(wslEnv), piLocator, settingsStore))
		.catch((error) => {
			console.error("Failed to ensure pi settings defaults:", error);
		});

	void webServiceManager.applySettings(settingsStore.get()).catch((error) => {
		console.error("Failed to start web service:", error);
		void appLogger.warn("web", "Web service disabled after apply failure", {
			error: error instanceof Error ? error.message : String(error),
		});
		void settingsStore.update({ webServiceEnabled: false });
	});

	void detectExternalEditorsOnFirstLaunch(settingsStore, appLogger).catch((error) => {
		void appLogger.warn("editor", "External editor first launch detection failed", error);
	});

	// 项目列表可能位于杀软/同步盘较慢的 userData；窗口先显示，随后异步加载，避免 packaged app 打开时白屏等待。
	void projectStore
		.load()
		.then(() => {
			const s = settingsStore.get();
			const visible = s.wslEnabled
				? projectStore.list().filter((p) => p.kind === "chat" || p.environment === "wsl")
				: projectStore.list().filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
			host.sendToRenderer(ipcChannels.projectsChanged, visible);
		})
		.catch(() => undefined);

	// 启动后异步检查 RPC 超时时间，如果小于 600 秒则自动修正为 600 秒
	// 避免用户配置的过小超时（如 30 秒）导致启动或命令执行频繁超时
	setTimeout(() => {
		void settingsStore.ensureRpcTimeoutMinimum().catch((error) => {
			void appLogger.warn("settings", "Failed to ensure rpcTimeout minimum", error);
		});
	}, 0);
}
