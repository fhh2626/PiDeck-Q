import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("native dev script builds renderer, sidecar and launches Xmake", () => {
	const source = readFileSync("scripts/dev-native.mjs", "utf8");
	assert.match(source, /build:renderer/);
	assert.match(source, /build:node/);
	assert.match(source, /xmake/);
	assert.doesNotMatch(source, /electron-vite|electron\.exe/);
});

test("native distribution script points at Xmake staging and WebView2 runtime", () => {
	const source = readFileSync("scripts/dist-win-native.mjs", "utf8");
	assert.match(source, /npm.*build/);
	assert.match(source, /WebView2 Evergreen Runtime/);
});
