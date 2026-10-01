import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

// 本 fork 的发布线是 0.1.x → 0.4.0（tag 无 v 前缀，见 native 分支的
// "chore: release v0.4.0"）。package.json 就是版本的唯一来源：
// scripts/build-native.mjs、dist-win-native.mjs 都读它，再经 PIDECK_VERSION
// 环境变量传给 xmake / 原生宿主。因此这里锁的是「三处一致 + 单一来源」，
// 不是某个具体数字——升级版本时本文件不需要改。
test("the release version has exactly one source of truth, and every copy agrees", () => {
	assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/, "package.json version 必须是合法 semver");
	// package-lock 的两处根版本号都必须跟随，否则 npm ci 与打包版本会打架
	assert.equal(lock.version, pkg.version, "package-lock.json 顶层 version 必须与 package.json 一致");
	assert.equal(lock.packages[""].version, pkg.version, "package-lock.json 根包 version 必须与 package.json 一致");
});

test("build scripts read the version from package.json instead of hardcoding it", () => {
	const expectations = [
		["scripts/build-native.mjs", /npmPackage\.version/, /PIDECK_VERSION: version/],
		["scripts/dist-win-native.mjs", /packageManifest\.version/, /PIDECK_VERSION: buildVersion/],
		["scripts/dev-native.mjs", /packageVersion/, /PIDECK_VERSION/],
		["scripts/test-native-host-rpc.mjs", /packageJson\.version/, /PIDECK_VERSION/],
	];
	for (const [file, readsManifest, exportsEnv] of expectations) {
		const source = readFileSync(file, "utf8");
		assert.match(source, readsManifest, `${file} 必须从 package.json 读取版本`);
		assert.match(source, exportsEnv, `${file} 必须把版本经 PIDECK_VERSION 传出`);
		// 硬编码 0.4.0 / 0.7.0 之类的字面量会让版本升级漏改，必须拒绝
		assert.doesNotMatch(source, /["']\d+\.\d+\.\d+["']/, `${file} 不得硬编码版本字面量`);
	}
});

test("the native host takes its version from the build define, not a checked-in copy", () => {
	const xmake = readFileSync("xmake.lua", "utf8");
	// xmake 的沙箱没有文件读取能力，所以版本唯一来源是构建脚本传进来的环境变量
	assert.match(xmake, /os\.getenv\("PIDECK_VERSION"\)/);
	assert.match(xmake, /PIDECK_BUILD_VERSION=/);
	assert.doesNotMatch(xmake, /set_version\("\d+\.\d+\.\d+"\)/, "xmake.lua 不得写死版本号");

	const mainCpp = readFileSync("native/src/main.cpp", "utf8");
	assert.match(mainCpp, /PIDECK_BUILD_VERSION/, "原生宿主必须用编译期 define 兜底");
	// 应用版本优先取运行时注入的 PIDECK_VERSION，define 只作直接运行 release 二进制时的兜底
	assert.match(mainCpp, /qEnvironmentVariable\("PIDECK_VERSION", nativeBuildVersion\)/);
});
