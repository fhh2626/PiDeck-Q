/**
 * Package-gate freshness for the two native binaries of the C++ package.
 *
 * The earlier gate only compared the TypeScript bundles against their sources, so an old
 * stage satisfied the packaged gate as long as `PiDeckBackend.exe` / `PiDeck-Q.exe`
 * existed: a backend linked before `native/backend/**` changed (or a host older than
 * `native/src/**`, the target definition or the embedded package version) was accepted.
 * These cases drive the real verifier over a synthetic repo + stage in a temp directory,
 * so the rule is pinned without touching the build tree's timestamps.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";

import { verifyBuildArtifacts } from "../scripts/verify-build-artifacts.mjs";

const REPO_ROOT = process.cwd();
const REAL_STAGE = join(REPO_ROOT, "build", "native2-validation-unpacked");
const VERIFIER = join(REPO_ROOT, "scripts", "verify-build-artifacts.mjs");
const REQUIRED = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";

// Keep the packaged fixture minimal but structurally complete: the verifier requires the
// renderer entries, the extension dependency tree and the shipped extension runtime files.
const CHANGE_PROMPT_FILES = [
	"extensions/pideck-q-change-pi-prompt.ts",
	"extensions/pideck-q-change-pi-prompt/runtime.ts",
	"extensions/pideck-q-change-pi-prompt/transform.ts",
	"extensions/pideck-q-change-pi-prompt/config.ts",
	"extensions/pideck-q-change-pi-prompt/defaults.ts",
	"extensions/pideck-q-change-pi-prompt/layout.ts",
	"extensions/pideck-q-change-pi-prompt/contributions.ts",
	"extensions/pideck-q-change-pi-prompt/shellAvailability.ts",
	"extensions/pideck-q-change-pi-prompt/shellProbe.ts",
	"extensions/pideck-q-change-pi-prompt/windowsShellDiscovery.ts",
	"extensions/pideck-q-change-pi-prompt/childShellPolicy.ts",
	"extensions/pideck-q-change-pi-prompt/childReconciliation.ts",
	"extensions/pideck-q-change-pi-prompt/subagentCatalog.ts",
	"extensions/pideck-q-change-pi-prompt/workflowValidation.ts",
	"extensions/pideck-q-webfetch.ts",
	"extensions/pideck-q-webfetch/dist/index.mjs",
];

// The verifier selects binary names for its host platform, even for synthetic stages.
const BACKEND = process.platform === "win32" ? "PiDeckBackend.exe" : "PiDeckBackend";
const HOST = process.platform === "win32" ? "PiDeck-Q.exe" : "PiDeck-Q";
const SOURCE_TIME = new Date("2026-03-01T00:00:00Z");
const FRESH_TIME = new Date("2026-03-01T00:10:00Z");
const STALE_TIME = new Date("2026-02-01T00:00:00Z");

const tempRoots = [];

after(async () => {
	for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

async function put(path, content = "fixture\n", mtime) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
	if (mtime) await utimes(path, mtime, mtime);
}

/**
 * Synthetic repository (build inputs) plus a C++ stage (artifacts) in separate directories.
 * Mtimes are explicit, so the result never depends on when the test ran or on checkout
 * metadata.
 */
