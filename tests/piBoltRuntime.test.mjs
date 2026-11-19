import "./helpers/piFixtureResolver.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { pathToFileURL } from "node:url";

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

test("the standalone marker name is identical in PiDeck and its subagent runtime", async () => {
	const { PIDECK_PI_STANDALONE_ENV: host } = loadTsCommonJs("src/shared/piCompatibility.ts");
	const { PIDECK_PI_STANDALONE_ENV: subagents } = await import(
		pathToFileURL(join(process.cwd(), "resources/extensions/pideck-q-subagents/src/runs/shared/pi-spawn.ts")).href
	);
	assert.equal(subagents, host);
});
