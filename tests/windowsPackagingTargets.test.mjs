import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Windows native packaging stages Qt, Node, renderer and resources without Electron Builder", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(pkg.scripts?.["build:native"], "xmake f -m release -y && xmake -r");
	assert.match(pkg.scripts?.["dist:win"] ?? "", /dist-win-native\.mjs/);
	const xmake = readFileSync("xmake.lua", "utf8");
	assert.match(xmake, /windeployqt/);
	assert.match(xmake, /win-unpacked/);
	assert.match(xmake, /out.*native-node/);
	assert.match(xmake, /node_modules.*node-pty/);
	assert.match(xmake, /resources/);
	const distWin = readFileSync("scripts/dist-win-native.mjs", "utf8");
	assert.match(distWin, /WebView2 Evergreen Runtime/);
});
