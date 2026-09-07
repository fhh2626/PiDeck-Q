import type { PiDesktopApi } from "@shared/desktop/createPiDesktopApi";
import { t } from "./i18n";
import { createBrowserApi } from "./browserApi";
import { createPreviewApi } from "./previewApi";
import { initializeNativeDesktop } from "./native/initializeNativeDesktop";

export const isNativeRuntime =
	new URLSearchParams(window.location.search).get("runtime") === "native";
export const isLanWeb =
	!window.piDesktop && !isNativeRuntime && window.location.protocol.startsWith("http");
export const isElectronRuntime = navigator.userAgent.includes("Electron/");
export const missingElectronPreload = isElectronRuntime && !window.piDesktop;

function createUnavailableDesktopApi(): PiDesktopApi {
	const fail = () => {
		throw new Error(t("app.preloadMissing"));
	};
	return new Proxy(
		{},
		{
			get: fail,
			set: fail,
		},
	) as PiDesktopApi;
}

/** Set by native bootstrap before React mounts; existing imports keep a live binding. */
export let desktopApi: PiDesktopApi =
	window.piDesktop ??
	(missingElectronPreload
		? createUnavailableDesktopApi()
		: isNativeRuntime
			? createPreviewApi()
			: isLanWeb
				? createBrowserApi()
				: createPreviewApi());

/** Initialize runtime-specific transport before any React component is mounted. */
export async function initializeDesktopRuntime(): Promise<void> {
	if (!isNativeRuntime) return;
	const runtime = await initializeNativeDesktop();
	desktopApi = runtime.api;
}
