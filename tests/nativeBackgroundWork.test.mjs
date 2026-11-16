import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const pinned = process.env.PIDECK_BACKGROUND_WORK_TEST_EXECUTABLE;
const candidates = nativeBuildPaths("PiDeck-BackgroundWorkTest", { pinned });
const sources = ["native/tests/BackgroundWorkTest.cpp", "native/backend/process/BackgroundWork.cpp",
	"native/backend/process/BackgroundWork.h", "xmake.lua"];
const executable = candidates.map((path) => resolve(path)).find((path) => existsSync(path)
	&& sources.every((source) => statSync(path).mtimeMs >= statSync(source).mtimeMs));
const required = Boolean(pinned) || process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const skip = !executable && !required ? "Build PiDeck-BackgroundWorkTest to verify worker ownership and shutdown" : false;

/** Exercise the production workers with semaphore-controlled work, without filesystem or network delays. */
function run(mode) {
	assert.ok(executable, "A fresh PiDeck-BackgroundWorkTest executable is required");
	const result = spawnSync(executable, [mode], {
		env: childPathEnvironment(process.env, joinPathParts([qtBinDirectory(), environmentPath()])),
		encoding: "utf8", timeout: 20_000,
	});
	assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
	return JSON.parse(result.stdout);
}

test("native interactive read bypasses a gated domain task while mutations retain FIFO order", { skip }, (t) => {
	const result = run("isolation");
	t.diagnostic(JSON.stringify(result));
	assert.equal(result.domainStarted, true);
	assert.equal(result.readBeforeRelease, true);
	assert.equal(result.ownerContinuation, true);
	assert.equal(result.mutationsFinished, true);
	assert.deepEqual(result.mutationOrder, [1, 2, 3]);
	assert.equal(result.drained, true);
});

test("native shutdown stops both worker queues before joining either one", { skip }, () => {
	const result = run("drain");
	assert.equal(result.domainStarted, true);
	assert.equal(result.readStarted, true);
	assert.equal(result.drained, true);
	assert.equal(result.abandoned, false);
	assert.equal(result.secondDrain, true);
	assert.equal(result.queuedBodies, 0);
	assert.equal(result.completions, 0);
});

test("native worker shutdown shares one deadline and never waits a second drain budget", { skip }, (t) => {
	const result = run("timeout");
	t.diagnostic(JSON.stringify(result));
	assert.equal(result.domainStarted, true);
	assert.equal(result.readStarted, true);
	assert.equal(result.drained, false);
	assert.equal(result.abandoned, true);
	assert.equal(result.secondDrain, false);
	assert.equal(result.queuedBodies, 0);
	assert.equal(result.completions, 0);
	assert.ok(result.elapsedMs < 350, `the 200 ms budget was spent separately for each worker (${result.elapsedMs} ms)`);
	assert.ok(result.secondElapsedMs < 100, `a second drain waited again (${result.secondElapsedMs} ms)`);
});
