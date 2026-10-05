import {
	createPiDesktopApi,
	type PiDesktopApi,
} from "@shared/desktop/createPiDesktopApi";
import type { NativeClipboardMetadata, NativeFileDropPayload } from "@shared/desktop/NativeHostTypes";
import { NativeDesktopSyncHost } from "./NativeDesktopSyncHost";
import { NativeDesktopTransport, type NativeHeartbeatState } from "./NativeDesktopTransport";
import { createNativeHeartbeatRequest } from "./nativeHeartbeat";
import { createNativeReloadUrl } from "./nativeReloadUrl";
import { applyRendererZoom } from "./rendererZoom";
import { ipcChannels } from "../../../shared/ipc";

const NATIVE_HEARTBEAT_INTERVAL_MS = 3_000;

let nativeRendererToken: string | null = null;

/** Token is retained in memory for protected background requests, never in the URL after bootstrap. */
export function getNativeRendererToken(): string | null {
	return nativeRendererToken;
}

function reloadNativeRenderer(token: string): void {
	window.location.replace(createNativeReloadUrl(window.location.href, token));
}

/**
 * 重新加载页面并保留认证。原生运行时的 token 在 bootstrap 后已从地址栏抹掉，
 * 裸 window.location.reload() 会丢掉它，页面随后因 "token is missing" 永远卡在启动画面。
 * 非原生运行时（LAN Web / 预览）没有 token，直接刷新即可。
 */
export function reloadDesktopRenderer(): void {
	if (nativeRendererToken) {
		reloadNativeRenderer(nativeRendererToken);
		return;
	}
	window.location.reload();
}

/** 事件通道健康度变化时在 window 上派发的事件名（detail: NativeEventChannelHealthDetail）。 */
export const NATIVE_EVENT_CHANNEL_HEALTH_EVENT = "pideck-native-event-channel-health";

export interface NativeEventChannelHealthDetail {
	healthy: boolean;
	failedAttempts: number;
}

/** 启动握手的请求上限：宿主/Sidecar 无响应时要给出可见的失败，而不是无限等待。 */
const NATIVE_BOOTSTRAP_TIMEOUT_MS = 15_000;

interface NativeBootstrapResponse {
	clipboard?: Partial<NativeClipboardMetadata>;
	settings?: { zoomFactor?: number; memoryProfileEnabled?: boolean };
	eventSeq?: number;
	eventSourceGeneration?: string;
}

