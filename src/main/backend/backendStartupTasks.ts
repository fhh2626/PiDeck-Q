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
 * 删除用户扩展目录中的 PiDeck 扩展文件（历史部署或已下线扩展）。
 * 内置扩展现改为 -e 从 app resources 加载，用户目录不应再有 pi-deck-* 副本。
 */
async function removeStalePiDeckExtension(
	extensionName: string,
	homeDir: string,
	appLogger: AppLogger,
): Promise<void> {
	const targetPath = join(homeDir, ".pi", "agent", "extensions", extensionName);
	await rm(targetPath, { force: true });
	appLogger.info("extension", "Removed legacy/stale extension", { path: targetPath });
}

/**
 * 升级迁移：清掉历史版本复制到 ~/.pi/agent/extensions 的内置扩展与已下线扩展。
 * 覆盖 Windows home；WSL 启用时同步清理 \\wsl$ 映射 home。
 */
async function migrateLegacyBuiltInExtensions(
	homeDir: string,
	settingsStore: SettingsStore,
	appLogger: AppLogger,
): Promise<void> {
	const legacyNames = [
		...BUILT_IN_EXTENSIONS,
		...LEGACY_BUILT_IN_EXTENSION_NAMES,
		"pi-deck-project-trust.ts",
		"pi-deck-file-capture.ts",
	];
	const homes = [homeDir];
	const wslSettings = settingsStore.get();
	if (wslSettings.wslEnabled && wslSettings.wslDistro && wslSettings.wslUser) {
		homes.push(`\\\\wsl$\\${wslSettings.wslDistro}\\home\\${wslSettings.wslUser}`);
	}
	for (const home of homes) {
		for (const name of legacyNames) {
			await removeStalePiDeckExtension(name, home, appLogger).catch(() => undefined);
		}
	}
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
	homeDir: string,
	settingsStore: SettingsStore,
	piLocator: PiLocator,
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

	// Windows 本地
	const winDir = join(homeDir, ".pi", "agent");
	await ensurePiSettingsDefaults(winDir, piVersion).catch(() => {});

	// WSL（如果已配置）
	if (s.wslEnabled && s.wslDistro && s.wslUser) {
		const wslDir = join(`\\\\wsl$\\${s.wslDistro}\\home\\${s.wslUser}`, ".pi", "agent");
		await ensurePiSettingsDefaults(wslDir, piVersion).catch(() => {});
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
	const { paths, host, services } = deps;
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

	// 根据已加载的 WSL 设置配置会话扫描器，使其能同时扫描 WSL 中的 pi 会话目录
	const syncWslConfig = async () => {
		const { wslEnabled, wslDistro, wslUser } = settingsStore.get();
		if (wslEnabled && wslDistro && wslUser) {
			const { resolveWslEnvironment } = await import("../wsl/WslEnvironment");
			const wslEnv = await resolveWslEnvironment(wslDistro, wslUser, {
				warn: (msg: string, detail: unknown) => console.warn("[PiDeck] " + String(msg), detail),
			});
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

	void syncWslConfig().catch((error) => {
		console.error("Failed to sync WSL config:", error);
	});

	void migrateLegacyBuiltInExtensions(paths.home, settingsStore, appLogger).catch((error) => {
		console.error("Failed to migrate legacy built-in extensions:", error);
	});

	void ensureAllPiSettingsDefaults(paths.home, settingsStore, piLocator).catch((error) => {
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
