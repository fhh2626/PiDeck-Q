import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNpmCommand } from "./prepare-pi-latest.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RENDERER = "out/renderer";
const TEST_STAGE = "build/native2-validation-unpacked";
const NATIVE_OUTPUT = "build/windows/x64";

// Only fixtures consumed by test:raw. The standalone GUI and host RPC gates
// have their own build scripts and are not part of the Node test runner.
const NATIVE_FIXTURES = [
	["PiDeck-FakeWsl"],
	["PiDeck-FakePi2", "PIDECK_NATIVE2_FAKE_PI"],
	["PiDeck-IsolatedDesktop", "PIDECK_ISOLATED_DESKTOP_EXECUTABLE"],
	["PiDeck-ScopedMutationTest", "PIDECK_SCOPED_MUTATION_TEST_EXECUTABLE"],
	["PiDeck-NativeFileShellTest", "PIDECK_FILE_SHELL_TEST_EXECUTABLE"],
	["PiDeck-SummaryCacheWriteOrderTest", "PIDECK_SUMMARY_CACHE_TEST_EXECUTABLE"],
	["PiDeck-SessionCatalogConcurrencyTest"],
	["PiDeck-CopyStreamTest"],
	["PiDeck-BackgroundWorkTest", "PIDECK_BACKGROUND_WORK_TEST_EXECUTABLE"],
	["PiDeck-TodoCommandTest", "PIDECK_TODO_COMMAND_TEST_EXECUTABLE"],
	["PiDeck-TranscriptHistoryTest", "PIDECK_TRANSCRIPT_TEST_EXECUTABLE"],
	["PiDeck-FilePathPolicyTest", "PIDECK_FILE_PATH_TEST_EXECUTABLE"],
	["PiDeck-DesktopProxyPolicyTest", "PIDECK_DESKTOP_PROXY_TEST_EXECUTABLE"],
];

/** Check all components before deleting anything so a symlink or junction cannot redirect cleanup. */
async function checkOutputPath(root, output) {
	let path = root;
	for (const component of output.split("/")) {
		path = join(path, component);
		const info = await lstat(path).catch((error) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!info) return;
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`Refusing to clean a linked or non-directory build path: ${path}`);
		}
	}
}

/** Run each build or test step without shell interpolation. */
function runCommand(command, args, options) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { ...options, stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolveRun();
			else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
		});
	});
}

/** Start the full suite only after recreating the outputs it exercises. */
export async function runCleanTests({
	repoRoot = REPO_ROOT,
	platform = process.platform,
	arch = process.arch,
	environment = process.env,
	npm = createNpmCommand(),
	run = runCommand,
	log = console.log,
	args = [],
} = {}) {
	const cwd = await realpath(repoRoot);
	// The bundled Qt SDK and staging hook currently support Windows x64.
	const buildNative = platform === "win32" && arch === "x64";
	const outputs = buildNative
		? [RENDERER, TEST_STAGE, `${NATIVE_OUTPUT}/debug`, `${NATIVE_OUTPUT}/release`]
		: [RENDERER];
	for (const output of outputs) await checkOutputPath(cwd, output);
	for (const output of outputs) {
		log(`Cleaning ${output}`);
		await rm(join(cwd, output), { recursive: true, force: true, maxRetries: 3 });
	}

	const env = { ...environment };
	if (buildNative) {
		// Windows child environments are case-insensitive, but this copy is not.
		// Manual overrides remain available through test:raw.
		const overrides = new Set([
			"PIDECK_STAGE_DIR", "PIDECK_NATIVE2_STAGE", "PIDECK_CPP_STAGE", "PIDECK_BACKEND_TEST_EXECUTABLE",
			"PIDECK_APP_DIR", "PIDECK_RENDERER_DIR", "PIDECK_RESOURCES_DIR", "PIDECK_PACKAGED",
			"PIDECK_SIDECAR_EXECUTABLE", "PIDECK_SIDECAR_ARGS",
			"PIDECK_REQUIRE_BACKEND_TESTS", "PIDECK_VERSION", ...NATIVE_FIXTURES.map(([, override]) => override).filter(Boolean),
		]);
		for (const key of Object.keys(env)) if (overrides.has(key.toUpperCase())) delete env[key];
		env.PIDECK_STAGE_DIR = join(cwd, TEST_STAGE);
		env.PIDECK_BACKEND_TEST_EXECUTABLE = `${NATIVE_OUTPUT}/release/PiDeckBackend.exe`;
		env.PIDECK_REQUIRE_BACKEND_TESTS = "1";
	}
	const options = { cwd, env };
	const npmRun = (name, extra = []) => run(npm.command, [...npm.prefixArgs, "run", name, ...extra], options);
	await npmRun("prepare:pi-latest");
	await npmRun("build:fast");
	if (buildNative) {
		const { version } = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
		const nativeOptions = { cwd, env: { ...env, PIDECK_VERSION: version } };
		await run("xmake.exe", ["f", "-p", "windows", "-a", "x64", "-m", "release", "--builddir=build", "-y"], nativeOptions);
		await run("xmake.exe", ["build", "-r", "-y", "PiDeck-Q"], nativeOptions);
		for (const [target] of NATIVE_FIXTURES) {
			await run("xmake.exe", ["build", "-r", "-y", target], nativeOptions);
		}
	}
	await npmRun("test:raw", args.length ? ["--", ...args] : []);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runCleanTests({ args: process.argv.slice(2) }).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
