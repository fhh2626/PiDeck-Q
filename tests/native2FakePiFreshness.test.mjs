/**
 * Freshness contract for the native fake `pi` used by the packaged-host gate.
 *
 * The multi-turn regression was invisible for weeks because a **stale** fake binary kept
 * being picked up: it reused `assistant-1`, latched its ask answer and ran detached turns,
 * so the packaged gate was exercising a test double that no longer matched the asserted
 * turn shape. A required gate must refuse that binary instead of reporting green, and this
 * suite pins the rule at the helper boundary (no packaged host launch needed).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

import { FAKE_PI_ENV, resolveFakePi } from "./helpers/native2PackagedHost.mjs";

const tempRoots = [];
const savedEnv = {
	required: process.env.PIDECK_REQUIRE_BACKEND_TESTS,
	fakePi: process.env[FAKE_PI_ENV],
};

after(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
	if (savedEnv.required === undefined) delete process.env.PIDECK_REQUIRE_BACKEND_TESTS;
	else process.env.PIDECK_REQUIRE_BACKEND_TESTS = savedEnv.required;
	if (savedEnv.fakePi === undefined) delete process.env[FAKE_PI_ENV];
	else process.env[FAKE_PI_ENV] = savedEnv.fakePi;
});

beforeEach(() => {
	delete process.env.PIDECK_REQUIRE_BACKEND_TESTS;
	delete process.env[FAKE_PI_ENV];
});

/**
 * Minimal repository shape the resolver understands. Mtimes are explicit so the test never
 * depends on filesystem timestamp resolution or on the real build tree.
 */
function fakeTree({ sourceAgeSeconds = 60, binaryAgeSeconds = 10, override = "" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-native2-fake-freshness-"));
	tempRoots.push(root);
	const now = Date.now();
	const source = join(root, "native", "tests", "Native2FakePi.cpp");
	mkdirSync(join(root, "native", "tests"), { recursive: true });
	writeFileSync(source, "// fake pi source\n");
	utimesSync(source, new Date(now - sourceAgeSeconds * 1000), new Date(now - sourceAgeSeconds * 1000));
	const binary = join(root, "build", "windows", "x64", "release", "PiDeck-FakePi2.exe");
	mkdirSync(join(root, "build", "windows", "x64", "release"), { recursive: true });
	writeFileSync(binary, "MZ fake");
	utimesSync(binary, new Date(now - binaryAgeSeconds * 1000), new Date(now - binaryAgeSeconds * 1000));
	if (override) process.env[FAKE_PI_ENV] = override;
	return { root, source, binary };
}

describe("native2 fake pi freshness", () => {
	test("a fake newer than its source is the one the gate runs", () => {
		const { root, binary } = fakeTree({ sourceAgeSeconds: 600, binaryAgeSeconds: 5 });
		assert.equal(resolveFakePi(root), binary);
	});

	test("a binary older than Native2FakePi.cpp fails the required gate", () => {
		const { root, binary } = fakeTree({ sourceAgeSeconds: 5, binaryAgeSeconds: 600 });
		process.env.PIDECK_REQUIRE_BACKEND_TESTS = "1";
		assert.throws(
			() => resolveFakePi(root),
			(error) => /older than native\/tests\/Native2FakePi\.cpp/.test(error.message) && error.message.includes(binary),
		);
	});

	test("a stale binary is ignored (skip, never a silent pass) outside the required gate", () => {
		const { root } = fakeTree({ sourceAgeSeconds: 5, binaryAgeSeconds: 600 });
		assert.equal(resolveFakePi(root), "", "a stale fake must read as absent, not as verified");
	});

	test("a missing fake fails the required gate with the rebuild command", () => {
		const root = mkdtempSync(join(tmpdir(), "pideck-native2-fake-missing-"));
		tempRoots.push(root);
		process.env.PIDECK_REQUIRE_BACKEND_TESTS = "1";
		assert.throws(() => resolveFakePi(root), /no fresh native fake pi is available[\s\S]*xmake build -y PiDeck-FakePi2/);
	});

	test("the explicit override path is subject to the same freshness rule", () => {
		const { root, binary } = fakeTree({ sourceAgeSeconds: 900, binaryAgeSeconds: 60 });
		// A copied old binary outside the build tree: selected by the override, still refused
		// when it predates the source, because the red-proof fixture must not be mistaken for
		// the shipped test double.
		process.env[FAKE_PI_ENV] = binary;
		utimesSync(binary, new Date(Date.now() - 3600 * 1000), new Date(Date.now() - 3600 * 1000));
		process.env.PIDECK_REQUIRE_BACKEND_TESTS = "1";
		assert.throws(() => resolveFakePi(root), /older than/);
	});
});
