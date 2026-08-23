import { app, nativeTheme, net, type BrowserWindow } from "electron";
import type {
	PlatformPaths,
	PlatformServices,
	PlatformTheme,
} from "../PlatformServices";
import { ElectronApplication } from "./ElectronApplication";
import { ElectronDialogs } from "./ElectronDialogs";
import { ElectronShell } from "./ElectronShell";
import { ElectronNotifications } from "./ElectronNotifications";
import { ElectronProxy } from "./ElectronProxy";
import { ElectronDownloads } from "./ElectronDownloads";

class ElectronTheme implements PlatformTheme {
	setSource(source: "system" | "light" | "dark"): void {
		nativeTheme.themeSource = source;
	}
}

export function createElectronPlatformServices(options?: {
	getMainWindow?: () => BrowserWindow | null;
}): PlatformServices {
	const getWin = options?.getMainWindow ?? (() => null);
	const paths: PlatformPaths = {
		home: app.getPath("home"),
		userData: app.getPath("userData"),
		appPath: app.getAppPath(),
		resourcesPath: process.resourcesPath,
		downloads: app.getPath("downloads"),
	};

	return {
		paths,
		application: new ElectronApplication(),
		dialogs: new ElectronDialogs(getWin),
		shell: new ElectronShell(),
		notifications: new ElectronNotifications(),
		theme: new ElectronTheme(),
		proxy: new ElectronProxy(),
		downloads: new ElectronDownloads(),
		fetch: (input, init) =>
			net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init as RequestInit & { bypassCustomProtocolHandlers?: boolean }),
	};
}
