import { shell } from "electron";
import type { PlatformOpenPathResult, PlatformShell } from "../PlatformServices";

export class ElectronShell implements PlatformShell {
	async openExternal(url: string): Promise<void> {
		await shell.openExternal(url);
	}

	async openPath(path: string): Promise<PlatformOpenPathResult> {
		const error = await shell.openPath(path);
		if (error) {
			return { ok: false, error };
		}
		return { ok: true };
	}

	showItemInFolder(path: string): void {
		shell.showItemInFolder(path);
	}

	async trashItem(path: string): Promise<void> {
		await shell.trashItem(path);
	}
}
