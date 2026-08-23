import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AppLogger } from "../logging/AppLogger";

export type ElectronPreloadLifecycleIpcDeps = {
	appLogger: Pick<AppLogger, "info" | "error">;
};

export function registerElectronPreloadLifecycleIpc(
	ipc: IpcMain,
	{ appLogger }: ElectronPreloadLifecycleIpcDeps,
): void {
	ipc.on(ipcChannels.preloadReady, (event) => {
		void appLogger.info("app", "Preload API exposed", { url: event.sender.getURL() });
	});
	ipc.on(ipcChannels.preloadError, (event, detail) => {
		void appLogger.error("app", "Preload API expose failed", { url: event.sender.getURL(), detail });
	});
}
