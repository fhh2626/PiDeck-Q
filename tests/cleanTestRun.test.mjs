import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCleanTests } from "../scripts/test-clean.mjs";

const cleaned = [
	"out/renderer/old.js",
	"build/native2-validation-unpacked/old.exe",
	"build/windows/x64/debug/old.exe",
	"build/windows/x64/release/old.exe",
];
const preserved = [
	"release/win-unpacked/published.exe",
	"build/icon.png",
	"out/other/keep.js",
];

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-clean-tests-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = await realpath(directory);
	for (const file of [...cleaned, ...preserved]) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), "original");
	}
	await writeFile(join(root, "package.json"), '{"version":"1.2.3"}');
	return root;
}

test("npm test uses the clean-build test entry point", async () => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.scripts.test, "node scripts/test-clean.mjs");
});

test("Windows full tests clean generated outputs and build fresh native fixtures before running", async (t) => {
	const root = await fixture(t);
	const calls = [];
	const stage = join(root, "build/native2-validation-unpacked");
	await runCleanTests({
		repoRoot: root, platform: "win32", arch: "x64", npm: { command: "npm", prefixArgs: [] },
		environment: {
			pideck_stage_dir: "release/win-unpacked", PiDeck_Native2_Stage: "old", PIDECK_CPP_STAGE: "old",
			pideck_backend_test_executable: "old", pideck_native2_fake_pi: "old", pideck_require_backend_tests: "0",
			pideck_version: "old", PiDeck_Renderer_Dir: "old-renderer", pideck_app_dir: "old-app",
			pideck_resources_dir: "old-resources",
		},
		log() {},
		run: async (command, args, { cwd, env }) => {
			calls.push([command, ...args]);
			assert.equal(cwd, root);
			assert.equal(env.PIDECK_STAGE_DIR, stage);
			for (const key of ["pideck_stage_dir", "PiDeck_Native2_Stage", "PIDECK_CPP_STAGE",
				"pideck_backend_test_executable", "pideck_native2_fake_pi", "pideck_require_backend_tests", "pideck_version",
				"PiDeck_Renderer_Dir", "pideck_app_dir", "pideck_resources_dir"]) {
				assert.equal(Object.hasOwn(env, key), false, key);
			}
			if (command === "xmake.exe") assert.equal(env.PIDECK_VERSION, "1.2.3");
			if (calls.length === 1) {
				for (const file of cleaned) await assert.rejects(access(join(root, file)), { code: "ENOENT" });
				for (const file of preserved) assert.equal(await readFile(join(root, file), "utf8"), "original");
			}
			if (args.includes("test:raw")) {
				assert.equal(env.PIDECK_BACKEND_TEST_EXECUTABLE, "build/windows/x64/release/PiDeckBackend.exe");
				assert.equal(env.PIDECK_REQUIRE_BACKEND_TESTS, "1");
			}
		},
	});
	assert.deepEqual(calls.slice(0, 2), [["npm", "run", "prepare:pi-latest"], ["npm", "run", "build:fast"]]);
	const xmakeConfig = calls.find(([tool, operation]) => tool === "xmake.exe" && operation === "f");
	assert.ok(xmakeConfig.includes("--builddir=build"), "Xmake must override a previously configured build directory");
	for (const target of ["PiDeck-Q", "PiDeck-FakeWsl", "PiDeck-FakePi2", "PiDeck-IsolatedDesktop"]) {
		assert(calls.slice(2, -1).some((call) => call[0] === "xmake.exe" && call.includes(target)), target);
	}
	assert.deepEqual(calls.at(-1), ["npm", "run", "test:raw"]);
});

