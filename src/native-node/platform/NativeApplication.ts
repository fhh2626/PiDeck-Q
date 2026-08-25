import type { PlatformApplication } from "../../main/platform/PlatformServices";
import type { HostBridge } from "../host/HostBridge";

/** Application metadata supplied by the Qt launcher through environment variables. */
export class NativeApplication implements PlatformApplication {
	readonly name = process.env.PIDECK_NAME?.trim() || "PiDeck-Q";
	readonly version = process.env.PIDECK_VERSION?.trim() || "0.1.5";
	readonly isPackaged = process.env.PIDECK_PACKAGED === "1";

	constructor(private readonly host: HostBridge) {}

	getLocale(): string {
		return process.env.PIDECK_LOCALE?.trim() || Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
	}

	getPreferredSystemLanguages(): string[] {
		return [this.getLocale()];
	}

	hideApplicationMenu(): void {
		void this.host.request("application.hideMenu").catch(() => undefined);
	}
}