function isUnknownRecord(value: unknown): value is { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNativeHeartbeatState(value: unknown): NativeHeartbeatState {
	if (!isUnknownRecord(value)) return {};
	const state: NativeHeartbeatState = {};
	if (typeof value.eventSeq === "number" && Number.isInteger(value.eventSeq) && value.eventSeq >= 0) {
		state.eventSeq = value.eventSeq;
	}
	if (typeof value.eventSourceGeneration === "string") state.eventSourceGeneration = value.eventSourceGeneration;
	return state;
}

export interface NativeDesktopRuntime {
	api: PiDesktopApi;
	transport: NativeDesktopTransport;
	syncHost: NativeDesktopSyncHost;
}

/**
 * Fetch native bootstrap state before React mounts. This makes all later renderer
 * code consume the same desktop API regardless of whether Qt or Electron hosts it.
 */
export async function initializeNativeDesktop(): Promise<NativeDesktopRuntime> {
	const query = new URLSearchParams(window.location.search);
	const token = query.get("token");
	if (!token) throw new Error("Native runtime token is missing");
	nativeRendererToken = token;
	// Remove the credential before the first await so failed bootstrap/SSE work
	// cannot leave it in browser history, diagnostics, or copied page URLs.
	const sanitizedUrl = new URL(window.location.href);
	sanitizedUrl.searchParams.delete("token");
	window.history.replaceState(null, "", `${sanitizedUrl.pathname}${sanitizedUrl.search}${sanitizedUrl.hash}`);

	const baseUrl = window.location.origin;
	// Establish the snapshot boundary before opening SSE. The transport then asks
	// the server to replay every event newer than this exact bootstrap sequence.
	const bootstrapUrl = new URL("/__pideck/bootstrap", baseUrl);
	bootstrapUrl.searchParams.set("token", token);
	const bootstrapAbort = new AbortController();
	const bootstrapTimer = window.setTimeout(() => bootstrapAbort.abort(), NATIVE_BOOTSTRAP_TIMEOUT_MS);
	let bootstrap: NativeBootstrapResponse;
	try {
		const response = await fetch(bootstrapUrl, {
			headers: { "x-pideck-token": token },
			signal: bootstrapAbort.signal,
		});
		if (!response.ok) {
			throw new Error(`Native bootstrap failed (${response.status})`);
		}
		bootstrap = (await response.json()) as NativeBootstrapResponse;
	} catch (error) {
		if (bootstrapAbort.signal.aborted) {
			throw new Error(`Native bootstrap timed out after ${NATIVE_BOOTSTRAP_TIMEOUT_MS}ms`);
		}
		throw error;
	} finally {
		window.clearTimeout(bootstrapTimer);
	}
	const transport = new NativeDesktopTransport(baseUrl, token, {
		// 事件流断层（SSE 历史被裁 / 超大帧被丢弃）由 sidecar 补发全量状态自愈，
		// 这里绝不导航：整页重载会丢掉滚动位置与正在输入的内容。
		// 正常断层载荷是对象（{ reason, eventSeq } / { channel, bytes }），只有
		// 形态不对的畸形载荷才走重载兜底。
		onResyncRequired: (payload) => {
			if (isUnknownRecord(payload)) return;
			reloadNativeRenderer(token);
		},
		initialEventSeq: bootstrap.eventSeq ?? 0,
		// 事件通道持续连不上时页面仍可操作，但实时更新已停：这里写日志，入口负责提示用户。
		onEventChannelHealthChange: (healthy, info) => {
			if (healthy) logEventChannel("info", "Native event channel recovered");
			else logEventChannel("warn", "Native event channel unhealthy", { failedAttempts: info.failedAttempts });
			window.dispatchEvent(new CustomEvent<NativeEventChannelHealthDetail>(NATIVE_EVENT_CHANNEL_HEALTH_EVENT, {
				detail: { healthy, failedAttempts: info.failedAttempts },
			}));
		},
	});
	/**
	 * 事件通道日志直接走已可用的 RPC：启动握手完成前 desktopApi 仍是预览实现，
	 * 经它写的日志只进控制台、不进日志文件，而启动期正是事件通道故障最需要留痕的时候。
	 */
	function logEventChannel(level: "info" | "warn", message: string, detail?: unknown): void {
		void transport.invoke(ipcChannels.rendererLog, level, "renderer", message, detail).catch(() => undefined);
	}
	try {
		await transport.ready();
	} catch (error) {
		logEventChannel("warn", "Native event channel not ready during bootstrap; reconnecting", {
			error: error instanceof Error ? error.message : String(error),
		});
		// 事件通道暂未就绪不应让整个工作台卡在启动画面：RPC 已可用，
		// 就绪超时会关闭 EventSource，这里主动重连，之后由心跳与 CLOSED 退避重连兜底；
		// 若持续连不上，transport 会经 onEventChannelHealthChange 上报，入口据此提示用户。
		transport.reconnect();
	}
	const syncHost = new NativeDesktopSyncHost(bootstrap.clipboard);

	transport.subscribe<Partial<NativeClipboardMetadata>>("native.clipboard", (snapshot) => {
		syncHost.update(snapshot);
	});
	transport.subscribe<NativeFileDropPayload>("native.fileDrop", (payload) => {
		// Native OS drops already carry absolute paths in the event payload; do not
		// cache by basename because equal names can come from different directories.
		window.dispatchEvent(new CustomEvent<NativeFileDropPayload>("pideck-native-file-drop", {
			detail: payload,
		}));
	});
	transport.subscribe<{ zoomFactor?: number }>("settings:apply-window", (settings) => {
		if (typeof settings.zoomFactor === "number") applyRendererZoom(settings.zoomFactor);
	});

	const memoryProfileEnabled = bootstrap.settings?.memoryProfileEnabled === true;
	const heartbeatScheduler = {
		setTimeout: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
		clearTimeout: (timer: number) => window.clearTimeout(timer),
	};
	const heartbeatRequest = createNativeHeartbeatRequest(
		async (signal) => {
			const response = await fetch(new URL("/__pideck/heartbeat", baseUrl), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-pideck-token": token,
				},
				body: JSON.stringify({
					lastEventSeq: transport.getLastEventSeq(),
					eventSourceGeneration: transport.getEventSourceGeneration(),
				}),
				signal,
			});
			if (!response.ok) return;
			const state = toNativeHeartbeatState(await response.json());
			transport.handleHeartbeat(state);
		},
		heartbeatScheduler,
		10_000,
	);
	const memoryDiagnosticsRequest = createNativeHeartbeatRequest(
		async (signal) => {
			const memory = (performance as Performance & {
				memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
			}).memory;
			const images = [...document.images];
			const canvases = [...document.querySelectorAll("canvas")];
			await fetch(new URL("/__pideck/diagnostics/memory", baseUrl), {
				method: "POST",
				headers: { "content-type": "application/json", "x-pideck-token": token },
				body: JSON.stringify({
					jsHeapKB: memory?.usedJSHeapSize ? Math.round(memory.usedJSHeapSize / 1024) : undefined,
					totalJSHeapKB: memory?.totalJSHeapSize ? Math.round(memory.totalJSHeapSize / 1024) : undefined,
					domNodes: document.querySelectorAll("*").length,
					imgCount: images.length,
					imgPixels: images.reduce((sum, image) => sum + image.naturalWidth * image.naturalHeight, 0),
					canvasPixels: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
					workerCount: null,
					workerJSHeapKB: null,
				}),
				signal,
			});
		},
		heartbeatScheduler,
		10_000,
	);
	const heartbeatTimer = window.setInterval(() => {
		heartbeatRequest.run();
		if (memoryProfileEnabled) memoryDiagnosticsRequest.run();
	}, NATIVE_HEARTBEAT_INTERVAL_MS);
	window.addEventListener("beforeunload", () => {
		window.clearInterval(heartbeatTimer);
		heartbeatRequest.dispose();
		memoryDiagnosticsRequest.dispose();
	}, { once: true });

	transport.activateAfter(bootstrap.eventSeq ?? transport.getLastEventSeq());
	const api = createPiDesktopApi(transport, syncHost);
	window.piDesktop = api;
	applyRendererZoom(bootstrap.settings?.zoomFactor ?? 1);
	return { api, transport, syncHost };
}
