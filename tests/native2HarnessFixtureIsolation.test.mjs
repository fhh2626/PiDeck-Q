import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import test from "node:test";
import { backendFixtureSettings, createBackendFixture, createFakePi } from "./helpers/native2BackendHarness.mjs";

test("backend fixture singleton opt-out is explicit and preserves the scenario's own setting", () => {
	assert.deepEqual(backendFixtureSettings({}, {}), { theme: "system" });
	assert.deepEqual(backendFixtureSettings({}, { PIDECK_TEST_SINGLE_INSTANCE: "0" }), { theme: "system", singleInstance: false });
	assert.equal(backendFixtureSettings({ singleInstance: true }, { PIDECK_TEST_SINGLE_INSTANCE: "0" }).singleInstance, true);
	assert.equal(backendFixtureSettings({ singleInstance: false }, {}).singleInstance, false);
});

test("the POSIX fake pi launch shim is executable through the real child-process boundary", { skip: process.platform === "win32" }, () => {
	const fixture = createBackendFixture();
	try {
		const fake = createFakePi(fixture, {});
		const result = spawnSync(fake.shim, ["--version"], {
			env: { ...process.env, FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			encoding: "utf8", timeout: 10_000,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /\d+\.\d+\.\d+/);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
