import { isDevToolsShortcut, toggleMainWindowDevTools } from "./devTools";
import {
	app,
	BrowserWindow,
	ipcMain,
	nativeTheme,
	protocol,
	shell,
	Tray,
} from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { is } from "@electron-toolkit/utils";
import {
	applyLinuxDisplayBackendWorkaround,
	isUsingLinuxXWaylandWorkaround,
} from "./linuxDisplayBackend";
import {
	readElectronChromiumSandboxPreference,
	readSingleInstancePreference,
} from "./settings/startupPreferences";
import { createWindowOptions } from "./window/windowOptions";
import { acquireVersionSingleInstance, type FocusPayload } from "./singleInstance";
import { extractFocusTargetFromArgv } from "./utils/focusTarget";
import type { AppLogLevel, AppSettings, StartupWindowMode } from "../shared/types";
import { ipcChannels } from "../shared/ipc";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";
import { registerBackgroundImageProtocol } from "./platform/electron/backgroundImageProtocol";
import { resolveBackgroundsDir } from "./backgrounds/BackgroundPaths";
import { createElectronPlatformServices } from "./platform/electron/createElectronPlatformServices";
import { createElectronMainWindowControls } from "./window/MainWindowControls";
import { openExternalLink } from "./browser/externalLinks";

// 构建标记：npm run dist:win:dev 打包时由 vite define 注入 true（构建期替换，非运行时环境变量）。
declare const __PIDECK_DEV_BUILD__: boolean;

// 开发态（electron-vite dev）或 dev 构建（dist:win:dev）统一使用 -dev 配置目录，
// 避免与正式版（pi-desktop / PiDeck）的数据、单实例锁和通知归属互相污染。
const isDevBuild = !app.isPackaged || __PIDECK_DEV_BUILD__;

// 开发态与正式版隔离 userData。
// 否则 npm run dev 会与已安装的 PiDeck 共用数据/锁，表现为「开发启动被复用到正式版窗口」。
// 必须在读取 settings / 版本单实例锁之前设置。
if (isDevBuild) {
	// 显式固定为 pi-desktop-dev：dev 构建的 productName 是 PiDeckDev，
	// 默认 userData 会落在 %APPDATA%\PiDeckDev，必须指回 dev 配置目录以复用现有配置。
	// 例外：命令行显式传入 --user-data-dir（e2e 隔离、多实例调试）时尊重该路径，
	// 否则 e2e 会读到本机真实开发数据（settings/projects 全部污染测试断言）。
	const explicitUserDataDir = process.argv.find((arg) => arg.startsWith("--user-data-dir="));
	if (!explicitUserDataDir) {
		app.setPath("userData", join(app.getPath("appData"), "pi-desktop-dev"));
	}
}

// 用户显式指定 X11 时必须在 app.ready 前应用；默认保持系统原生显示后端。
applyLinuxDisplayBackendWorkaround();

// Chromium 沙箱开关必须在 app.ready 前生效。
// 默认关闭：Windows 上部分安全软件/旧 GPU 驱动会在沙箱初始化时触发原生断点（0x80000003）。
// 用户可在「开发设置」中开启 electronChromiumSandbox，重启后走 Chromium 默认沙箱。
const electronChromiumSandboxEnabled = readElectronChromiumSandboxPreference(
	join(app.getPath("userData"), "settings.json"),
);
if (!electronChromiumSandboxEnabled) {
	// 关闭沙箱时显式附带 no-sandbox，避免部分环境仍按默认策略启用。
	app.commandLine.appendSwitch("no-sandbox");
}

// V8 老生代堆上限（渲染进程 + 主进程 + worker 一并生效）：
// Chromium 默认上限 ≈ 物理内存 60%（8GB 机器 ≈ 4.8GB），V8 没有压力就不主动收缩，
// 会话消息/代码块高亮等大对象把堆撑大后 committed 空间长期不归还 OS（内存采样实测：
// V8 总 55MB → 210MB 不回落，RSS 基线随每次操作抬升）。
// 设 384MB：留 2 倍于实测 JS used 峰值（~185MB）的余量，超限即强制 GC 收缩。
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=384");

