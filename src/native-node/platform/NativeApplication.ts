import type { PlatformApplication } from "../../main/platform/PlatformServices";
import type { HostBridge } from "../host/HostBridge";

function readPreferredLanguages(): string[] {
	const raw = process.env.PIDECK_PREFERRED_LANGUAGES_JSON;
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const languages: string[] = [];
		for (const value of parsed) {
			if (typeof value !== "string") continue;
			const language = value.trim();
			if (language && !languages.includes(language)) languages.push(language);
		}
		return languages;
	} catch {
		return [];
	}
}

/** Application metadata supplied by the Qt launcher through environment variables. */
export class NativeApplication implements PlatformApplication {
	readonly name = process.env.PIDECK_NAME?.trim() || "PiDeck-Q";
	// The Qt launcher always supplies the package-manifest version. Keep a
	// non-release fallback only for an unconfigured developer invocation.
	readonly version = process.env.PIDECK_VERSION?.trim() || "0.0.0-dev";
	readonly isPackaged = process.env.PIDECK_PACKAGED === "1";

	constructor(private readonly host: HostBridge) {}

	getLocale(): string {
		return process.env.PIDECK_LOCALE?.trim() || Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
	}

	getPreferredSystemLanguages(): string[] {
		const preferred = readPreferredLanguages();
		return preferred.length > 0 ? preferred : [this.getLocale()];
	}

	hideApplicationMenu(): void {
		void this.host.request("application.hideMenu").catch(() => undefined);
	}
}
