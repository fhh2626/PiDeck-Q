import { app, Menu } from "electron";
import type { PlatformApplication } from "../PlatformServices";

export class ElectronApplication implements PlatformApplication {
	get name(): string {
		return app.getName();
	}

	get version(): string {
		return app.getVersion();
	}

	get isPackaged(): boolean {
		return app.isPackaged;
	}

	getLocale(): string {
		return app.getLocale();
	}

	getPreferredSystemLanguages(): string[] {
		try {
			return app.getPreferredSystemLanguages();
		} catch {
			return [];
		}
	}

	hideApplicationMenu(): void {
		Menu.setApplicationMenu(null);
	}
}
