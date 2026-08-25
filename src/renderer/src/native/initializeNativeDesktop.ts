import {
	createPiDesktopApi,
	type PiDesktopApi,
} from "@shared/desktop/createPiDesktopApi";
import type { NativeClipboardSnapshot, NativeFileDropPayload } from "@shared/desktop/NativeHostTypes";
import { NativeDesktopSyncHost } from "./NativeDesktopSyncHost";
import { NativeDesktopTransport } from "./NativeDesktopTransport";
import { applyRendererZoom } from "./rendererZoom";

const NATIVE_HEARTBEAT_INTERVAL_MS = 3_000;

interface NativeBootstrapResponse {
	clipboard?: Partial<NativeClipboardSnapshot>;
	settings?: { zoomFactor?: number };
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

	const baseUrl = window.location.origin;
	const bootstrapUrl = new URL("/__pideck/bootstrap", baseUrl);
	bootstrapUrl.searchParams.set("token", token);
	const response = await fetch(bootstrapUrl, {
		headers: { "x-pideck-token": token },
	});
	if (!response.ok) {
		throw new Error(`Native bootstrap failed (${response.status})`);
	}
	const bootstrap = (await response.json()) as NativeBootstrapResponse;
	const syncHost = new NativeDesktopSyncHost(bootstrap.clipboard);
	const transport = new NativeDesktopTransport(baseUrl, token);

	transport.subscribe<Partial<NativeClipboardSnapshot>>("native.clipboard", (snapshot) => {
		syncHost.update(snapshot);
	});
	transport.subscribe<NativeFileDropPayload>("native.fileDrop", (payload) => {
		syncHost.rememberFilePaths(payload.paths);
		window.dispatchEvent(new CustomEvent<NativeFileDropPayload>("pideck-native-file-drop", {
			detail: payload,
		}));
	});
	transport.subscribe<{ zoomFactor?: number }>("settings:apply-window", (settings) => {
		if (typeof settings.zoomFactor === "number") applyRendererZoom(settings.zoomFactor);
	});

	const heartbeatTimer = window.setInterval(() => {
		void fetch(new URL("/__pideck/heartbeat", baseUrl), {
			method: "POST",
			headers: { "x-pideck-token": token },
		}).catch(() => undefined);
		if (query.get("memoryProfile") === "1") {
			const memory = (performance as Performance & {
				memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
			}).memory;
			const images = [...document.images];
			const canvases = [...document.querySelectorAll("canvas")];
			void fetch(new URL("/__pideck/diagnostics/memory", baseUrl), {
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
			}).catch(() => undefined);
		}
	}, NATIVE_HEARTBEAT_INTERVAL_MS);
	window.addEventListener("beforeunload", () => window.clearInterval(heartbeatTimer), { once: true });

	const api = createPiDesktopApi(transport, syncHost);
	window.piDesktop = api;
	applyRendererZoom(bootstrap.settings?.zoomFactor ?? 1);
	return { api, transport, syncHost };
}