// Windows 系统通知必须设置 AppUserModelID，否则通知不显示、点击事件不触发。
// dev 与正式版使用不同 AppID，避免通知中心归属混淆（与 dev userData 隔离思路一致）。
if (process.platform === "win32") {
	app.setAppUserModelId(isDevBuild ? "com.ayuayue.pi-desktop-dev" : "com.ayuayue.pi-desktop");
}

// 注册 pideck:// 自定义协议：系统通知点击（toast activationType="protocol"）通过该协议唤起应用，
// 唤起实例的 argv 携带 pideck://session/<id> URL，主进程据此跳转对应会话。
// 仅 packaged 应用注册：dev 模式跑的是 electron 二进制，注册会把协议关联劫持到 electron.exe，
// 覆盖已安装正式版的关联；dev 模式下通知点击依赖 Electron 原生 click 事件聚焦即可。
// 安装包内 electron-builder 的 protocols 配置也会在安装时写入注册表，此处是运行时兜底。
if (app.isPackaged) {
	app.setAsDefaultProtocolClient("pideck");
}

// 按「应用版本」隔离的单实例：同版本复用窗口，不同版本可并行。
// 不用 Electron requestSingleInstanceLock：它按 userData 全局互斥，会导致 0.6.7 与 0.6.8 无法同开。
// focus 回调稍后挂到 focusMainWindow（定义在文件后部），避免顶层 TDZ。
// payload 携带次实例的 argv，可解析「点击系统通知」激活时携带的跳转目标。
let focusExistingWindow: ((payload?: FocusPayload) => void) | null = null;
const singleInstanceEnabled = readSingleInstancePreference(
	join(app.getPath("userData"), "settings.json"),
);
const versionSingleInstance = acquireVersionSingleInstance(
	singleInstanceEnabled,
	app.getVersion(),
	(payload) => {
		focusExistingWindow?.(payload);
	},
);
const gotSingleInstanceLock = versionSingleInstance.isPrimary;
if (singleInstanceEnabled && !gotSingleInstanceLock) {
	// 同版本已有实例：立即退出，由主实例 watch .focus 后唤起窗口。
	// 用 exit(0) 而不是 quit()：第二进程尚未 ready，quit 更慢。
	app.exit(0);
}

// 开发模式下 stdout 管道可能断开导致 EPIPE 崩溃，全局静默处理
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});

import { getAppLogger } from "./logging/sharedLogger";

process.on("uncaughtException", (error) => {
	const logger = backend?.appLogger ?? getAppLogger();
	void logger?.error("process", "Uncaught exception", error);
	console.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
	const logger = backend?.appLogger ?? getAppLogger();
	void logger?.error("process", "Unhandled rejection", reason);
	console.error("Unhandled rejection:", reason);
});

import { readLastWindowBounds, saveLastWindowBounds } from "./windowState";
import { createRendererCrashRecoveryGuard } from "./window/rendererCrashRecovery";
import { registerElectronPreloadLifecycleIpc } from "./ipc/electronPreloadLifecycleIpc";
import { ElectronRpcRouter } from "./transport/ElectronRpcRouter";
import { preparePreloadPath } from "./preloadPath";
import { startMemoryProfile, isMemoryProfileEnabled, type MemoryProfileHandle } from "./memory/MemoryMonitor";
import { createAppTray, refreshAppTrayMenu } from "./window/AppTray";
import type { Backend } from "./backend/Backend";
import { createBackend } from "./backend/createBackend";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: Backend | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
/** 渲染进程崩溃自动恢复守卫（2026-08 黑屏治理，见 window/rendererCrashRecovery.ts）：
 *  非正常崩溃自动 reload 恢复，崩溃风暴（60s 内超 2 次）放弃。 */
const rendererCrashGuard = createRendererCrashRecoveryGuard();
/** 内存采样句柄（PIDECK_MEMORY_PROFILE=1 时启用），quit 时停止 */
let memoryProfileHandle: MemoryProfileHandle | null = null;

function sendToRenderer(channel: string, ...args: unknown[]): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(channel, ...args);
}

function applyNativeThemeSource(settings: AppSettings) {
	// 原生标题栏不受 renderer CSS 影响；跟随应用主题，避免暗色界面顶部仍是系统浅色栏。
	nativeTheme.themeSource = settings.theme === "system" ? "system" : settings.theme;
}

