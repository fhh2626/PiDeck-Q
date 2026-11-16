import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";

/**
 * Packaging entry points default to the C++ sidecar (plan §47).
 *
 * The product decision lives where a package is actually produced: the xmake build kind,
 * the `npm run pack` / `verify:build-artifacts` commands and the two staging scripts'
 * command line. This suite pins that decision at those public boundaries - a plain
 * invocation with **no** `PIDECK_SIDECAR_KIND` must validate/stage the C++ layout, and an
 * unsupported kind must be rejected instead of falling back to the other definition.
 *
 * The suites that hand the library functions a Node layout without naming a kind keep
 * passing because the exported function default stays `node`; only the command line and
 * the build default changed. `native2PackagedHost.test.mjs` proves the built product
 * really starts `PiDeckBackend.exe` with no environment opt-in.
 */

const REPO_ROOT = process.cwd();
const VERIFIER = join(REPO_ROOT, "scripts", "verify-build-artifacts.mjs");
const STAGER = join(REPO_ROOT, "scripts", "stage-native-runtime.mjs");

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

/** Child environment with no inherited sidecar selection, so the default is what runs. */
function childEnv() {
	const env = { ...process.env };
	delete env.PIDECK_SIDECAR_KIND;
	return env;
}

function runScript(script, args, env = childEnv()) {
	return spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
}

/**
 * Minimal stage that satisfies the shared package definition: renderer entries plus a
 * C++ sidecar with an inspectable Qt import. `resources/extensions` is deliberately absent
 * so the extension-content checks (which are kind independent) do not need a copy of the
 * packaged extension tree here; `native2CppStageDeNode.test.mjs` covers those against the
 * real stage.
 */
async function makeCppStage({ leftovers = [] } = {}) {
	const root = await tempDir("pideck-default-kind-");
	await put(join(root, "app", "renderer", "index.html"), "<!doctype html><html><body>index</body></html>\n");
	await put(join(root, "app", "renderer", "web.html"), "<!doctype html><html><body>web</body></html>\n");
	await put(join(root, process.platform === "win32" ? "PiDeckBackend.exe" : "PiDeckBackend"), "MZfixture\0Qt6Core.dll\0");
	await put(join(root, "Qt6Core.dll"), "MZfixture\n");
	for (const leftover of leftovers) await put(join(root, leftover, "marker.bin"), "leftover\n");
	return root;
}

describe("native2 default sidecar kind (C++ package)", () => {
	test("the packaging gate defaults to the C++ package definition with no opt-in", async () => {
		const stage = await makeCppStage();
		const result = runScript(VERIFIER, ["--out", stage]);
		assert.equal(result.status, 0, `default kind must accept a C++ stage: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /Build artifacts verified/);
		// The same stage also proves the default is not the Node definition: the Node branch
		// requires `app/native-node/index.cjs`, which a C++ package does not ship.
		const asNode = runScript(VERIFIER, ["--out", stage, "--sidecar-kind", "node"]);
		assert.equal(asNode.status, 1);
		assert.match(asNode.stderr, /Missing nativeNode entry/);
	});

	test("the default definition still rejects business Node leftovers", async () => {
		const stage = await makeCppStage({ leftovers: ["app/native-node"] });
		const result = runScript(VERIFIER, ["--out", stage]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /business Node leftovers.*app\/native-node/);
	});

	test("an unsupported sidecar kind is rejected by the packaging gate", async () => {
		const stage = await makeCppStage();
		const byArgument = runScript(VERIFIER, ["--out", stage, "--sidecar-kind", "bogus"]);
		assert.equal(byArgument.status, 1, "an unknown --sidecar-kind must fail the gate");
		assert.match(byArgument.stderr, /Unsupported sidecar kind/);

		const byEnvironment = runScript(VERIFIER, ["--out", stage], {
			...childEnv(),
			PIDECK_SIDECAR_KIND: "bogus",
		});
		assert.equal(byEnvironment.status, 1, "an unknown PIDECK_SIDECAR_KIND must fail the gate");
		assert.match(byEnvironment.stderr, /Unsupported sidecar kind/);
	});

	test("the runtime stager defaults to the C++ layout and keeps only extension dependencies", async () => {
		const project = await tempDir("pideck-default-stage-");
		await put(join(project, "node_modules", "undici", "package.json"), '{"name":"undici"}\n');
		await put(join(project, "node_modules", "undici", "index.js"), "module.exports={};\n");
		await put(join(project, "node_modules", "undici", "lib", "dispatcher.js"), "// undici lib\n");
		await put(join(project, "node_modules", "acorn", "package.json"), '{"name":"acorn"}\n');
		await put(join(project, "node_modules", "acorn", "dist", "acorn.js"), "// acorn\n");
		const stage = join(project, "stage");
		const result = runScript(STAGER, ["--project-root", project, "--stage-root", stage]);
		assert.equal(result.status, 0, `default kind must stage the C++ layout: ${result.stdout}${result.stderr}`);
		assert.match(result.stdout, /sidecar cpp/);
		// No bundled business Node: pi's own runtime loads these, the product does not.
		assert.equal(existsSync(join(stage, "app", "node_modules")), false);
		assert.equal(existsSync(join(stage, "resources", "extensions", "node_modules", "undici", "package.json")), true);
		assert.equal(existsSync(join(stage, "resources", "extensions", "node_modules", "undici", "lib", "dispatcher.js")), true);
		assert.equal(existsSync(join(stage, "resources", "extensions", "node_modules", "acorn", "dist", "acorn.js")), true);
	});

	test("the runtime stager rejects an unsupported sidecar kind", async () => {
		const project = await tempDir("pideck-default-stage-bogus-");
		const result = runScript(STAGER, [
			"--project-root", project,
			"--stage-root", join(project, "stage"),
			"--sidecar-kind", "bogus",
		]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Unsupported sidecar kind/);
		// Nothing may be staged for a kind the build cannot have produced.
		assert.equal(existsSync(join(project, "stage")), false);
	});

	test("the real isolated C++ stage passes the default packaging gate", async (t) => {
		const stage = resolve(REPO_ROOT, process.env.PIDECK_CPP_STAGE ?? "build/native2-validation-unpacked");
		if (!existsSync(join(stage, "PiDeckBackend.exe"))) {
			// Under the required gate a missing package must fail: a skipped case would be read
			// as "the shipped artefact was verified".
			if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") {
				assert.fail(`PIDECK_REQUIRE_BACKEND_TESTS=1 but no C++ stage exists at ${stage}`);
			}
			t.skip(`no C++ stage at ${stage} (build with PIDECK_STAGE_DIR=... xmake -r)`);
			return;
		}
		const result = runScript(VERIFIER, ["--out", stage]);
		assert.equal(result.status, 0, `the shipped stage must satisfy the default definition: ${result.stderr}`);
		assert.match(result.stdout, /Build artifacts verified/);
		assert.equal(existsSync(join(stage, "node.exe")), false);
		assert.equal(existsSync(join(stage, "app", "native-node")), false);
		assert.equal(existsSync(join(stage, "app", "node_modules")), false);
	});
});
