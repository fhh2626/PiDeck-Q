import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";
import { processAlive } from "./helpers/native2ProbePi.mjs";

const pinned = process.env.PIDECK_VERSION_PROBE_TEST_EXECUTABLE;
const sources = ["native/tests/PiVersionProbeTest.cpp", "native/backend/domain/runtime/PiVersionProbe.cpp",
	"native/backend/domain/runtime/PiLaunch.h", "xmake.lua"];
const executable = nativeBuildPaths("PiDeck-PiVersionProbeTest", { pinned }).map((value) => resolve(value))
	.find((candidate) => existsSync(candidate) && sources.every((source) => statSync(candidate).mtimeMs >= statSync(source).mtimeMs));
const required = Boolean(pinned) || process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const skip = !executable && !required ? "Build PiDeck-PiVersionProbeTest to verify native probe completion" : false;

for (const mode of ["success", "failure", "timeout"]) {
	test(`native Pi version probe settles once after ${mode} and can retry failures`, { skip }, () => {
		assert.ok(executable, "A fresh PiDeck-PiVersionProbeTest executable is required");
		const result = spawnSync(executable, [mode], {
			windowsHide: true,
			env: childPathEnvironment(process.env, joinPathParts([qtBinDirectory(), environmentPath()])),
			encoding: "utf8", timeout: 15_000,
		});
		assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
		const observed = JSON.parse(result.stdout);
		assert.deepEqual(observed.initial, [mode === "success" ? "1.4.0" : ""]);
		assert.equal(observed.cachedAfterInitial, mode === "success" ? "1.4.0" : "");
		assert.deepEqual(observed.retried, ["1.4.0"], "failed probes must not suppress a later successful probe");
		assert.equal(observed.cachedAfterRetry, "1.4.0");
	});
}

for (const mode of ["cancel", "destroy"]) {
	test(`native version probe owner ${mode} stops the child and suppresses late callbacks`, { skip }, () => {
		assert.ok(executable, "A fresh PiDeck-PiVersionProbeTest executable is required");
		const result = spawnSync(executable, [mode], {
			windowsHide: true,
			env: childPathEnvironment(process.env, joinPathParts([qtBinDirectory(), environmentPath()])),
			encoding: "utf8", timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
		const observed = JSON.parse(result.stdout);
		assert.equal(observed.callbacks, 0);
		assert.ok(observed.elapsedMs >= 0 && observed.elapsedMs < 500, JSON.stringify(observed));
		assert.ok(observed.pid > 0, "a real child must have started before cancellation");
		try {
			assert.equal(processAlive(observed.pid), false, "the probe child must be reaped");
		} finally {
			if (processAlive(observed.pid)) process.kill(observed.pid);
		}
	});
}

for (const mode of ["refresh", "refresh-failure", "refresh-timeout"]) {
	test(`native version probe ${mode} replaces a previously successful cached answer`, { skip }, () => {
		assert.ok(executable, "A fresh PiDeck-PiVersionProbeTest executable is required");
		const result = spawnSync(executable, [mode], {
			windowsHide: true,
			env: childPathEnvironment(process.env, joinPathParts([qtBinDirectory(), environmentPath()])),
			encoding: "utf8", timeout: 15_000,
		});
		assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
		const observed = JSON.parse(result.stdout);
		assert.deepEqual(observed.initial, ["1.4.0"]);
		assert.equal(observed.cachedAfterInitial, "1.4.0");
		assert.equal(observed.cachedDuringRetry, "", "an active replacement probe must discard the former answer");
		const expected = mode === "refresh" ? "1.5.0" : "";
		assert.deepEqual(observed.retried, [expected]);
		assert.equal(observed.cachedAfterRetry, expected, "a failed refresh must not restore the former answer");
	});
}