/**
 * 重启应用：先同步退出标志并停掉常驻服务，再 relaunch + quit。
 * 必须置 isQuitting，否则 closeToTray 会把退出流程吞成「隐藏到托盘」，relaunch 不生效。
 */
function restartApp(): void {
	isQuitting = true;
	backend?.dispose();
	app.relaunch();
	app.quit();
}

function refreshTrayContextMenu(): void {
	if (!tray || !backend) return;
	refreshAppTrayMenu(
		tray,
		{
			showWindow: backend.mainCopy("tray.showWindow"),
			restart: backend.mainCopy("tray.restart"),
			quit: backend.mainCopy("tray.quit"),
		},
		{
			showWindow: showMainWindowFromTray,
			restart: restartApp,
			quit: () => {
				isQuitting = true;
				app.quit();
			},
		},
	);
}

function showMainWindowFromTray(): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.show();
	mainWindow.focus();
}

/** 从托盘/任务栏/二次启动唤起主窗口：处理最小化、隐藏到托盘两种状态。 */
function focusMainWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	if (typeof mainWindow.setSkipTaskbar === "function") {
		mainWindow.setSkipTaskbar(false);
	}
	mainWindow.show();
	mainWindow.focus();
	if (process.platform === "win32") {
		mainWindow.setAlwaysOnTop(true);
		mainWindow.setAlwaysOnTop(false);
	}
}

/**
 * 页面加载期间（冷启动/窗口重建）点击通知的跳转目标：直接 send 会在 preload/React
 * 监听注册前丢失，先存入 pending，由两条路径兜底送达：
 * 1. did-finish-load 后 flush 一次（窗口重建/旧 renderer 兼容的尽力而为）；
 * 2. renderer 挂载后经 app:get-focus-target-pending 主动拉取（取走即清空，保证送达）。
 */
let pendingFocusTarget: { sessionId: string } | null = null;

/** 窗口就绪（存在且未在加载）直接推送；否则入 pending 队列。 */
function queueFocusTarget(sessionId: string) {
	if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
		mainWindow.webContents.send(ipcChannels.appFocusSessionTarget, { sessionId });
		return;
	}
	pendingFocusTarget = { sessionId };
}

/** did-finish-load 兜底：仍在加载期排队的目标补发一次（不清空，renderer 拉取幂等）。 */
function flushPendingFocusTargetOnLoad() {
	if (pendingFocusTarget && mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(ipcChannels.appFocusSessionTarget, pendingFocusTarget);
	}
}

function handleVersionFocusRequest(payload?: FocusPayload) {
	const target = extractFocusTargetFromArgv(payload?.argv);
	const activateSession = () => {
		if (!target || !mainWindow || mainWindow.isDestroyed()) return;
		let sessionId = target.sessionId;
		if (!sessionId && target.agentId && backend) {
			sessionId = backend.resolveSessionIdForAgent(target.agentId);
		}
		if (sessionId) queueFocusTarget(sessionId);
	};
	if (mainWindow && !mainWindow.isDestroyed()) {
		focusMainWindow();
		activateSession();
		return;
	}
	void app.whenReady().then(() => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			focusMainWindow();
			activateSession();
			return;
		}
		if (backend) {
			void createWindow()
				.then(() => {
					activateSession();
				})
				.catch((error) => {
					void (backend?.appLogger ?? getAppLogger())?.error("app", "Failed to recreate window on version focus request", error);
				});
		}
	});
}

// 顶层锁回调延后绑定：focusMainWindow / createWindow 定义在锁申请之后。
focusExistingWindow = handleVersionFocusRequest;

function setupTray() {
	// ?asset 路径由构建器解析；模块仅负责 Electron Tray 细节。
	tray = createAppTray(iconPath, showMainWindowFromTray);
	refreshTrayContextMenu();
}

// 外部 URL 统一入口：协议安全网关在 externalLinks.ts（可单测），
// 此处只注入 Electron shell；forceSystem 保留以兼容现有调用者。
async function openExternalUrl(url: string, _forceSystem = false) {
	await openExternalLink(url, {
		openInSystem: (target) => shell.openExternal(target),
		logger: backend?.appLogger,
	});
}