test("raw tests apply forwarded Node options before discovering test files", async (t) => {
	const root = await fixture(t);
	await mkdir(join(root, "tests/helpers"), { recursive: true });
	await writeFile(join(root, "tests/helpers/testEnvironment.mjs"), "");
	await mkdir(join(root, "resources/extensions/pideck-q-change-pi-prompt/tests"), { recursive: true });
	await writeFile(join(root, "tests/sample.test.mjs"), `
		import test from "node:test";
		test("selected fixture", () => {});
		test("excluded fixture", () => { throw new Error("name filter was ignored"); });
	`);
	await writeFile(join(root, "resources/extensions/pideck-q-change-pi-prompt/tests/sample.test.mjs"), "");
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const runner = fileURLToPath(new URL("../scripts/test-raw.mjs", import.meta.url));
	const run = spawnSync(process.execPath, [runner, "--test-name-pattern=^selected fixture$"], {
		cwd: root, env, encoding: "utf8", timeout: 15_000,
	});
	assert.ifError(run.error);
	assert.equal(run.status, 0, run.stdout + run.stderr);
	assert.match(run.stdout, /selected fixture/);
	assert.doesNotMatch(run.stdout, /excluded fixture/);
});

test("required WSL integration suites fail when the launcher fixture is missing", async (t) => {
	const root = await fixture(t);
	const backend = "build/windows/x64/release/PiDeckBackend.exe";
	await writeFile(join(root, backend), "fixture, not an executable process");
	const env = { ...process.env, PIDECK_REQUIRE_BACKEND_TESTS: "1", PIDECK_BACKEND_TEST_EXECUTABLE: backend };
	delete env.NODE_TEST_CONTEXT;
	for (const suite of ["native2WslCandidateAliases", "native2SessionDeleteCanonicalEncoding"]) {
		const path = fileURLToPath(new URL(`${suite}.test.mjs`, import.meta.url));
		const run = spawnSync(process.execPath, ["--test", "--test-name-pattern=^no selected test$", path], {
			cwd: root, env, encoding: "utf8", timeout: 15_000,
		});
		assert.ifError(run.error);
		assert.notEqual(run.status, 0, `${suite} accepted a missing WSL launcher`);
		assert.match(run.stdout + run.stderr, /Build PiDeck-FakeWsl before required native tests/);
	}
});

test("a failed clean build never starts the tests", async (t) => {
	const root = await fixture(t);
	const calls = [];
	await assert.rejects(runCleanTests({
		repoRoot: root, platform: "win32", arch: "x64", npm: { command: "npm", prefixArgs: [] },
		log() {},
		run: async (command, args) => {
			calls.push([command, ...args]);
			if (args.includes("PiDeck-FakeWsl")) throw new Error("fixture build failed");
		},
	}), /fixture build failed/);
	assert(!calls.some((call) => call.includes("test:raw")));
});

test("cleanup refuses a linked parent before removing any output", async (t) => {
	const root = await fixture(t);
	const separate = await mkdtemp(join(tmpdir(), "pideck-clean-external-"));
	t.after(() => rm(separate, { recursive: true, force: true }));
	await rm(join(root, "build/windows"), { recursive: true });
	await mkdir(join(separate, "x64/debug"), { recursive: true });
	await writeFile(join(separate, "x64/debug/keep.exe"), "outside");
	await symlink(separate, join(root, "build/windows"), "junction");
	await assert.rejects(runCleanTests({
		repoRoot: root, platform: "win32", arch: "x64", log() {},
		run: () => assert.fail("must not start building"),
	}), /linked or non-directory/);
	assert.equal(await readFile(join(separate, "x64/debug/keep.exe"), "utf8"), "outside");
	assert.equal(await readFile(join(root, cleaned[0]), "utf8"), "original");
});

test("outside Windows x64, the test entry cleans and rebuilds the renderer without invoking Xmake", async (t) => {
	const root = await fixture(t);
	const calls = [];
	await runCleanTests({
		repoRoot: root, platform: "linux", arch: "x64", npm: { command: "npm", prefixArgs: [] },
		environment: {}, log() {},
		run: async (command, args) => {
			calls.push([command, ...args]);
			await assert.rejects(access(join(root, cleaned[0])), { code: "ENOENT" });
			await access(join(root, cleaned[1]));
		},
	});
	assert.deepEqual(calls, ["prepare:pi-latest", "build:fast", "test:raw"].map((name) => ["npm", "run", name]));
});