async function makeFixture({ nodeSidecar = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-native2-freshness-"));
	tempRoots.push(root);
	const repo = join(root, "repo");
	const stage = join(root, "stage");

	// Build inputs: backend sources, host sources + resource + target definition + version.
	await put(join(repo, "native", "backend", "domain", "sessions", "Catalog.cpp"), "// backend\n", SOURCE_TIME);
	await put(join(repo, "native", "src", "main.cpp"), "// host\n", SOURCE_TIME);
	await put(join(repo, "native", "PiDeck-Q.rc"), "// resource\n", SOURCE_TIME);
	await put(join(repo, "xmake.lua"), "// targets\n", SOURCE_TIME);
	await put(join(repo, "package.json"), '{"version":"0.0.0-test"}\n', SOURCE_TIME);
	await put(join(repo, "vite.config.ts"), "// vite\n", SOURCE_TIME);

	// Stage artifacts.
	await put(join(stage, "app", "renderer", "index.html"), "<!doctype html><html><body>i</body></html>\n", FRESH_TIME);
	await put(join(stage, "app", "renderer", "web.html"), "<!doctype html><html><body>w</body></html>\n", FRESH_TIME);
	await put(join(stage, BACKEND), "MZfixture\0Qt6Core.dll\0", FRESH_TIME);
	await put(join(stage, HOST), "MZfixture\n", FRESH_TIME);
	await put(join(stage, "Qt6Core.dll"), "MZfixture\n", FRESH_TIME);
	for (const file of CHANGE_PROMPT_FILES) await put(join(stage, "resources", file), "// runtime\n", FRESH_TIME);
	await put(join(stage, "resources", "extensions", "node_modules", "undici", "package.json"), '{"name":"undici"}\n', FRESH_TIME);
	await put(join(stage, "resources", "extensions", "node_modules", "acorn", "package.json"), '{"name":"acorn"}\n', FRESH_TIME);
	await put(join(stage, "resources", "extensions", "node_modules", "acorn", "dist", "acorn.js"), "module.exports={};\n", FRESH_TIME);
	// Present only for the Node compatibility definition (the C++ gate rejects it).
	if (nodeSidecar) await put(join(stage, "app", "native-node", "index.cjs"), "// sidecar\n", FRESH_TIME);

	return {
		root,
		repo,
		stage,
		async stale(relativePath, time = STALE_TIME) {
			const path = join(stage, relativePath);
			await utimes(path, time, time);
		},
		async touchInput(relativePath, time) {
			const path = join(repo, relativePath);
			await utimes(path, time, time);
		},
	};
}

const verify = (fixture, sidecarKind = "cpp") =>
	verifyBuildArtifacts({ repoRoot: fixture.repo, outDir: fixture.stage, sidecarKind });

describe("native2 C++ package freshness", () => {
	test("fresh backend and host binaries pass the C++ package gate", async () => {
		const fixture = await makeFixture();
		const result = await verify(fixture);
		assert.deepEqual(result.errors, []);
		assert.equal(result.ok, true);
		assert.ok(result.checked.some((file) => file.endsWith(BACKEND)));
		// The host executable is validated by the freshness group (and by the packaged-host
		// gate), not added to the checked-file list, so only its age is asserted here.
		assert.ok(existsSync(join(fixture.stage, HOST)));
	});

	test("a backend older than native/backend/** fails even though the exe exists", async () => {
		const fixture = await makeFixture();
		await fixture.stale(BACKEND);
		const result = await verify(fixture);
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Stale cpp-backend artifact/);
		assert.ok(
			result.checked.some((file) => file.endsWith(BACKEND)),
			"the stale binary is still a present, valid entry - only its age is wrong",
		);
	});

	test("a host older than native/src/** fails", async () => {
		const fixture = await makeFixture();
		await fixture.stale(HOST);
		const result = await verify(fixture);
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Stale cpp-host artifact/);
	});

	test("a host older than the target definition or the embedded package version fails", async () => {
		const newer = new Date("2026-03-01T00:20:00Z");
		for (const input of ["xmake.lua", "package.json", "native/PiDeck-Q.rc"]) {
			const fixture = await makeFixture();
			await fixture.touchInput(input, newer);
			const result = await verify(fixture);
			assert.equal(result.ok, false, `${input} must invalidate the host artifact`);
			assert.match(result.errors.join("\n"), /Stale cpp-host artifact/, input);
		}
	});

	test("a backend older than the target definition fails", async () => {
		const fixture = await makeFixture();
		await fixture.touchInput("xmake.lua", new Date("2026-03-01T00:20:00Z"));
		const result = await verify(fixture);
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Stale cpp-backend artifact/);
	});

	test("the Node compatibility definition is not judged by the C++ groups", async () => {
		const fixture = await makeFixture({ nodeSidecar: true });
		await fixture.stale(BACKEND);
		await fixture.stale(HOST);
		const result = await verify(fixture, "node");
		assert.deepEqual(result.errors, []);
		assert.equal(result.ok, true);
	});

	test("the command-line gate reports the stale native binary with exit code 1", async () => {
		const fixture = await makeFixture();
		await fixture.stale(BACKEND);
		const run = spawnSync(
			process.execPath,
			[VERIFIER, "--repo-root", fixture.repo, "--out", fixture.stage, "--sidecar-kind", "cpp"],
			{ encoding: "utf8" },
		);
		assert.equal(run.status, 1);
		assert.match(`${run.stdout}${run.stderr}`, /Stale cpp-backend artifact/);
	});

	test("the real validation stage passes the extended freshness gate", async (t) => {
		if (!existsSync(join(REAL_STAGE, BACKEND))) {
			if (REQUIRED) {
				assert.fail(
					`PIDECK_REQUIRE_BACKEND_TESTS=1 but no C++ stage at ${REAL_STAGE}; build it with ` +
						`"PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake f -m release -y && xmake -r"`,
				);
			}
			t.skip(`no C++ stage at ${REAL_STAGE}`);
			return;
		}
		const result = await verifyBuildArtifacts({
			repoRoot: REPO_ROOT,
			outDir: REAL_STAGE,
			sidecarKind: "cpp",
		});
		assert.deepEqual(result.errors, [], `the published stage must be fresh against its sources`);
	});
});

describe("native2 required stage gate", () => {
	test("the Qt runtime stage suite fails (not skips) when the stage is missing under REQUIRE", async (t) => {
		if (process.platform !== "win32") {
			t.skip("the Qt stage suite only runs on Windows");
			return;
		}
		const emptyStage = await mkdtemp(join(tmpdir(), "pideck-native2-empty-stage-"));
		tempRoots.push(emptyStage);
		// A nested `node --test` must not inherit this runner's context, or the child only
		// reports "run() is being called recursively" and exits 0 without running the suite.
		const childEnv = { ...process.env, PIDECK_REQUIRE_BACKEND_TESTS: "1", PIDECK_STAGE_DIR: emptyStage };
		delete childEnv.NODE_TEST_CONTEXT;
		const run = spawnSync(
			process.execPath,
			["--test", "--test-concurrency=1", resolve(REPO_ROOT, "tests", "native2StageQtRuntime.test.mjs")],
			{ cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: childEnv },
		);
		const output = `${run.stdout}${run.stderr}`;
		assert.notEqual(run.status, 0, `a missing stage must fail the required gate, got:\n${output}`);
		assert.match(output, /PIDECK_REQUIRE_BACKEND_TESTS=1 but no C\+\+ stage/);
		assert.doesNotMatch(output, /# SKIP/, `the required run must not report the stage as skipped:\n${output}`);
	});
});
