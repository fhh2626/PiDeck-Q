import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

import { verifyBuildArtifacts } from "../scripts/verify-build-artifacts.mjs";
import { connectPage, verifyPackagedStage } from "./helpers/native2PackagedHost.mjs";

/**
 * Package gate for native: a C++ package must not carry business Node.
 *
 * The C++ backend is a first-class sidecar (plan §11.2), so the staged package definition
 * differs from the Node one: no bundled `app/native-node/index.cjs`, no
 * `app/node_modules` (node-pty/sql.js/undici), no `node/` directory and no node.exe.
 * `resources/extensions/node_modules` stays because pi loads the built-in TS extensions
 * with its own runtime. These cases drive the real verifier over a synthetic stage, so a
 * leftover cannot regress silently just because the published stage happens to be clean.
 */

const REPO_ROOT = process.cwd();
// The gate must inspect the stage this lane actually builds. xmake and `npm run pack` both
// select it through PIDECK_STAGE_DIR (see scripts/verify-pack-stage.mjs), so that variable is
// honoured first; without it the validation stage this lane writes is the default. Pointing the
// gate at `build/native2-cpp-unpacked` (a second stage no current build writes) made it report
// a stale package that never came from the run under test.
const DEFAULT_CPP_STAGE = join(REPO_ROOT, "build", "native2-validation-unpacked");
const REAL_CPP_STAGE = process.env.PIDECK_CPP_STAGE
	? resolve(process.env.PIDECK_CPP_STAGE)
	: process.env.PIDECK_STAGE_DIR
		? resolve(process.env.PIDECK_STAGE_DIR)
		: DEFAULT_CPP_STAGE;

const CHANGE_PROMPT_FILES = [
	"extensions/pideck-q-change-pi-prompt.ts",
	"extensions/pideck-q-change-pi-prompt/runtime.ts",
	"extensions/pideck-q-change-pi-prompt/transform.ts",
	"extensions/pideck-q-change-pi-prompt/config.ts",
	"extensions/pideck-q-change-pi-prompt/defaults.ts",
	"extensions/pideck-q-change-pi-prompt/layout.ts",
	"extensions/pideck-q-change-pi-prompt/contributions.ts",
	"extensions/pideck-q-change-pi-prompt/activeToolLines.ts",

	"extensions/pideck-q-subagents/src/policy/environment/runtime.ts",
	"extensions/pideck-q-subagents/src/policy/environment/hostEnvironment.ts",
	"extensions/pideck-q-subagents/src/policy/environment/childRuntime.ts",
	"extensions/pideck-q-subagents/src/policy/environment/childPrompt.ts",
	"extensions/pideck-q-subagents/src/policy/environment/toolMetadata.ts",
	"extensions/pideck-q-subagents/src/policy/environment/childReconciliation.ts",
	"extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts",
	"extensions/pideck-q-subagents/src/policy/environment/policyStorage.ts",
	"extensions/pideck-q-subagents/src/policy/environment/childShellPolicy.ts",
	"extensions/pideck-q-subagents/src/policy/environment/subagentCatalog.ts",
	"extensions/pideck-q-subagents/src/policy/environment/shellAvailability.ts",
	"extensions/pideck-q-subagents/src/policy/environment/shellProbe.ts",
	"extensions/pideck-q-subagents/src/policy/environment/windowsShellDiscovery.ts",
	"extensions/pideck-q-subagents/src/policy/environment/copy.ts",
	"extensions/pideck-q-subagents/src/shared/prompt-sections.ts",
	"extensions/pideck-q-subagents/src/runs/shared/child-loader-identity.ts",
	"extensions/pideck-q-webfetch.ts",
	"extensions/pideck-q-webfetch/dist/index.mjs",
];

const tempRoots = [];

