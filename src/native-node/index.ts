import { join } from "node:path";
import { acquireVersionSingleInstance } from "../main/singleInstance";
import { extractFocusTargetFromArgv } from "../main/utils/focusTarget";
import { readSingleInstancePreference } from "../main/settings/startupPreferences";
import type { Backend } from "../main/backend/Backend";
import { createBackend } from "../main/backend/createBackend";
import { resolveBackgroundsDir } from "../main/backgrounds/BackgroundPaths";
import { readLastWindowBounds, saveLastWindowBounds, type LastWindowBounds } from "../main/windowState";
import { NativeRpcRouter } from "../main/transport/NativeRpcRouter";
import { ExternalFileCapabilityStore } from "../main/fs/ExternalFileCapabilityStore";
import { HostBridge } from "./host/HostBridge";
import { NativeBackendHost } from "./host/NativeBackendHost";
import { requestWithFallback } from "./host/requestWithFallback";
import { createNativePlatformServices } from "./platform/createNativePlatformServices";
import { NativeRendererServer, type NativeEventChannelDiagnostic } from "./transport/NativeRendererServer";
import { LiveResyncCoalescer, type LiveResyncRequest } from "./transport/liveResyncCoalescer";
import { monotonicNowMs } from "../main/transport/monotonicNow";
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
/**
 * 补发状态的节流窗口：超大帧可能连续触发，没有节流会每帧都全量重推一次消息窗口。
 * 窗口内的后续请求不丢弃，而是合并成窗口结束时的一次尾随补发（见 LiveResyncCoalescer）。
 */
const LIVE_RESYNC_DEDUPE_MS = 1_000;
/** 启动握手等待宿主剪贴板元数据的上限；超时即降级为空剪贴板。 */
const BOOTSTRAP_CLIPBOARD_TIMEOUT_MS = 2_000;
const externalFileCapabilities = new ExternalFileCapabilityStore();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function issueClipboardCapability(snapshot: NativeClipboardMetadata): string {
	return externalFileCapabilities.issueClipboard(snapshot.filePaths, snapshot.sequence) ?? "";
}

/**
 * 事件流断层时的无导航恢复：不重载页面，只让后端把当前 AgentTab 状态与
 * 各 Agent 的完整消息窗口重推一遍，渲染层用实时缓存自愈。
 * 重载会丢掉用户当前的滚动位置和进行中的输入，而断层本身并不代表渲染层坏掉。
 */
const liveResync = new LiveResyncCoalescer({
	windowMs: LIVE_RESYNC_DEDUPE_MS,
	run: ({ reason, lostSinceMs }) => {
		void backend?.appLogger.info("native", "Renderer state resync without navigation", {
			reason,
			// 单调时钟读数本身无意义，记录“断层已持续多久”；null 表示起点未知、按全量补发。
			gapAgeMs: lostSinceMs === undefined ? null : Math.round(monotonicNowMs() - lostSinceMs),
		});
		backend?.resyncLiveRendererState({ lostSinceMs });
	},
	onCoalesced: ({ reason }) => {
		void backend?.appLogger.debug("native", "Renderer state resync coalesced into trailing resync", { reason });
	},
	onReentrantIgnored: ({ reason }) => {
		void backend?.appLogger.debug("native", "Renderer state resync request raised by the resync itself ignored", { reason });
	},
	onError: (error, { reason }) => {
		void backend?.appLogger.error("native", "Renderer state resync failed", {
			reason,
			error: error instanceof Error ? error.message : String(error),
		});
	},
});

function requestLiveResync(request: LiveResyncRequest): void {
	liveResync.request(request);
}

/**
 * 背压掐断意味着渲染层确实丢了连接，记 warn；大帧在长会话的正常流式输出中每次全量 flush 都会出现，
 * 只作排查参考，记 info，避免 warn 日志被正常流量淹没。
 */
