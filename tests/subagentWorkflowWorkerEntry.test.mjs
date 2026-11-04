import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWorkflowScript } from "../resources/extensions/pideck-q-subagents/src/workflows/scripted-workflow.ts";

// The worker script exceeds the size Bun 1.3.14 (Pi 0.85.1) tolerates for eval workers, so it is
// loaded from a private temp file. These tests pin that contract without depending on Bun.
const PREFIX = "pideck-workflow-";

function options(script, overrides = {}) {
	return {
		script, timeoutMs: 5000,
		launch: async (key) => ({ key, ok: true, output: key, artifactPaths: [] }),
		status: async (key) => ({ key, ok: true, output: key, artifactPaths: [] }),
		state: { get: () => 0, set: () => {} },
		...overrides,
	};
}

/** Point os.tmpdir() at an isolated root for the duration of one test. */
async function withTempRoot(action) {
	const root = mkdtempSync(join(tmpdir(), "pideck-worker-entry-test-"));
	const saved = Object.fromEntries(["TMPDIR", "TEMP", "TMP"].map((name) => [name, process.env[name]]));
	for (const name of Object.keys(saved)) process.env[name] = root;
	try { return await action(root); }
	finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

const workerDirs = (root) => readdirSync(root).filter((name) => name.startsWith(PREFIX));

async function eventually(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}

test("workflow worker is loaded from a private file that is removed after the worker exits", async () => {
	await withTempRoot(async (root) => {
		let during = [];
		const result = await runWorkflowScript(options('return (await runs.run("child", {agent:"readonly"})).output;', {
			launch: async (key) => {
				during = workerDirs(root);
				return { key, ok: true, output: key, artifactPaths: [] };
			},
		}));
		assert.equal(result.value, "child");
		assert.equal(during.length, 1, "the worker script must live in a temp directory while running");
		assert.equal(await eventually(() => workerDirs(root).length === 0), true, "temp directory must be removed after exit");
	});
});

test("workflow worker temp directory is removed after a failed workflow", async () => {
	await withTempRoot(async (root) => {
		await assert.rejects(runWorkflowScript(options('throw new Error("expected failure");')), /expected failure/);
		assert.equal(await eventually(() => workerDirs(root).length === 0), true);
	});
});

test("workflow still runs through the eval fallback when the temp directory is unusable", async () => {
	await withTempRoot(async (root) => {
		const missing = join(root, "does-not-exist");
		for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = missing;
		const result = await runWorkflowScript(options("return 42;"));
		assert.equal(result.value, 42);
		assert.equal(readdirSync(root).length, 0, "the fallback must not create any directory");
	});
});
