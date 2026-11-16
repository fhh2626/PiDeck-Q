import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import * as backendHarness from "./helpers/native2BackendHarness.mjs";

/** Resolver fixtures deliberately contain no executable code or real Qt runtime. */
function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-runtime-gate-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "native/backend/main.cpp");
	const binary = join(root, "build/windows/x64/debug/PiDeckBackend.exe");
	mkdirSync(dirname(source), { recursive: true });
	mkdirSync(dirname(binary), { recursive: true });
	writeFileSync(source, "// fixture");
	const previous = process.env.PIDECK_REQUIRE_BACKEND_TESTS;
	const previousExecutable = process.env.PIDECK_BACKEND_TEST_EXECUTABLE;
	delete process.env.PIDECK_REQUIRE_BACKEND_TESTS;
	delete process.env.PIDECK_BACKEND_TEST_EXECUTABLE;
	t.after(() => {
		if (previous === undefined) delete process.env.PIDECK_REQUIRE_BACKEND_TESTS;
		else process.env.PIDECK_REQUIRE_BACKEND_TESTS = previous;
		if (previousExecutable === undefined) delete process.env.PIDECK_BACKEND_TEST_EXECUTABLE;
		else process.env.PIDECK_BACKEND_TEST_EXECUTABLE = previousExecutable;
	});
	return { root, source, binary };
}

test("native runtime availability explains a missing executable instead of registering no tests", (t) => {
	const { root } = fixture(t);
	const state = backendHarness.backendTestAvailability(root);
	assert.equal(state.executable, "");
	assert.match(state.skip, /not found.*test:native-runtime/);
});

test("native runtime availability skips stale executables but accepts a fresh build", (t) => {
	const { root, source, binary } = fixture(t);
	writeFileSync(binary, "fixture");
	utimesSync(binary, 100, 100);
	utimesSync(source, 200, 200);
	assert.match(backendHarness.backendTestAvailability(root).skip, /stale.*test:native-runtime/);
	utimesSync(binary, 300, 300);
	assert.deepEqual(backendHarness.backendTestAvailability(root), { executable: binary, skip: false });
});

test("required native runtime availability fails on missing or stale builds", (t) => {
	const { root, source, binary } = fixture(t);
	process.env.PIDECK_REQUIRE_BACKEND_TESTS = "1";
	assert.throws(() => backendHarness.backendTestAvailability(root), /no backend executable/);
	writeFileSync(binary, "fixture");
	utimesSync(binary, 100, 100);
	utimesSync(source, 200, 200);
	assert.throws(() => backendHarness.backendTestAvailability(root), /stale/);
});

test("required availability detects a newer build definition", (t) => {
	const { root, source, binary } = fixture(t);
	const definition = join(root, "xmake.lua");
	writeFileSync(binary, "fixture");
	writeFileSync(definition, "-- fixture");
	utimesSync(source, 50, 50);
	utimesSync(binary, 100, 100);
	utimesSync(definition, 300, 300);
	process.env.PIDECK_REQUIRE_BACKEND_TESTS = "1";
	assert.throws(() => backendHarness.backendTestAvailability(root), /stale.*xmake\.lua/);
});

test("pinned required backend never falls back to a release binary", (t) => {
	const { root } = fixture(t);
	const release = join(root, "build/windows/x64/release/PiDeckBackend.exe");
	mkdirSync(dirname(release), { recursive: true });
	writeFileSync(release, "fixture");
	process.env.PIDECK_REQUIRE_BACKEND_TESTS = "1";
	process.env.PIDECK_BACKEND_TEST_EXECUTABLE = "build/windows/x64/debug/PiDeckBackend.exe";
	assert.throws(() => backendHarness.resolveBackendExecutable(root), /no backend executable/);
});

test("CI builds the backend before the full suite on a clean checkout", () => {
	const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
	const build = workflow.indexOf("xmake build -y PiDeckBackend");
	const fullSuite = workflow.indexOf("run: npm test");
	assert.ok(build >= 0 && fullSuite > build, "backend build must precede the full suite");
	for (const target of ["PiDeck-TranscriptHistoryTest", "PiDeck-TodoCommandTest", "PiDeck-FilePathPolicyTest"]) {
		const component = workflow.indexOf(`xmake build -y ${target}`);
		assert.ok(component > build && component < fullSuite, `${target} must be built before its regression suite`);
	}
});

/** Import lazily so resolver regressions remain independently runnable. */
test("native runtime gate builds the resolver's first target before enforcing fresh tests", async () => {
	const { runNativeRuntimeGate } = await import("../scripts/test-native-runtime.mjs");
	const calls = [];
	await runNativeRuntimeGate({
		platform: "win32", repoRoot: process.cwd(), environment: { NODE_TEST_CONTEXT: "child-v8" },
		run: async (command, args, options) => calls.push({ command, args, options }),
	});
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[0].args, ["f", "-p", "windows", "-a", "x64", "-m", "debug", "-y"]);
	assert.deepEqual(calls[1].args, ["build", "-y", "PiDeckBackend"]);
	assert.equal(calls[2].command, process.execPath);
	assert.equal(calls[2].options.env.PIDECK_REQUIRE_BACKEND_TESTS, "1");
	assert.equal(calls[2].options.env.PIDECK_BACKEND_TEST_EXECUTABLE, "build/windows/x64/debug/PiDeckBackend.exe");
	assert.equal(calls[2].options.env.NODE_TEST_CONTEXT, undefined);
	assert.ok(calls[2].args.includes("tests/native2FinalAnswerOrder.test.mjs"));
	assert.ok(calls[2].args.includes("tests/native2ExtensionCommandSettlement.test.mjs"));
	assert.ok(calls.every((call) => call.options.cwd === resolve(process.cwd())));
	assert.ok(calls.every((call) => !call.args.includes("PiDeck-Q")), "the gate must not invoke host staging");
});

test("native runtime gate propagates test-process failures", async () => {
	const { runNativeRuntimeGate } = await import("../scripts/test-native-runtime.mjs");
	let commands = 0;
	const failure = new Error("tests failed");
	await assert.rejects(runNativeRuntimeGate({
		platform: "win32", repoRoot: process.cwd(), environment: {},
		run: async () => { if (++commands === 3) throw failure; },
	}), (error) => error === failure);
	assert.equal(commands, 3);
});

test("native runtime gate propagates build failures and never runs tests afterward", async () => {
	const { runNativeRuntimeGate } = await import("../scripts/test-native-runtime.mjs");
	let commands = 0;
	const failure = new Error("compiler failed");
	await assert.rejects(runNativeRuntimeGate({
		platform: "win32", repoRoot: process.cwd(), environment: {},
		run: async () => { commands += 1; throw failure; },
	}), (error) => error === failure);
	assert.equal(commands, 1);
});