function logEventChannelDiagnostic(event: NativeEventChannelDiagnostic): void {
	if (event.kind === "client-backpressure-dropped") {
		void backend?.appLogger.warn("native", "Native event channel diagnostic", { ...event });
		return;
	}
	void backend?.appLogger.info("native", "Native event channel diagnostic", { ...event });
}

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
		externalFileCapabilities.clear();
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
		liveResync.dispose();
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
	// The Qt supervisor is the single owner of sidecar recovery. Give normal
	// resource cleanup a bounded window, then exit so recovery cannot hang.
	host.onFatal(() => {
		const hardExit = setTimeout(() => process.exit(1), 1_500);
		void stop().finally(() => {
			clearTimeout(hardExit);
			process.exit(1);
		});
	});
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
	router.handle(ipcChannels.nativeClipboardSnapshot, async () => {
		const snapshot = await host.request<NativeClipboardSnapshot>("clipboard.snapshot");
		// Reuse the sequence-bound clipboard capability so image reads do not
		// invalidate later file-drawer pastes for the same OS clipboard contents.
		const externalFileCapabilityId = issueClipboardCapability(snapshot);
		return {
			...snapshot,
			externalFileCapabilityId,
		};
	});
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
		getBootstrap: async () => {
			// Bootstrap only needs clipboard metadata. PNG encoding is reserved for
			// the live snapshot requested by an actual paste operation.
			// 剪贴板读取在 Windows 上可能被其他程序长时间占用，而 HostBridge.request 没有超时：
			// 启动握手不能依赖它，超时/失败时用空剪贴板元数据继续启动。
			const { value: clipboard, degraded } = await requestWithFallback<NativeClipboardMetadata>(
				() => host.request<NativeClipboardMetadata>("clipboard.metadataSnapshot"),
				{ text: "", html: "", filePaths: [], hasImage: false, sequence: 0 },
				BOOTSTRAP_CLIPBOARD_TIMEOUT_MS,
			);
			if (degraded) {
				void backend?.appLogger.warn("native", "Bootstrap clipboard snapshot unavailable; continuing without it");
			}
			const externalFileCapabilityId = issueClipboardCapability(clipboard);
			return {
				clipboard: {
					...clipboard,
					externalFileCapabilityId,
				},
				settings: {
					zoomFactor: backend?.settingsStore.get().zoomFactor ?? 1,
					memoryProfileEnabled: process.env.PIDECK_MEMORY_PROFILE === "1",
				},
			};
		},
		onHeartbeat: (payload, state) => {
			lastHeartbeatAt = Date.now();
			const recovery = advanceNativeHeartbeatRecovery(
				heartbeatRecoveryState,
				payload,
				state.eventChannelHealthy,
			);
			heartbeatRecoveryState = recovery.state;
			// 序号停滞不再整页重载：渲染层首要职责是自行重连续传（见 NativeDesktopTransport），
			// 这里只补一次全量状态。真正需要重载的是「心跳本身消失」——页面定时器已停。
			if (recovery.shouldResync) {
				requestLiveResync({
					reason: "stalled-event-cursor",
					lostSinceMs: placeholderServer.getLostSinceMs(payload.lastEventSeq, payload.eventSourceGeneration),
				});
			}
		},
		onMemoryDiagnostics: (payload) => {
			if (!memoryMonitor || typeof payload !== "object" || payload === null) return;
			memoryMonitor.updateRendererDiagnostics(payload as NativeRendererDiagnostics);
		},
		onOversizedEvent: (channel, bytes) => {
			void backend?.appLogger.warn("native", "Dropped oversized renderer event", { channel, bytes });
		},
		onReplayGap: (info) => requestLiveResync({ reason: info.reason, lostSinceMs: info.lostSinceMs }),
		// 背压掐断与大帧只记字节数/通道名，不含载荷，便于定位“流式信息流停住”。
		onEventChannelDiagnostic: (event) => logEventChannelDiagnostic(event),
	});
	rendererServer = placeholderServer;
	host.on<NativeClipboardMetadata>("native.clipboard", (snapshot) => {
		const externalFileCapabilityId = issueClipboardCapability(snapshot);
		placeholderServer.broadcast("native.clipboard", [{
			...snapshot,
			externalFileCapabilityId,
		}]);
	});
	host.on<NativeFileDropPayload>("native.fileDrop", (payload) => {
		const externalFileCapabilityId = externalFileCapabilities.issueDrop(payload.paths) ?? "";
		placeholderServer.broadcast("native.fileDrop", [{
			...payload,
			externalFileCapabilityId,
		}]);
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
			void backend?.appLogger.warn("native", "Renderer reload", { reason: "renderer-load-failed" });
			void host.request("window.reload").catch(() => undefined);
		}, action.delayMs);
	});
	host.on<{ action?: string }>("window.loadErrorAction", (payload) => {
		if (payload?.action === "retry" || payload?.action === "restart") {
			loadFailureCount = 0;
			void host.request("window.reload").catch(() => undefined);
			return;
		}
		if (payload?.action === "exit") {
			// Qt owns application shutdown. Going through its quit handler marks the
			// sidecar exit as intentional before prepareQuit asks us to clean up.
			void host.request("application.quit").catch(() => undefined);
		}
	});
	host.on("window.closed", () => nativeHost?.markWindowDestroyed());
	host.on<boolean>("window.visibleChanged", (visible) => {
		nativeHost?.markWindowVisible(visible);
		if (visible) lastHeartbeatAt = Date.now();
	});
	host.on<unknown>("window.normalBoundsChanged", (payload) => {
		if (!isRecord(payload) || !isFiniteNumber(payload.width) || !isFiniteNumber(payload.height)) return;

		const nextBounds: LastWindowBounds = {
			width: payload.width,
			height: payload.height,
		};
		// x/y were added after the original size-only format. Require both before
		// replacing the position; preserve a previously known pair when an older
		// native host sends only width/height during a mixed-version upgrade.
		if (isFiniteNumber(payload.x) && isFiniteNumber(payload.y)) {
			nextBounds.x = payload.x;
			nextBounds.y = payload.y;
		} else if (isFiniteNumber(pendingBounds?.x) && isFiniteNumber(pendingBounds?.y)) {
			nextBounds.x = pendingBounds.x;
			nextBounds.y = pendingBounds.y;
		}
		pendingBounds = nextBounds;
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
		externalFileCapabilities,
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
		// 心跳完全消失说明页面定时器已经不跑，补状态也收不到，只剩重载可用。
		void backend?.appLogger.warn("native", "Renderer reload", { reason: "renderer-heartbeat-timeout" });
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
