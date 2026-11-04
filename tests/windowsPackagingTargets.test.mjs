import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Windows native packaging stages Qt, Node, renderer and resources without Electron Builder", () => {
	// 文本匹配在此是正确工具：xmake.lua / 打包脚本 / package.json 都是构建配置文件，没有可在单测中执行的运行时入口（需要 Qt 工具链）；
	// 这里守的是配置内容契约（暂存 Qt、Node、渲染层与资源，且不回到 Electron Builder / NSIS）。
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.match(pkg.scripts?.["build:native"] ?? "", /build-native\.mjs/);
	assert.match(pkg.scripts?.["dist:win"] ?? "", /dist-win-native\.mjs/);
	const xmake = readFileSync("xmake.lua", "utf8");
	assert.match(xmake, /windeployqt/);
	assert.match(xmake, /win-unpacked/);
	assert.match(xmake, /out.*native-node/);
	assert.match(xmake, /stage-native-runtime\.mjs/);
	const runtimeStager = readFileSync("scripts/stage-native-runtime.mjs", "utf8");
	assert.match(runtimeStager, /node_modules.*node-pty/);
	assert.match(runtimeStager, /resources.*extensions.*node_modules.*undici/s);
	assert.match(xmake, /resources/);
	const distWin = readFileSync("scripts/dist-win-native.mjs", "utf8");
	assert.match(distWin, /build:native/);
	assert.match(distWin, /verify:build-artifacts/);
	assert.doesNotMatch(distWin, /makensis|prepare-nsis|installer\/PiDeck-Q/);
});