function printStartupInfo() {
	if (!mainWindow || mainWindow.isDestroyed() || !backend) return;

	const settings = backend.settingsStore.get();
	const appVersion = app.getVersion();
	const electronVersion = process.versions.electron;
	const chromeVersion = process.versions.chrome;
	const nodeVersion = process.versions.node;
	const platform = process.platform;
	const arch = process.arch;
	const persistentInstallationType = settings.installationType || "unknown";
	const isPortableEnv = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
	// Debug 中展示实际生效类型,便于发现持久化值和运行时便携信号不一致的问题。
	const effectiveInstallationType =
		process.platform === "win32" && isPortableEnv ? "portable" : persistentInstallationType;

	// 执行 console.log 输出到开发者工具
	mainWindow.webContents.executeJavaScript(`
		console.log(
			"%c╭──────────────────────────────────────────────────────────╮",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log(
			"%c│                     PiDeck-Q Desktop                     │",
			"color: #8b5cf6; font-weight: bold; font-size: 16px;"
		);
		console.log(
			"%c╰──────────────────────────────────────────────────────────╯",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log("");
		console.log("%c📦 Application Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Version:         %c${appVersion}", "color: #6b7280;", "color: #10b981; font-weight: bold;");
		console.log("%c  Installation:    %c${effectiveInstallationType}", "color: #6b7280;", "color: #f59e0b; font-weight: bold;");
		console.log("%c  Platform:        %c${platform} (${arch})", "color: #6b7280;", "color: #8b5cf6;");
		console.log("");
		console.log("%c⚡ Runtime Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Electron:        %c${electronVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Chrome:          %c${chromeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Node:            %c${nodeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("");
		console.log("%c🔧 Debug Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  PORTABLE_EXECUTABLE_DIR: %c${isPortableEnv ? '✅ Set' : '❌ Not set'}", "color: #6b7280;", "color: ${isPortableEnv ? '#10b981' : '#ef4444'};");
		console.log("%c  Persistent installationType: %c${persistentInstallationType}", "color: #6b7280;", "color: #8b5cf6; font-weight: bold;");
		console.log("");
		console.log("%c🐛 Found a bug? Report at:", "color: #6b7280;");
		console.log("%c  https://github.com/fhh2626/PiDeck-Pi_Agent_Rust/issues", "color: #3b82f6; text-decoration: underline;");
		console.log("");
		console.log("%c🎉 Easter egg: You found it! Thanks for exploring.", "color: #ec4899; font-weight: bold;");
		console.log("");
	`);
}

async function prepareMainPreloadPath() {
	const sourcePath = join(__dirname, "../preload/index.js");
	return preparePreloadPath(sourcePath, "main-preload.js");
}