after(async () => {
	for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

async function writeFileAt(root, relativePath, content = "// fixture\n") {
	const path = join(root, relativePath);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

/**
 * Minimal but structurally complete stage: renderer entry, backend with an inspectable
 * Qt import, the Qt DLL it names, the extension runtime files the verifier requires and
 * the extension dependency tree that must survive de-Node. `repoRoot` is the temp root,
 * so the freshness groups have no inputs and cannot mask a leftover finding.
 */
async function makeStage({ leftovers = [], extraFiles = [] } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-cpp-stage-"));
	tempRoots.push(root);
	await writeFileAt(root, "app/renderer/index.html", "<!doctype html><html><body>index</body></html>\n");
	await writeFileAt(root, "app/renderer/web.html", "<!doctype html><html><body>web</body></html>\n");
	await writeFileAt(root, process.platform === "win32" ? "PiDeckBackend.exe" : "PiDeckBackend", "MZfixture\0Qt6Core.dll\0");
	await writeFileAt(root, "Qt6Core.dll", "MZfixture\n");
	for (const file of CHANGE_PROMPT_FILES) await writeFileAt(root, join("resources", file));
	await writeFileAt(root, "resources/extensions/node_modules/undici/package.json", "{\"name\":\"undici\"}\n");
	await writeFileAt(root, "resources/extensions/node_modules/acorn/package.json", "{\"name\":\"acorn\"}\n");
	await writeFileAt(root, "resources/extensions/node_modules/acorn/dist/acorn.js", "module.exports={};\n");

	for (const leftover of leftovers) {
		// Directories are created with a file inside so "empty node/ dir" is not the only
		// shape under test; the verifier checks the path itself.
		await writeFileAt(root, join(leftover, "marker.bin"), "leftover\n");
	}
	for (const [relativePath, content] of extraFiles) await writeFileAt(root, relativePath, content);
	return root;
}

async function verify(stage) {
	return verifyBuildArtifacts({ repoRoot: stage, outDir: stage });
}

describe("native2 C++ package de-Node gate", () => {
	test("a dead packaged host fails immediately instead of waiting for CDP", async () => {
		await assert.rejects(connectPage(1, {
			launch: { child: { exitCode: 42 }, output: { stderr: "missing dependency" } },
		}), /exited before WebView2.*42.*missing dependency/);
	});

	test("packaged-host verification uses the current native-only CLI", async () => {
		assert.match(verifyPackagedStage(await makeStage()), /verified/i);
	});

	test("a clean C++ stage passes and requires no Node entry point", async () => {
		const stage = await makeStage();
		const result = await verify(stage);
		assert.deepEqual(result.errors, []);
		assert.equal(result.ok, true);
		assert.ok(result.checked.some((file) => file.endsWith(process.platform === "win32" ? "PiDeckBackend.exe" : "PiDeckBackend")));
		assert.ok(result.checked.some((file) => file.endsWith("Qt6Core.dll")));
	});

	test("rejects every business Node leftover the plan forbids", async () => {
		const cases = [
			{ leftover: "app/native-node", expected: "app/native-node" },
			{ leftover: "app/node_modules", expected: "app/node_modules" },
			{ leftover: "node", expected: "node" },
		];
		for (const { leftover, expected } of cases) {
			const stage = await makeStage({ leftovers: [leftover] });
			const result = await verify(stage);
			assert.equal(result.ok, false, `${leftover} must fail the C++ package gate`);
			assert.ok(
				result.errors.some((error) => error.includes("business Node leftovers") && error.includes(expected)),
				`expected a de-Node error naming ${expected}, got: ${result.errors.join(" | ")}`,
			);
		}
	});

	test("rejects a node.exe anywhere in a C++ stage", async () => {
		const stage = await makeStage({ extraFiles: [["resources/extensions/node.exe", "MZfixture\n"]] });
		const result = await verify(stage);
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.some((error) => error.includes("must not contain a Node runtime")),
			`expected a node.exe rejection, got: ${result.errors.join(" | ")}`,
		);
	});

	test("an empty node/ directory alone is still a violation", async () => {
		const stage = await makeStage();
		await mkdir(join(stage, "node"));
		const result = await verify(stage);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((error) => error.includes("business Node leftovers") && error.includes("node")));
	});

	test("the real C++ stage verifies and ships the extension dependency tree", async (t) => {
		const backend = join(REAL_CPP_STAGE, "PiDeckBackend.exe");
		if (!existsSync(backend)) {
			assert.notEqual(process.env.PIDECK_REQUIRE_BACKEND_TESTS, "1", `required C++ stage missing at ${REAL_CPP_STAGE}`);
			t.skip(`no C++ stage at ${REAL_CPP_STAGE} (build with PIDECK_STAGE_DIR=...)`);
			return;
		}
		const result = await verifyBuildArtifacts({
			repoRoot: REPO_ROOT,
			outDir: REAL_CPP_STAGE,
		});
		assert.deepEqual(result.errors, [], `stage must satisfy the C++ package definition`);
		for (const forbidden of ["app/native-node", "app/node_modules", "node", "node.exe"]) {
			assert.equal(
				existsSync(join(REAL_CPP_STAGE, forbidden)),
				false,
				`C++ stage must not contain ${forbidden}`,
			);
		}
		// pi resolves these beside the built-in extensions with its own runtime.
		for (const kept of ["undici", "acorn"]) {
			const info = await stat(join(REAL_CPP_STAGE, "resources", "extensions", "node_modules", kept));
			assert.equal(info.isDirectory(), true, `${kept} must stay in the extension dependency tree`);
		}
		assert.equal(existsSync(join(REAL_CPP_STAGE, "app", "renderer", "index.html")), true);
	});
});
