import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("native dev script builds renderer, sidecar and launches Xmake", () => {
	// 文本匹配在此是正确工具：dev 脚本会拉起 npm/xmake 与 GUI，无法在单测里真实执行；
	// 这里守的是脚本的构建步骤清单与「不得回到 Electron 工具链」的配置内容契约。
	const source = readFileSync("scripts/dev-native.mjs", "utf8");
	assert.match(source, /build:renderer/);
	assert.match(source, /build:node/);
	assert.match(source, /xmake/);
	assert.doesNotMatch(source, /electron-vite|electron\.exe/);
});

test("native distribution script builds staging without invoking an installer compiler", () => {
	// 文本匹配在此是正确工具：发布脚本会真实构建/打包，不可在单测执行；守的是打包流程配置内容，
	// 以及「不得重新引入 NSIS 安装器编译」的移除契约。
	const source = readFileSync("scripts/dist-win-native.mjs", "utf8");
	assert.match(source, /npm.*build/);
	assert.match(source, /build:native/);
	assert.match(source, /verify:build-artifacts/);
	assert.doesNotMatch(source, /makensis|prepare-nsis|installer\/PiDeck-Q/);
});
