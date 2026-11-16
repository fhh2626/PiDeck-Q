import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULT_PACK_STAGE, resolvePackStage } from "../scripts/verify-pack-stage.mjs";
import { requirePackagedHost } from "./helpers/native2PackagedHost.mjs";

/**
 * `npm run pack` must be able to produce and verify a measurement stage
 * (`PIDECK_STAGE_DIR=build/native2-validation-unpacked`) without touching
 * `release/win-unpacked`, and must keep verifying `release/win-unpacked` when the variable
 * is absent. Before this wrapper existed the gate hardcoded `--out release/win-unpacked`
 * while xmake already honoured `PIDECK_STAGE_DIR`, so the two could disagree silently.
 *
 * These cases pin the public boundaries: the stage resolver, CLI exit codes, and
 * package script wiring. The native package definition applies at every entry point.
 */

const REPO_ROOT = process.cwd();
const WRAPPER = join(REPO_ROOT, "scripts", "verify-pack-stage.mjs");
const REAL_STAGE = resolve(REPO_ROOT, process.env.PIDECK_STAGE_DIR || "build/native2-validation-unpacked");

const tempRoots = [];

after(async () => {
	for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix) {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

async function put(path, content = "fixture\n") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

function isolatedEnv(extra = {}) {
	const env = { ...process.env };
	delete env.PIDECK_STAGE_DIR;
	return { ...env, ...extra };
}

function runCli(args, env) {
	return spawnSync(process.execPath, [WRAPPER, ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
}

/** Minimal C++ stage that satisfies the shared package definition (same shape as the default-kind suite). */
async function makeCppStage() {
	const root = await tempDir("pideck-pack-stage-");
	await put(join(root, "app", "renderer", "index.html"), "<!doctype html><html><body>index</body></html>\n");
	await put(join(root, "app", "renderer", "web.html"), "<!doctype html><html><body>web</body></html>\n");
	await put(join(root, process.platform === "win32" ? "PiDeckBackend.exe" : "PiDeckBackend"), "MZfixture\0Qt6Core.dll\0");
	await put(join(root, "Qt6Core.dll"), "MZfixture\n");
	return root;
}

describe("native2 pack stage selection (PIDECK_STAGE_DIR)", () => {
	test("no environment keeps the shipping default release/win-unpacked as a C++ package", () => {
		const stage = resolvePackStage({ repoRoot: REPO_ROOT, env: isolatedEnv() });
		assert.equal(stage.stageSource, "default");
		assert.equal(stage.outDir, resolve(REPO_ROOT, DEFAULT_PACK_STAGE));
		assert.equal(DEFAULT_PACK_STAGE, "release/win-unpacked");
	});

	test("PIDECK_STAGE_DIR selects the stage and resolves relative to the repo root", () => {
		const stage = resolvePackStage({
			repoRoot: REPO_ROOT,
			env: isolatedEnv({ PIDECK_STAGE_DIR: "build/native2-validation-unpacked" }),
		});
		assert.equal(stage.stageSource, "PIDECK_STAGE_DIR");
		assert.equal(stage.outDir, join(REPO_ROOT, "build", "native2-validation-unpacked"));
		assert.ok(isAbsolute(stage.outDir));
		// Never the shipping directory when a measurement stage was requested.
		assert.notEqual(stage.outDir, resolve(REPO_ROOT, DEFAULT_PACK_STAGE));
	});

	test("an absolute PIDECK_STAGE_DIR outside the repo is honoured verbatim", async () => {
		const external = await tempDir("pideck-pack-stage-external-");
		const stage = resolvePackStage({ repoRoot: REPO_ROOT, env: isolatedEnv({ PIDECK_STAGE_DIR: external }) });
		assert.equal(stage.outDir, resolve(external));
	});

	test("a blank PIDECK_STAGE_DIR is treated as unset instead of resolving to the repo root", () => {
		for (const value of ["", "   "]) {
			const stage = resolvePackStage({ repoRoot: REPO_ROOT, env: isolatedEnv({ PIDECK_STAGE_DIR: value }) });
			assert.equal(stage.stageSource, "default");
			assert.equal(stage.outDir, resolve(REPO_ROOT, DEFAULT_PACK_STAGE));
		}
	});

	test("CLI verifies the stage named by PIDECK_STAGE_DIR (not release/win-unpacked)", async () => {
		const stage = await makeCppStage();
		const result = runCli([], isolatedEnv({ PIDECK_STAGE_DIR: stage }));
		assert.equal(result.status, 0, `expected pass: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /Build artifacts verified/);
		assert.ok(result.stdout.includes(stage), `verification must name the env-selected stage: ${result.stdout}`);
		assert.doesNotMatch(result.stdout, /release[\\/]win-unpacked/);
	});

	test("CLI fails with a structured error for a missing stage", async () => {
		const missing = join(REPO_ROOT, "build", "native2-missing-stage-for-test");
		const missingResult = runCli([], isolatedEnv({ PIDECK_STAGE_DIR: missing }));
		assert.equal(missingResult.status, 1);
		assert.match(missingResult.stderr, /Build output directory is missing/);

	});

	test("package.json routes pack and verify:build-artifacts through the wrapper", async () => {
		const manifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
		assert.equal(manifest.version, "0.5.0");
		for (const script of ["pack", "verify:build-artifacts"]) {
			assert.match(manifest.scripts[script], /scripts\/verify-pack-stage\.mjs/, `${script} must use the env-aware wrapper`);
			assert.doesNotMatch(manifest.scripts[script], /--out release[\\/]win-unpacked/, `${script} must not hardcode the stage`);
		}
		assert.match(manifest.scripts.pack, /npm run build && npm run build:native/);
		// xmake is the other half of the contract: it must read the same variable.
		const xmake = await readFile(join(REPO_ROOT, "xmake.lua"), "utf8");
		assert.match(xmake, /os\.getenv\("PIDECK_STAGE_DIR"\)/);
	});

	test("packaged-host checks follow the selected stage and reject a missing required host", async () => {
		const root = await tempDir("pideck-host-stage-selection-");
		const stage = join(root, "selected-stage");
		const alternate = join(root, "alternate-stage");
		const executable = process.platform === "win32" ? "PiDeck-Q.exe" : "PiDeck-Q";
		await put(join(stage, executable), "fixture\n");
		await put(join(alternate, executable), "fixture\n");
		const environment = { PIDECK_STAGE_DIR: "selected-stage", PIDECK_REQUIRE_BACKEND_TESTS: "1" };
		assert.equal(requirePackagedHost(root, environment).stage, stage);
		assert.equal(requirePackagedHost(root, { ...environment, PIDECK_NATIVE2_STAGE: alternate }).stage, alternate);
		assert.throws(() => requirePackagedHost(root, { ...environment, PIDECK_STAGE_DIR: "missing" }), /no packaged host exists/);
	});

	test("the real measurement stage passes the env-selected gate", async (t) => {
		if (!existsSync(join(REAL_STAGE, "PiDeck-Q.exe"))) {
			if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") {
				assert.fail(
					`PIDECK_REQUIRE_BACKEND_TESTS=1 but no C++ stage at ${REAL_STAGE}; rebuild with `
					+ "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake f -m release -y && xmake -r",
				);
			}
			t.skip(`no staged package at ${REAL_STAGE}`);
			return;
		}
		const result = runCli([], isolatedEnv({ PIDECK_STAGE_DIR: REAL_STAGE }));
		assert.equal(result.status, 0, `expected the real stage to pass: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /Build artifacts verified \(\d+ files\)/);
		assert.ok(result.stdout.includes(REAL_STAGE));
	});
});
