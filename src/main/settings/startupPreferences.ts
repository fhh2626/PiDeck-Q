import { readFileSync } from "node:fs";
import type { AppSettings } from "../../shared/types";

function readDesktopSettingsSync(desktopSettingsFile: string): Partial<AppSettings> {
	try {
		const raw = readFileSync(desktopSettingsFile, "utf8");
		return JSON.parse(raw) as Partial<AppSettings>;
	} catch {
		return {};
	}
}

/**
 * Read the version-scoped single-instance preference before the host is ready.
 * Native and Electron callers both inject the settings path into this pure helper.
 */
export function readSingleInstancePreference(desktopSettingsFile: string): boolean {
	const value = readDesktopSettingsSync(desktopSettingsFile).singleInstance;
	return value !== false;
}
