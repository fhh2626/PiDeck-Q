import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/native-node/platform/NativeTheme.ts", "utf8");
const host = readFileSync("native/src/main.cpp", "utf8");
const nativeTheme = readFileSync("native/src/NativeTheme.cpp", "utf8");

test("native theme adapter forwards system/light/dark changes to Qt", () => {
	assert.match(source, /theme\.setSource/);
	assert.match(source, /host\.request/);
	assert.match(host, /theme\.setSource/);
	assert.match(host, /applyNativeThemeSource/);
	assert.match(nativeTheme, /QStyleHints/);
	assert.match(nativeTheme, /Qt::ColorScheme::Dark/);
});

test("native titlebar settings are forwarded through the host contract", () => {
	const controls = readFileSync("src/native-node/host/NativeMainWindowControls.ts", "utf8");
	assert.match(controls, /window\.applySettings/);
	assert.match(controls, /settingsApplyWindow/);
});
