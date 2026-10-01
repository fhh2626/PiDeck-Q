import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import * as os from "node:os";

/**
 * 用 stub 的 os.homedir 把 ExtensionManager 指向 fixture 主目录，
 * 并让原子写抛错，验证「写设置失败时原文件不变」。
 */
function loadManager(home, atomicWrite) {
	return loadTsCommonJs("src/main/extensions/ExtensionManager.ts", {
		stubs: {
			"node:os": { ...os, homedir: () => home },
			"../logging/sharedLogger": { getAppLogger: () => null },
			"../utils/atomicWriteFile": { writeFileAtomic: atomicWrite },
		},
	});
}

const locator = {
	check: async () => ({ installed: true, version: "0.80.0" }),
	createInvocation: (cmd, args) => ({ command: cmd, args, shell: false }),
	createProcessEnv: () => process.env,
	resolveCommand: () => "pi",
};

test("ExtensionManager writes settings through the atomic writer", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-ext-atomic-"));
	try {
		const settingsDir = join(home, ".pi", "agent");
		mkdirSync(settingsDir, { recursive: true });
		const settingsPath = join(settingsDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ disabledExtensions: [] }, null, 2), "utf8");

		const calls = [];
		const { ExtensionManager } = await loadManager(home, async (path, content) => {
			calls.push(path);
			writeFileSync(path, content, "utf8");
		});
		const manager = new ExtensionManager(locator, () => ({}), () => ({ removedBuiltInExtensions: [] }));
		await manager.setEnabled("npm:pi-subagents", false);

		assert.deepEqual(calls, [settingsPath], "设置必须走原子写而不是直接 writeFile");
		const written = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(written.disabledExtensions, ["npm:pi-subagents"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a failed atomic settings write leaves the previous settings.json intact", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-ext-atomic-fail-"));
	try {
		const settingsDir = join(home, ".pi", "agent");
		mkdirSync(settingsDir, { recursive: true });
		const settingsPath = join(settingsDir, "settings.json");
		const original = JSON.stringify({ disabledExtensions: ["keep-me"], theme: "dark" }, null, 2);
		writeFileSync(settingsPath, original, "utf8");

		const { ExtensionManager } = await loadManager(home, async () => {
			throw new Error("simulated crash");
		});
		const manager = new ExtensionManager(locator, () => ({}), () => ({ removedBuiltInExtensions: [] }));

		await assert.rejects(() => manager.setEnabled("npm:pi-subagents", false), /simulated crash/);
		// 直接 writeFile 会先截断：崩溃后用户的 pi 设置就没了
		assert.equal(readFileSync(settingsPath, "utf8"), original);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
