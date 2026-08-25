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

test("native distribution script builds staging without invoking an installer compiler", () => {
	const source = readFileSync("scripts/dist-win-native.mjs", "utf8");
	assert.match(source, /npm.*build/);
	assert.match(source, /build:native/);
	assert.match(source, /verify:build-artifacts/);
	assert.doesNotMatch(source, /makensis|prepare-nsis|installer\/PiDeck-Q/);
});
