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

test("context controller is a default-on built-in shown as PiDeck-Q-context-controller", () => {
	const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	assert.match(builtIns, /"pideck-q-context-controller\.ts"/);
	assert.doesNotMatch(builtIns, /DEFAULT_DISABLED_BUILT_IN_EXTENSIONS = \[[^\]]*pideck-q-context-controller/);
	assert.match(tab, /PiDeck-Q-context-controller/);
	assert.match(tab, /"pideck-q-context-controller\.ts": "PiDeck-Q-context-controller"/);
});

test("web search is a default-off built-in shown as PiDeck-Q-WebSearch", () => {
	const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	assert.match(builtIns, /DEFAULT_DISABLED_BUILT_IN_EXTENSIONS = \[[\s\S]*?"pideck-q-websearch\.ts"/);
	assert.match(tab, /"pideck-q-websearch\.ts": "PiDeck-Q-WebSearch"/);
	assert.match(tab, /"pideck-q-websearch": "PiDeck-Q-WebSearch"/);
});

test("better compaction is shown as PiDeck-Q-Better-Compaction", () => {
	const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	assert.match(tab, /"pideck-q-better-compaction\.ts": "PiDeck-Q-Better-Compaction"/);
});

test("change-pi-prompt is a default-off built-in shown as PiDeck-Q-Change-Pi-Prompt", () => {
	const tab = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
	const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	assert.match(builtIns, /DEFAULT_DISABLED_BUILT_IN_EXTENSIONS = \[[\s\S]*?"pideck-q-change-pi-prompt\.ts"/);
	assert.match(tab, /"pideck-q-change-pi-prompt\.ts": "PiDeck-Q-Change-Pi-Prompt"/);
	assert.match(tab, /"pideck-q-change-pi-prompt": "PiDeck-Q-Change-Pi-Prompt"/);
});
