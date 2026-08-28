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
import type { NativeClipboardMetadata, NativeClipboardSnapshot, NativeFileDropPayload } from "../shared/desktop/NativeHostTypes";
import { ipcChannels } from "../shared/ipc";
import { NativeMemoryMonitor, type NativeRendererDiagnostics } from "./diagnostics/NativeMemoryMonitor";
import { resolveSecondaryFocusSessionId } from "./focusRequest";
import { nextLoadFailureAction } from "./loadFailureRecovery";
import {
	advanceNativeHeartbeatRecovery,
	createNativeHeartbeatRecoveryState,
} from "./transport/nativeHeartbeatRecovery";
import { shouldReloadAfterMissedHeartbeats } from "./transport/nativeHeartbeatWatchdog";

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
let singleInstance: Awaited<ReturnType<typeof acquireVersionSingleInstance>> | null = null;
let stopPromise: Promise<void> | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastHeartbeatAt = Date.now();
let reloadInFlight = false;
let heartbeatRecoveryState = createNativeHeartbeatRecoveryState();
let pendingBounds: LastWindowBounds | null = null;
let userDataDirectory = "";
let memoryMonitor: NativeMemoryMonitor | null = null;
let pendingStartupFocusSessionId: string | null = null;
let pendingStartupFocusAgentId: string | null = null;
let loadFailureCount = 0;
let loadRetryTimer: NodeJS.Timeout | null = null;

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
		if (loadRetryTimer) clearTimeout(loadRetryTimer);
		loadRetryTimer = null;
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
	singleInstance = await acquireVersionSingleInstance({
		enabled: singleInstanceEnabled,
		version: process.env.PIDECK_VERSION ?? "unknown",
		userDataDir,
		argv: hostArgv.length > 0 ? hostArgv : process.argv,
		onFocusRequest: (payload) => {
			// A secondary launch is a focus request even when its argv has no
			// session/agent target. Restore the hidden-to-tray window first, then
			// resolve the optional deep-link target without dropping the request.
			void host.request("window.show").catch(() => undefined);
			void host.request("window.focus").catch(() => undefined);
			const target = extractFocusTargetFromArgv(payload.argv);
			const sessionId = resolveSecondaryFocusSessionId(
				target,
				(agentId) => backend?.resolveSessionIdForAgent(agentId),
			);
			if (!sessionId) {
				if (target?.agentId) pendingStartupFocusAgentId = target.agentId;
				return;
			}
			if (nativeHost) nativeHost.focusSessionFromNotification(sessionId, false);
			else pendingStartupFocusSessionId = sessionId;
		},
	});
	if (singleInstanceEnabled && !singleInstance.isPrimary) {
		await host.request("application.exitSecondary").catch(() => undefined);
		await stop();
		return;
	}

	const router = new NativeRpcRouter();
	router.handle(ipcChannels.nativeClipboardSnapshot, () =>
		host.request<NativeClipboardSnapshot>("clipboard.snapshot"),
	);
	const platform = createNativePlatformServices(host);
	const rendererRoot = process.env.PIDECK_RENDERER_ROOT ?? join(__dirname, "../renderer");
	const backgroundDirectory = resolveBackgroundsDir(platform.paths.userData);

	// NativeBackendHost only needs the server reference; the server itself invokes
	// the same router handlers registered by createBackend.
	if (process.env.PIDECK_MEMORY_PROFILE === "1") {
		memoryMonitor = new NativeMemoryMonitor(userDataDir, () => backend?.hasActiveStreaming() ?? false);
		await memoryMonitor.start();
	}

	let rendererServerRecoveryInFlight = false;
	const createRendererPageUrl = (rendererUrl: string): string => {
		const pageUrl = new URL(rendererUrl);
		pageUrl.searchParams.set("runtime", "native");
		pageUrl.searchParams.set("token", nativeToken);
		return pageUrl.toString();
	};
	const recoverRendererServer = async (serverError: Error): Promise<void> => {
		if (rendererServerRecoveryInFlight) return;
		rendererServerRecoveryInFlight = true;
		try {
			const retryDelays = [0, 500, 1_000];
			for (const delayMs of retryDelays) {
				if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
				try {
					await placeholderServer.start();
					// The Qt window is created before renderer.ready, so liveWindow only
					// becomes true after a successful page load. Always hand the new URL to
					// the host: its no-op-before-window behavior also covers that race.
					await host.request("window.load", { url: createRendererPageUrl(placeholderServer.getUrl()) });
					return;
				} catch (error) {
					serverError = error instanceof Error ? error : serverError;
				}
			}
			void backend?.appLogger.error("native", "Renderer server recovery failed", {
				error: serverError.message,
			});
			void host.request("window.showLoadError", {
				url: "native renderer server",
				error: "The native renderer server could not be restarted.",
			}).catch(() => undefined);
		} finally {
			rendererServerRecoveryInFlight = false;
		}
	};
	const placeholderServer = new NativeRendererServer({
		router,
		token: nativeToken,
		rendererRoot,
		backgroundDirectory,
		onServerError: (error) => {
			void recoverRendererServer(error);
		},
		getBootstrap: async () => ({
			// Bootstrap only needs clipboard metadata. PNG encoding is reserved for
			// the live snapshot requested by an actual paste operation.
			clipboard: await host.request<NativeClipboardMetadata>("clipboard.metadataSnapshot"),
			settings: {
				zoomFactor: backend?.settingsStore.get().zoomFactor ?? 1,
				memoryProfileEnabled: process.env.PIDECK_MEMORY_PROFILE === "1",
			},
		}),
		onHeartbeat: (payload, state) => {
			lastHeartbeatAt = Date.now();
			const recovery = advanceNativeHeartbeatRecovery(
				heartbeatRecoveryState,
				payload,
				state.eventChannelHealthy,
			);
			heartbeatRecoveryState = recovery.state;
			// Renderer owns the first recovery attempt by reconnecting with its
			// replay cursor. Native only reloads after several unhealthy heartbeats
			// whose renderer cursor did not advance, so active streaming cannot be
			// mistaken for a stuck SSE connection.
			if (!recovery.shouldReload || reloadInFlight) return;
			reloadInFlight = true;
			void host.request("window.reload")
				.catch(() => undefined)
				.finally(() => {
					reloadInFlight = false;
					lastHeartbeatAt = Date.now();
				});
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
	host.on<NativeClipboardMetadata>("native.clipboard", (snapshot) => {
		placeholderServer.broadcast("native.clipboard", [snapshot]);
	});
	host.on<NativeFileDropPayload>("native.fileDrop", (payload) => {
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
		loadFailureCount = 0;
		heartbeatRecoveryState = createNativeHeartbeatRecoveryState();
		if (loadRetryTimer) clearTimeout(loadRetryTimer);
		loadRetryTimer = null;
		nativeHost?.onWindowReady();
		backend?.startAfterWindowCreated();
	});
	host.on<{ url?: string; error?: string }>("window.loadFailed", (payload) => {
		if (loadRetryTimer) return;
		const action = nextLoadFailureAction(loadFailureCount);
		if (action.kind === "showError") {
			void host.request("window.showLoadError", {
				url: payload?.url ?? "",
				error: payload?.error ?? "Renderer failed to load",
			}).catch(() => undefined);
			return;
		}
		loadFailureCount += 1;
		loadRetryTimer = setTimeout(() => {
			loadRetryTimer = null;
			void host.request("window.reload").catch(() => undefined);
		}, action.delayMs);
	});
	host.on<{ action?: string }>("window.loadErrorAction", (payload) => {
		if (payload?.action === "retry" || payload?.action === "restart") {
			loadFailureCount = 0;
			void host.request("window.reload").catch(() => undefined);
			return;
		}
		if (payload?.action === "exit") void stop(true).then(() => process.exit(1));
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
	if (pendingStartupFocusAgentId) {
		const sessionId = backend.resolveSessionIdForAgent(pendingStartupFocusAgentId);
		pendingStartupFocusAgentId = null;
		if (sessionId) nativeHost.focusSessionFromNotification(sessionId, false);
	}

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
		if (!shouldReloadAfterMissedHeartbeats(Date.now() - lastHeartbeatAt) || reloadInFlight) return;
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
