import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A separate process keeps immutable intrinsics and optional-hook emulation out of other tests.
for (const mode of ["native", "immutable", "nohooks", "immutable-nohooks"]) {
	test(`workflow promise observation remains safe with ${mode} intrinsics`, { timeout: 60000 }, () => {
		const result = spawnSync(process.execPath, [
			"--require", fileURLToPath(new URL("./helpers/immutableWorkflowIntrinsics.mjs", import.meta.url)),
			fileURLToPath(new URL("./helpers/workflowPromiseCompatibilityRunner.mjs", import.meta.url)),
		], {
			env: { ...process.env, PIDECK_TEST_PROMISE_MODE: mode },
			encoding: "utf8", timeout: 55000,
		});
		assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""));
		const report = JSON.parse(result.stdout);
		assert.equal(report.passed, 59);
		assert.deepEqual(report.failures, []);
	});
}
