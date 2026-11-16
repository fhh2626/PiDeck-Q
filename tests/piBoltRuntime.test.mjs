import "./helpers/piFixtureResolver.mjs";
import assert from "node:assert/strict";
import {  join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { pathToFileURL } from "node:url";
const { detectPiRuntimeKind, piSupportsTrustFlags } = loadTsCommonJs("src/shared/piCompatibility.ts");

// 真实 Pi-Bolt 1.0.2（基于 Pi 1.4.0）在 Windows 上 `--version` 的完整输出。
const BOLT_VERSION = "1.4.0 (Pi-Bolt 1.0.2, win32-x64-jit, JIT on)";

// ── 版本识别 ───────────────────────────────────────────────────────

test("recognises Pi-Bolt by its version banner, not by the underlying Pi semver", () => {
	assert.equal(detectPiRuntimeKind(BOLT_VERSION), "bolt");
	assert.equal(detectPiRuntimeKind("1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)"), "bolt");
});

test("keeps classifying stock Pi and Rust Pi as before", () => {
	assert.equal(detectPiRuntimeKind("1.4.0"), "typescript");
	assert.equal(detectPiRuntimeKind("0.85.1"), "typescript");
	assert.equal(detectPiRuntimeKind("pi 0.2.0 (unknown abc)"), "rust");
	assert.equal(detectPiRuntimeKind("development build"), "unknown");
});

// ── 信任标志版本门槛 ───────────────────────────────────────────────

test("trust flags are supported from Pi 0.79 and across the whole 1.x line", () => {
	assert.equal(piSupportsTrustFlags("0.78.9"), false);
	assert.equal(piSupportsTrustFlags("0.79.0"), true);
	assert.equal(piSupportsTrustFlags("0.85.1"), true);
	// 回归：次版本号 < 79 的 1.x 曾被误判为不支持。
	assert.equal(piSupportsTrustFlags("1.0.0"), true);
	assert.equal(piSupportsTrustFlags("1.4.0"), true);
	assert.equal(piSupportsTrustFlags(BOLT_VERSION), true);
});

test("trust flags stay off for Rust Pi and for unparsable versions", () => {
	assert.equal(piSupportsTrustFlags("pi 0.2.0 (unknown abc)"), false);
	assert.equal(piSupportsTrustFlags(""), false);
	assert.equal(piSupportsTrustFlags("development build"), false);
});

// ── 子代理拉起 Pi 子进程 ───────────────────────────────────────────

const { getPiSpawnCommand } = await import(
	pathToFileURL(join(process.cwd(), "resources/extensions/pideck-q-subagents/src/runs/shared/pi-spawn.ts")).href
);

test("subagents relaunch a PiDeck-marked standalone Pi through its own executable", () => {
	const spawn = getPiSpawnCommand(["--mode", "json"], {
		platform: "win32",
		execPath: "C:\\Pi-Bolt\\pi-bolt.exe",
		env: { PIDECK_PI_STANDALONE: "1" },
	});
	assert.deepEqual(spawn, { command: "C:\\Pi-Bolt\\pi-bolt.exe", args: ["--mode", "json"] });
});

test("an unmarked pi-bolt executable is not guessed to be standalone", () => {
	// 没有标记时按“Node + CLI 脚本”解析；这里让所有解析途径都落空，结果必须是明确报错，
	// 而不是把 pi-bolt.exe 当作可直接复用的独立二进制。
	assert.throws(
		() => getPiSpawnCommand(["--mode", "json"], {
			platform: "win32",
			execPath: "C:\\Pi-Bolt\\pi-bolt.exe",
			env: {},
			existsSync: () => false,
			argv1: "",
			resolvePackageEntry: () => {
				throw new Error("no Pi package in this test");
			},
		}),
		/Could not resolve the Pi CLI on Windows/,
	);
});
test("stock pi.exe is still recognised as standalone without any marker", () => {
	const spawn = getPiSpawnCommand(["-p"], { platform: "win32", execPath: "C:\\Pi\\pi.exe", env: {} });
	assert.deepEqual(spawn, { command: "C:\\Pi\\pi.exe", args: ["-p"] });
});

// ── 三处独立定义的环境变量名必须一致 ───────────────────────────────

test("the standalone marker name is identical in PiDeck and both bundled extensions", async () => {
	const { PIDECK_PI_STANDALONE_ENV: host } = loadTsCommonJs("src/shared/piCompatibility.ts");
	const { PIDECK_PI_STANDALONE_ENV: subagents } = await import(
		pathToFileURL(join(process.cwd(), "resources/extensions/pideck-q-subagents/src/runs/shared/pi-spawn.ts")).href
	);
	const { PIDECK_PI_STANDALONE_ENV: promptRewriter } = await import(
		pathToFileURL(join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt/runtime.ts")).href
	);
	// 扩展随应用独立打包，不能 import src/shared，所以各自保留一份常量；改名时必须三处同步。
	assert.equal(subagents, host);
	assert.equal(promptRewriter, host);
});
