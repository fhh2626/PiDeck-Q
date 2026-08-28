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

const NATIVE_HEARTBEAT_INTERVAL_MS = 3_000;

let nativeRendererToken: string | null = null;

/** Token is retained in memory for protected background requests, never in the URL after bootstrap. */
export function getNativeRendererToken(): string | null {
	return nativeRendererToken;
}

function reloadNativeRenderer(token: string): void {
	window.location.replace(createNativeReloadUrl(window.location.href, token));
}

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
	const response = await fetch(bootstrapUrl, {
		headers: { "x-pideck-token": token },
	});
	if (!response.ok) {
		throw new Error(`Native bootstrap failed (${response.status})`);
	}
	const bootstrap = (await response.json()) as NativeBootstrapResponse;
	const transport = new NativeDesktopTransport(baseUrl, token, {
		onResyncRequired: () => reloadNativeRenderer(token),
		initialEventSeq: bootstrap.eventSeq ?? 0,
	});
	try {
		await transport.ready();
	} catch (error) {
		transport.dispose();
		throw error;
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
