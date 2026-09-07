import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const project = readFileSync("xmake.lua", "utf8");
const recipe = readFileSync("xmake-repo/packages/p/pideck-qt/xmake.lua", "utf8");

test("Qt 6.11 package bypasses stale aqt metadata and pins WebView archives", () => {
	assert.doesNotMatch(project, /add_requires\(["']aqt\b/);
	assert.match(recipe, /qt6_6112\/qt6_6112_msvc2022_64/);
	assert.match(recipe, /qt\.qt6\.6112\.addons\.qtwebview\.win64_msvc2022_64/);
	assert.match(recipe, /\.sha1/);
	assert.match(recipe, /hash\.sha1/);
	assert.match(recipe, /windeployqt\.exe/);
	assert.match(recipe, /include.*QtWebView.*qwebview\.h/);
	assert.match(recipe, /Qt6WebView\.lib/);
});
