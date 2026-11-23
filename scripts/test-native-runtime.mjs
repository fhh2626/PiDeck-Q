import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_TESTS = [
	"tests/native2FinalAnswerOrder.test.mjs",
	"tests/native2ProjectionReplacementRace.test.mjs",
	"tests/native2ProjectionDiagnostics.test.mjs",
	"tests/native2ThinkingSegmentParity.test.mjs",
	"tests/native2ToolBatchParity.test.mjs",
	"tests/native2StreamCoalescingParity.test.mjs",
	"tests/native2UserImageTimeline.test.mjs",
	"tests/native2RuntimeWindowParity.test.mjs",
	"tests/native2SessionRuntimeCompaction.test.mjs",
	"tests/native2RuntimeAbortRetryParity.test.mjs",
	"tests/native2ExtensionCommandSettlement.test.mjs",
	"tests/turnSegments.test.mjs",
];

/** Forward process startup errors, signals and exit codes without shell interpolation. */
function runCommand(command, args, options) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { ...options, stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolveRun();
			else reject(new Error(`${command} exited with ${code ?? signal}`));
		});
	});
}

/**
 * Build only the backend, never the host's destructive staging hook. Debug is intentional:
 * native2BackendHarness resolves that binary before release or a packaged stage. A failed
 * build aborts the gate, and required mode rejects missing/stale binaries instead of skips.
 */
export async function runNativeRuntimeGate({
	platform = process.platform,
	repoRoot = fileURLToPath(new URL("../", import.meta.url)),
	environment = process.env,
	run = runCommand,
} = {}) {
	if (platform !== "win32") throw new Error("The native runtime gate currently requires Windows and the Qt/Xmake toolchain");
	const env = {
		...environment, PIDECK_REQUIRE_BACKEND_TESTS: "1",
		PIDECK_BACKEND_TEST_EXECUTABLE: "build/windows/x64/debug/PiDeckBackend.exe",
	};
	// When invoked by a node:test regression, a nested test runner needs its own context.
	delete env.NODE_TEST_CONTEXT;
	const options = { cwd: resolve(repoRoot), env };
	await run("xmake.exe", ["f", "-p", "windows", "-a", "x64", "-m", "debug", "-y"], options);
	await run("xmake.exe", ["build", "-y", "PiDeckBackend"], options);
	await run(process.execPath, ["--import", "./tests/helpers/testEnvironment.mjs", "--test", "--test-concurrency=4", ...RUNTIME_TESTS], options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await runNativeRuntimeGate().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
