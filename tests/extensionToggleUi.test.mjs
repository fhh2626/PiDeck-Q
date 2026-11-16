import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("extension menu exposes enable and disable actions beside uninstall", () => {
	const source = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");

	assert.match(source, /toggle: \(source: string, enabled: boolean\)/);
	assert.match(source, /getExtensionsApi\(\)\.toggle\(extension\.source, enabled\)/);
	assert.match(source, /extension\.enabled === false/);
	assert.match(source, /CircleOff/);
	assert.match(source, /CircleCheck/);
});

test("extension menu uses lightweight refresh on entry and after toggles", () => {
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");

	assert.match(modal, /section === "extensions"[\s\S]*?refreshExtensions\(false\)/);
	assert.match(modal, /onReload=\{\(\) => void refreshExtensions\(false\)\}/);
	assert.match(modal, /onRefresh=\{\(\) => void refreshExtensions\(true\)\}/);
	assert.match(tab, /getExtensionsApi\(\)\.toggle\(extension\.source, enabled\)[\s\S]*?props\.onReload\(\)/);
});

test("better compaction is shown as PiDeck-Q-Better-Compaction", () => {
	const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	assert.match(tab, /"pideck-q-better-compaction\.ts": "PiDeck-Q-Better-Compaction"/);
});