async function createWindow() {
	if (!backend) return;
	applyNativeThemeSource(backend.settingsStore.get());
	const windowOptions = createWindowOptions(backend.settingsStore.get());
	const showMainWindowImmediately = shouldShowMainWindowImmediately();
	const sourcePreloadPath = join(__dirname, "../preload/index.js");
	const mainPreloadPath = await prepareMainPreloadPath();
	void backend.appLogger.info("app", "Main window preload configured", {
		sourcePreloadPath,
		preloadPath: mainPreloadPath,
		sourceExists: existsSync(sourcePreloadPath),
		exists: existsSync(mainPreloadPath),
		appPath: app.getAppPath(),
		userDataPath: app.getPath("userData"),
		packaged: app.isPackaged,
		isDev: is.dev,
		electronRendererUrl: process.env.ELECTRON_RENDERER_URL ? "set" : "unset",
	});

	// 根据用户的主题设置选择窗口背景色，避免系统标题栏与暗色主题间出现浅色条带。
	// 色值与 foundation.css 的 light/dark 基底保持一致（暖白 / 暖黑）。
	const theme = backend.settingsStore.get().theme;
	const isDark =
		theme === "dark" ||
		(theme === "system" && nativeTheme.shouldUseDarkColors);
	const backgroundColor = isDark ? "#121212" : "#f8f8f5";

	// 按外观设置的启动预设调整初始尺寸；隐藏态先 maximize/fullscreen，减少首帧跳动。
	// startupWindowMode="last"：读上次关闭时的窗口大小；读不到（首次启动/记录损坏）顺延默认 maximized
	const requestedMode = backend.settingsStore.get().startupWindowMode ?? "last";
	let effectiveStartupMode = requestedMode;
	let startupBounds: { width: number; height: number };
	if (requestedMode === "last") {
		const last = readLastWindowBounds(app.getPath("userData"));
		if (last) {
			startupBounds = last;
		} else {
			effectiveStartupMode = "maximized";
			startupBounds = resolveStartupWindowBounds("maximized");
		}
	} else {
		startupBounds = resolveStartupWindowBounds(requestedMode);
	}

	mainWindow = new BrowserWindow({
		show: showMainWindowImmediately,
		backgroundColor,
		width: startupBounds.width,
		height: startupBounds.height,
		minWidth: 880,
		minHeight: 640,
		// Windows 任务栏/Alt-Tab 显示这个标题。自定义无框标题栏时 UI 自己画标题，
		// 但 OS 任务栏仍读 BrowserWindow.title；空字符串会变成“只有图标、没有软件名”。
		title: "PiDeck-Q",
		icon: iconPath,
		frame: windowOptions.frame,
		titleBarStyle: windowOptions.titleBarStyle,
		...(windowOptions.trafficLightPosition ? { trafficLightPosition: windowOptions.trafficLightPosition } : {}),
		webPreferences: {
			preload: mainPreloadPath,
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	const createdWindow = mainWindow;
	let hasShownMainWindow = false;
	function showMainWindowOnce() {
		if (createdWindow.isDestroyed() || hasShownMainWindow) return;
		hasShownMainWindow = true;
		createdWindow.show();
		createdWindow.focus();
		// 向开发者工具输出启动信息
		printStartupInfo();
	}

	// 窗口保持隐藏时先按启动预设调整（maximize/fullscreen），再加载页面；
	// 避免 ready-to-show 后再调整造成首帧布局跳变。
	applyStartupWindowMode(
		mainWindow,
		effectiveStartupMode,
		showMainWindowImmediately,
	);

	// 所有 target="_blank" 或 window.open 的链接统一经同一受控外链入口处理。
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void openExternalUrl(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("did-start-loading", () => {
		void backend?.appLogger.info("app", "Main window load started", {
			url: mainWindow?.webContents.getURL(),
		});
	});
	mainWindow.webContents.on("did-finish-load", () => {
		void backend?.appLogger.info("app", "Main window load finished", {
			url: mainWindow?.webContents.getURL(),
		});
		// 恢复用户设置的窗口缩放；在 did-finish-load 后应用，避免早期设置被覆盖。
		if (backend) {
			mainWindow?.webContents.setZoomFactor(backend.settingsStore.get().zoomFactor);
		}
		flushPendingFocusTargetOnLoad();
	});
	mainWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			void backend?.appLogger.error("app", "Main window load failed", {
				errorCode,
				errorDescription,
				validatedURL,
				isMainFrame,
			});
		},
	);
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		const level: AppLogLevel = details.reason === "clean-exit" ? "info" : "error";
		void backend?.appLogger.log(level, "app", "Main window renderer process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
		// 黑屏治理：非正常崩溃自动 reload 恢复；clean-exit（正常退出）、用户主动退出
		// 与崩溃风暴（窗口期内超限）不恢复。reload 前检查窗口/webContents 仍存活。
		if (isQuitting || !rendererCrashGuard.shouldAutoReload(details.reason)) return;
		void backend?.appLogger.warn("app", "Auto-reloading main window after renderer crash", {
			reason: details.reason,
			exitCode: details.exitCode,
			recoveriesInWindow: rendererCrashGuard.recoveriesInWindow(),
		});
		if (mainWindow && !mainWindow.isDestroyed()) {
			try {
				mainWindow.webContents.reload();
			} catch (error) {
				// reload 抛异常（webContents 已销毁等竞态）：记日志，留给用户手动处理
				void backend?.appLogger.error("app", "Auto-reload failed", error);
			}
		}
	});
	// 子进程（含 GPU/utility）异常退出：Mac 上偶发“整窗闪一下”，需要留下 reason/exitCode。
	app.on("child-process-gone", (_event, details) => {
		void backend?.appLogger.error("process", "Child process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
	});
	mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
		void backend?.appLogger.error("app", "Main window preload failed", {
			preloadPath,
			message: error.message,
			stack: error.stack,
		});
	});
	mainWindow.webContents.on("dom-ready", () => {
		void mainWindow?.webContents
			.executeJavaScript("Boolean(window.piDesktop)", true)
			.then((hasPiDesktop) => {
				void backend?.appLogger.info("app", "Main window preload API availability", {
					hasPiDesktop,
					url: mainWindow?.webContents.getURL(),
				});
			})
			.catch((error) => {
				void backend?.appLogger.warn("app", "Main window preload API check failed", error);
			});
	});
	mainWindow.webContents.on(
		"console-message",
		(event) => {
			if (!["warning", "error"].includes(event.level)) return;
			void backend?.appLogger.warn("app", "Main window renderer console error", {
				level: event.level,
				message: event.message,
				line: event.lineNumber,
				sourceId: event.sourceId,
			});
		},
	);

	mainWindow.once("ready-to-show", showMainWindowOnce);
	mainWindow.webContents.once("did-finish-load", showMainWindowOnce);
	setTimeout(showMainWindowOnce, 3000);
	if (showMainWindowImmediately) {
		showMainWindowOnce();
	}

	// 窗口大小记忆：关闭/退出前保存 normal bounds（最大化/全屏时取恢复后的尺寸），
	// 供下次 startupWindowMode="last" 启动使用；隐藏到托盘不记录（窗口未关闭）。
	// 注意：mainWindow 为模块级可空变量，此处用创建后的局部引用确保非空
	const windowForState = createdWindow;
	windowForState.on("close", () => {
		if (!windowForState.isDestroyed()) {
			const normal = windowForState.isMaximized() || windowForState.isFullScreen()
				? windowForState.getNormalBounds()
				: windowForState.getBounds();
			saveLastWindowBounds(app.getPath("userData"), { width: normal.width, height: normal.height });
		}
	});

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	mainWindow.on("close", (event) => {
		if (!isQuitting && backend?.settingsStore.get().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		} else if (!isQuitting) {
			// 如果没有启用托盘，关闭窗口时直接退出应用
			isQuitting = true;
			app.quit();
		}
	});

	// 监听标准快捷键打开开发者工具（F12 / Ctrl+Shift+I / Ctrl+Shift+J，
	// macOS 变体与开关逻辑集中在 devTools.ts，主窗口/设置 IPC 共用）
	mainWindow.webContents.on("before-input-event", (event, input) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (isDevToolsShortcut(input)) {
			event.preventDefault();
			toggleMainWindowDevTools(mainWindow);
		}
	});

	const devRendererUrl = shouldUseDevRendererUrl()
		? process.env.ELECTRON_RENDERER_URL
		: undefined;
	if (devRendererUrl) {
		mainWindow.loadURL(devRendererUrl);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

function shouldUseDevRendererUrl() {
	return is.dev && !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
}

function shouldShowMainWindowImmediately() {
	return isUsingLinuxXWaylandWorkaround();
}

/** 启动尺寸预设 → 初始窗口尺寸；全屏/最大化也给合理兜底，避免显示器信息异常时缩成最小窗。 */
function resolveStartupWindowBounds(mode: StartupWindowMode): {
	width: number;
	height: number;
} {
	switch (mode) {
		case "normal-compact":
			return { width: 1100, height: 720 };
		case "normal-medium":
			return { width: 1280, height: 840 };
		case "normal-large":
			return { width: 1480, height: 960 };
		case "maximized":
		case "fullscreen":
		default:
			return { width: 1480, height: 960 };
	}
}

/** 在窗口创建后应用启动尺寸预设；隐藏态先 maximize/fullscreen，减少首帧跳动。 */
function applyStartupWindowMode(
	window: BrowserWindow,
	mode: StartupWindowMode,
	showImmediately: boolean,
) {
	if (mode === "fullscreen") {
		// setFullScreen 在某些平台要求窗口已 show；隐藏态先 maximize 再在 show 后补全屏。
		if (showImmediately) {
			window.setFullScreen(true);
		} else {
			window.maximize();
			window.once("show", () => {
				if (!window.isDestroyed()) window.setFullScreen(true);
			});
		}
		return;
	}
	if (mode === "maximized") {
		window.maximize();
	}
}

// 换肤背景图协议：自定义 scheme 必须在 ready 前注册特权声明（secure 以便渲染层 CSS 引用）
protocol.registerSchemesAsPrivileged([
	{ scheme: "pideck-bg", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
]);

function focusSessionFromNotification(sessionId?: string): boolean {
	if (!mainWindow || mainWindow.isDestroyed()) return false;
	if (mainWindow.isMinimized()) mainWindow.restore();
	if (!mainWindow.isVisible()) mainWindow.show();
	mainWindow.focus();
	if (sessionId) {
		mainWindow.webContents.send(ipcChannels.appFocusSessionTarget, { sessionId });
	}
	return true;
}

function hasLiveWindow(): boolean {
	return Boolean(mainWindow && !mainWindow.isDestroyed());
}

app.whenReady().then(async () => {
	// 未拿到同版本主实例锁时不要继续初始化，避免第二进程短暂闪窗。
	if (singleInstanceEnabled && !gotSingleInstanceLock) return;

	const backgroundDirectory = resolveBackgroundsDir(app.getPath("userData"));
	registerBackgroundImageProtocol(backgroundDirectory);

	const router = new ElectronRpcRouter(ipcMain);

	const platformServices = createElectronPlatformServices({
		getMainWindow: () => mainWindow,
	});

	backend = await createBackend({
		router,
		platform: platformServices,
		runtime: {
			devRendererUrl: shouldUseDevRendererUrl()
				? process.env.ELECTRON_RENDERER_URL
				: undefined,
		},
		host: {
			mainWindowControls: createElectronMainWindowControls(() => mainWindow),
			sendToRenderer,
			hasLiveWindow,
			openExternalUrl,
			refreshTrayContextMenu,
			restartApplication: restartApp,
			takePendingFocusTarget: () => {
				const target = pendingFocusTarget;
				pendingFocusTarget = null;
				return target;
			},
			focusSessionFromNotification,
		},
	});

	registerElectronPreloadLifecycleIpc(ipcMain, {
		appLogger: backend.appLogger,
	});

	// 内存分析模式（PIDECK_MEMORY_PROFILE=1）：尽早开始采样，覆盖窗口创建/加载全过程。
	// 采样失败不阻塞启动（诊断工具降级为不可用）。
	if (isMemoryProfileEnabled()) {
		memoryProfileHandle = await startMemoryProfile(() => backend?.hasActiveStreaming() ?? false).catch((error) => {
			console.error("Failed to start memory profile:", error);
			return null;
		});
	}

	// 窗口先于 WSL 探测 / pi settings 修补 / Web 服务启动创建：
	// 那几步可能各花数秒（wsl.exe printenv 最多 8s），Typora/VS Code 不会在首窗前做这些事。
	await createWindow();
	setupTray();

	backend.startAfterWindowCreated();

	// 冷启动通知唤起：应用未运行时点击系统通知，本进程即为唯一实例（无次实例 .focus 流转），
	// argv 携带 pideck:// URL，窗口就绪后直接向 renderer 发送跳转目标。
	// catalog 可能尚未加载完，renderer 侧监听会小间隔重试直到能解析到会话记录。
	const coldStartTarget = extractFocusTargetFromArgv(process.argv);
	const coldStartSessionId = coldStartTarget?.sessionId ??
		(coldStartTarget?.agentId ? backend.resolveSessionIdForAgent(coldStartTarget.agentId) : undefined);
	if (coldStartSessionId) {
		queueFocusTarget(coldStartSessionId);
	}

	// macOS dock 点击或任务栏点击时恢复窗口
	app.on("activate", () => {
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		} else {
			void createWindow().catch((error) => {
				void backend?.appLogger.error("app", "Failed to create window on activate", error);
			});
		}
	});
});

app.on("before-quit", () => {
	isQuitting = true;
	memoryProfileHandle?.stop();
	memoryProfileHandle = null;
	tray?.destroy();
	tray = null;
	backend?.dispose();
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
