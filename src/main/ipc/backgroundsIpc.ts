import { ipcChannels } from "../../shared/ipc";
import type { PlatformDialogs } from "../platform/PlatformServices";
import type { BackgroundImageService } from "../backgrounds/BackgroundImageService";
import type { RpcRouter } from "../transport/RpcRouter";

export type BackgroundsIpcDeps = {
	dialogs: PlatformDialogs;
	backgroundImageService: BackgroundImageService;
};

export function registerBackgroundsIpc(
	router: RpcRouter,
	deps: BackgroundsIpcDeps,
): void {
	router.handle(ipcChannels.pickBackgroundImage, async () => {
		const result = await deps.dialogs.showOpenDialog({
			title: "选择背景图",
			filters: [
				{
					name: "图片",
					extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"],
				},
			],
			properties: ["openFile"],
			parent: "main-window",
		});
		const picked = result.filePaths[0];
		if (!picked) return "";
		return deps.backgroundImageService.importImage(picked);
	});

	router.handle(ipcChannels.removeBackgroundImage, async (name: string) => {
		await deps.backgroundImageService.remove(name);
	});
}
