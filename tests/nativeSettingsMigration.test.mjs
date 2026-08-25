import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("legacy Electron sandbox setting is ignored and removed without resetting settings", () => {
	const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
	const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	assert.doesNotMatch(settingsType, /electronChromiumSandbox\s*:/);
	assert.match(store, /hadLegacyElectronChromiumSandbox/);
	assert.match(store, /electronChromiumSandbox:\s*_ignoredElectronChromiumSandbox/);
	assert.match(store, /hadLegacyElectronChromiumSandbox\s*\|\|/);
});
