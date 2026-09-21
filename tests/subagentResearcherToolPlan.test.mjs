import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Providers resolve homedir()/cwd themselves, so isolate the process before any Pi import.
test("Researcher tool plan and diagnostic delivery in an isolated offline process", { timeout: 90_000 }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-researcher-process-"));
	try {
		const home = join(root, "home");
		const cwd = join(root, "workspace");
		const temp = join(root, "tmp");
		for (const dir of [home, cwd, temp]) mkdirSync(dir);
		// Allow only OS launch necessities; do not inherit Pi routes, credentials, NODE_OPTIONS or proxies.
		const env = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|SYSTEMDRIVE)$/i.test(key)) env[key] = value;
		}
		Object.assign(env, {
			HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
			LOCALAPPDATA: join(home, "AppData", "Local"), TMP: temp, TEMP: temp, TMPDIR: temp,
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_OFFLINE: "1",
			RESEARCHER_TEST_HOME: home,
		});
		const result = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("./helpers/researcherToolPlanCases.mjs", import.meta.url))], {
			cwd, env, encoding: "utf8", timeout: 75_000, maxBuffer: 4 * 1024 * 1024,
		});
		assert.ifError(result.error);
		assert.equal(result.signal, null, `child terminated: ${result.signal}`);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /# fail 0|ℹ fail 0/);
		t.diagnostic("Isolated child: 8 cases passed, including actual-source getAllTools mutation sensitivity; no live model startup.");
		assert.match(result.stdout, /(?:#|ℹ) pass 8\b/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
