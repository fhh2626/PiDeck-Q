import { join } from "node:path";
import { homedir } from "node:os";
import type { PlatformPaths, PlatformServices } from "../../main/platform/PlatformServices";
import { NativeApplication } from "./NativeApplication";
import { NativeDialogs } from "./NativeDialogs";
import { NativeNotifications } from "./NativeNotifications";
import { NativeShell } from "./NativeShell";
import { NativeTheme } from "./NativeTheme";
import { NodeDownloads } from "./NodeDownloads";
import { NodeProxy } from "./NodeProxy";
import type { HostBridge } from "../host/HostBridge";

/** Resolve the native download directory without allowing an empty environment value. */
export function resolveNativeDownloadsPath(userData: string, configuredPath?: string): string {
	return configuredPath?.trim() || join(userData, "Downloads");
}

/** Assemble the Electron-free PlatformServices implementation for createBackend. */
export function createNativePlatformServices(host: HostBridge): PlatformServices {
	const userData = process.env.PIDECK_USER_DATA;
	const appPath = process.env.PIDECK_APP_PATH;
	const resourcesPath = process.env.PIDECK_RESOURCES_PATH;
	if (!userData || !appPath || !resourcesPath) {
		throw new Error("Native platform paths are missing from the environment");
	}
	const proxy = new NodeProxy();
	const paths: PlatformPaths = {
		home: process.env.PIDECK_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir(),
		userData,
		appPath,
		resourcesPath,
		downloads: resolveNativeDownloadsPath(userData, process.env.PIDECK_DOWNLOADS_PATH),
	};
	return {
		paths,
		application: new NativeApplication(host),
		dialogs: new NativeDialogs(host),
		shell: new NativeShell(host),
		notifications: new NativeNotifications(host),
		theme: new NativeTheme(host),
		proxy,
		downloads: new NodeDownloads(proxy),
		fetch: proxy.fetch,
	};
}
