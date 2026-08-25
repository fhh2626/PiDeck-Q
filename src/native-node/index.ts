import { join } from "node:path";
import { acquireVersionSingleInstance } from "../main/singleInstance";
import { extractFocusTargetFromArgv } from "../main/utils/focusTarget";
import { readSingleInstancePreference } from "../main/settings/startupPreferences";
import type { Backend } from "../main/backend/Backend";
import { createBackend } from "../main/backend/createBackend";
import { resolveBackgroundsDir } from "../main/backgrounds/BackgroundPaths";
import { readLastWindowBounds, saveLastWindowBounds, type LastWindowBounds } from "../main/windowState";
import { NativeRpcRouter } from "../main/transport/NativeRpcRouter";
import { HostBridge } from "./host/HostBridge";
import { NativeBackendHost } from "./host/NativeBackendHost";
import { createNativePlatformServices } from "./platform/createNativePlatformServices";
import { NativeRendererServer } from "./transport/NativeRendererServer";
import type { NativeClipboardSnapshot } from "../shared/desktop/NativeHostTypes";
import { NativeMemoryMonitor, type NativeRendererDiagnostics } from "./diagnostics/NativeMemoryMonitor";

const port = Number(process.env.PIDECK_HOST_PORT);
const token = process.env.PIDECK_HOST_TOKEN?.trim();
if (!Number.isInteger(port) || port <= 0 || !token) {
	throw new Error("Native host connection environment is incomplete");
}
const nativeToken: string = token;
const hostArgv = (() => {
	try {
		const parsed: unknown = JSON.parse(process.env.PIDECK_ARGV_JSON ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
})();

let bridge: HostBridge | null = null;
let rendererServer: NativeRendererServer | null = null;
let nativeHost: NativeBackendHost | null = null;
let backend: Backend | null = null;
let singleInstance: ReturnType<typeof acquireVersionSingleInstance> | null = null;
let stopPromise: Promise<void> | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastHeartbeatAt = Date.now();
let reloadInFlight = false;
let pendingBounds: LastWindowBounds | null = null;
let userDataDirectory = "";
let memoryMonitor: NativeMemoryMonitor | null = null;
let pendingStartupFocusSessionId: string | null = null;

async function stop(announceReadyToExit = false): Promise<void> {
	if (stopPromise) {
		await stopPromise;
		return;
	}
	stopPromise = (async () => {
		const activeBackend = backend;
		backend = null;
		if (activeBackend) await activeBackend.dispose().catch(() => undefined);
		singleInstance?.dispose();
		singleInstance = null;
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
		memoryMonitor?.stop();
		memoryMonitor = null;
		if (pendingBounds && userDataDirectory) saveLastWindowBounds(userDataDirectory, pendingBounds);
		await rendererServer?.stop().catch(() => undefined);
		rendererServer = null;
		if (announceReadyToExit && bridge) {
			try {
				bridge.emit("application.readyToExit", {});
				await bridge.closeGracefully();
			} catch {
				bridge.close();
			}
		} else {
			bridge?.close();
		}
		bridge = null;
	})();
	await stopPromise;
}

async function main(): Promise<void> {
	bridge = await HostBridge.connect(port, nativeToken);
	const host = bridge;
	const userDataDir = process.env.PIDECK_USER_DATA;
	if (!userDataDir) throw new Error("PIDECK_USER_DATA is missing");
	userDataDirectory = userDataDir;

	const singleInstanceEnabled = readSingleInstancePreference(join(userDataDir, "settings.json"));
	singleInstance = acquireVersionSingleInstance({
		enabled: singleInstanceEnabled,
		version: process.env.PIDECK_VERSION ?? "unknown",
		userDataDir,
		argv: hostArgv.length > 0 ? hostArgv : process.argv,
		onFocusRequest: (payload) => {
			const target = extractFocusTargetFromArgv(payload.argv);
			if (!target?.sessionId) return;
			if (nativeHost) nativeHost.focusSessionFromNotification(target.sessionId);
			else pendingStartupFocusSessionId = target.sessionId;
		},
	});
	if (singleInstanceEnabled && !singleInstance.isPrimary) {
		await host.request("application.exitSecondary").catch(() => undefined);
		await stop();
		return;
	}

	const router = new NativeRpcRouter();
	const platform = createNativePlatformServices(host);
	const rendererRoot = process.env.PIDECK_RENDERER_ROOT ?? join(__dirname, "../renderer");
	const backgroundDirectory = resolveBackgroundsDir(platform.paths.userData);

	// NativeBackendHost only needs the server reference; the server itself invokes
	// the same router handlers registered by createBackend.
	if (process.env.PIDECK_MEMORY_PROFILE === "1") {
		memoryMonitor = new NativeMemoryMonitor(userDataDir, () => backend?.hasActiveStreaming() ?? false);
		await memoryMonitor.start();
	}

	const placeholderServer = new NativeRendererServer({
		router,
		token: nativeToken,
		rendererRoot,
		backgroundDirectory,
		getBootstrap: async () => ({
			clipboard: await host.request<NativeClipboardSnapshot>("clipboard.snapshot"),
			settings: {
				zoomFactor: backend?.settingsStore.get().zoomFactor ?? 1,
				memoryProfileEnabled: process.env.PIDECK_MEMORY_PROFILE === "1",
			},
		}),
		onHeartbeat: () => {
			lastHeartbeatAt = Date.now();
		},
		onMemoryDiagnostics: (payload) => {
			if (!memoryMonitor || typeof payload !== "object" || payload === null) return;
			memoryMonitor.updateRendererDiagnostics(payload as NativeRendererDiagnostics);
		},
		onOversizedEvent: (channel, bytes) => {
			void backend?.appLogger.warn("native", "Dropped oversized renderer event", { channel, bytes });
		},
	});
	rendererServer = placeholderServer;
	host.on<NativeClipboardSnapshot>("native.clipboard", (snapshot) => {
		placeholderServer.broadcast("native.clipboard", [snapshot]);
	});
	host.on<{ paths: string[]; x: number; y: number }>("native.fileDrop", (payload) => {
		placeholderServer.broadcast("native.fileDrop", [payload]);
	});

	nativeHost = new NativeBackendHost(
		host,
		placeholderServer,
		() => ({
			showWindow: backend?.mainCopy("tray.showWindow") ?? "Show",
			restart: backend?.mainCopy("tray.restart") ?? "Restart",
			quit: backend?.mainCopy("tray.quit") ?? "Quit",
		}),
		backend?.appLogger,
	);
	if (pendingStartupFocusSessionId) {
		nativeHost.focusSessionFromNotification(pendingStartupFocusSessionId);
		pendingStartupFocusSessionId = null;
	}

	host.on("window.ready", () => {
		nativeHost?.onWindowReady();
		backend?.startAfterWindowCreated();
	});
	host.on("window.closed", () => nativeHost?.markWindowDestroyed());
	host.on<boolean>("window.visibleChanged", (visible) => {
		nativeHost?.markWindowVisible(visible);
		if (visible) lastHeartbeatAt = Date.now();
	});
	host.on<{ width?: number; height?: number }>("window.normalBoundsChanged", (bounds) => {
		if (typeof bounds.width !== "number" || typeof bounds.height !== "number") return;
		pendingBounds = { width: bounds.width, height: bounds.height };
	});
	host.on("application.prepareQuit", () => {
		void stop(true).then(() => process.exit(0));
	});
	// Keep accepting the old event for sidecars started by an older host during
	// upgrades, but the Qt host now uses prepareQuit so cleanup can be ACKed.
	host.on("application.quit", () => {
		void stop(true).then(() => process.exit(0));
	});

	backend = await createBackend({
		router,
		platform,
		host: nativeHost,
	});
	nativeHost.setLogger(backend.appLogger);

	// Logger-dependent external-link warnings become available after createBackend.
	// The host adapter remains valid because the logger is optional.
	rendererServer = placeholderServer;
	await placeholderServer.start();
	const settings = backend.settingsStore.get();
	host.emit("renderer.ready", {
		url: placeholderServer.getUrl(),
		token: nativeToken,
		startup: {
			theme: settings.theme,
			useNativeTitleBar: settings.useNativeTitleBar,
			closeToTray: settings.closeToTray,
			startupWindowMode: settings.startupWindowMode,
			lastWindowBounds: readLastWindowBounds(userDataDir),
		},
	});

	// Renderer heartbeats preserve Electron's crash-recovery behavior without CDP.
	heartbeatTimer = setInterval(() => {
		if (!nativeHost?.shouldWatchRendererHeartbeat()) return;
		if (Date.now() - lastHeartbeatAt <= 15_000 || reloadInFlight) return;
		reloadInFlight = true;
		void host.request("window.reload")
			.catch(() => undefined)
			.finally(() => {
				reloadInFlight = false;
				lastHeartbeatAt = Date.now();
			});
	}, 3_000);
	heartbeatTimer.unref();

	const focusTarget = extractFocusTargetFromArgv(hostArgv.length > 0 ? hostArgv : process.argv);
	if (focusTarget?.sessionId) {
		nativeHost.focusSessionFromNotification(focusTarget.sessionId);
	} else if (focusTarget?.agentId && backend) {
		const sessionId = backend.resolveSessionIdForAgent(focusTarget.agentId);
		if (sessionId) nativeHost.focusSessionFromNotification(sessionId);
	}
}

process.once("SIGTERM", () => {
	void stop().then(() => process.exit(0));
});
process.once("SIGINT", () => {
	void stop().then(() => process.exit(0));
});

void main().catch((error) => {
	console.error("Native sidecar failed:", error);
	void stop().then(() => process.exit(1));
});
