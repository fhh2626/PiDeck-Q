import { dialog, type BrowserWindow } from "electron";
import type {
	PlatformDialogs,
	PlatformOpenDialogOptions,
	PlatformOpenDialogResult,
	PlatformSaveDialogOptions,
	PlatformSaveDialogResult,
} from "../PlatformServices";

export class ElectronDialogs implements PlatformDialogs {
	constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

	async showOpenDialog(
		options: PlatformOpenDialogOptions,
	): Promise<PlatformOpenDialogResult> {
		const electronOptions: Electron.OpenDialogOptions = {
			title: options.title,
			defaultPath: options.defaultPath,
			filters: options.filters,
			properties: options.properties,
		};

		if (options.parent === "main-window") {
			const win = this.getMainWindow();
			if (win && !win.isDestroyed()) {
				const result = await dialog.showOpenDialog(win, electronOptions);
				return {
					canceled: result.canceled,
					filePaths: result.filePaths,
				};
			}
		}

		const result = await dialog.showOpenDialog(electronOptions);
		return {
			canceled: result.canceled,
			filePaths: result.filePaths,
		};
	}

	async showSaveDialog(
		options: PlatformSaveDialogOptions,
	): Promise<PlatformSaveDialogResult> {
		const electronOptions: Electron.SaveDialogOptions = {
			title: options.title,
			defaultPath: options.defaultPath,
			filters: options.filters,
		};

		if (options.parent === "main-window") {
			const win = this.getMainWindow();
			if (win && !win.isDestroyed()) {
				const result = await dialog.showSaveDialog(win, electronOptions);
				return {
					canceled: result.canceled,
					filePath: result.filePath,
				};
			}
		}

		const result = await dialog.showSaveDialog(electronOptions);
		return {
			canceled: result.canceled,
			filePath: result.filePath,
		};
	}
}
