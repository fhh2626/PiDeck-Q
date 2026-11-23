import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createDefaultSecurityConfig } from "../src/shared/types/security.ts";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const { skip } = backendTestAvailability();

/** Read the public security API and fail at the transport boundary when it rejects a call. */
async function getConfig(session) {
	const response = await session.invoke("security:get-config");
	assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
	return response.payload.result;
}

test("native security defaults match the shared defaults for both shell tools", { skip }, async (t) => {
	const session = await startBackendSession(t);
	assert.deepEqual(await getConfig(session), createDefaultSecurityConfig());
});

test("native security migrates missing PowerShell rules and built-in tool actions", { skip }, async (t) => {
	const legacy = createDefaultSecurityConfig();
	for (const level of legacy.levels) {
		delete level.denyPowerShellPatterns;
		delete level.toolActions.powershell;
	}
	const custom = {
		...structuredClone(legacy.levels.find((level) => level.id === "standard")),
		id: "custom-legacy",
		name: "Custom legacy",
		builtin: false,
	};
	legacy.levels.push(custom);
	const session = await startBackendSession(t, { settings: { securityConfig: legacy } });
	const actual = await getConfig(session);
	const defaults = createDefaultSecurityConfig();
	for (const expected of defaults.levels) {
		assert.deepEqual(actual.levels.find((level) => level.id === expected.id), expected);
	}
	assert.deepEqual(actual.levels.find((level) => level.id === custom.id), {
		...custom,
		denyPowerShellPatterns: defaults.levels.find((level) => level.id === "standard").denyPowerShellPatterns,
	});
	const saved = await session.invoke("security:update-config", [{ enabled: true, levels: legacy.levels }]);
	assert.equal(saved.payload.result.ok, true, JSON.stringify(saved.payload));
	const stored = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
	const snapshot = JSON.parse(readFileSync(join(session.fixture.userData, "security-policy.json"), "utf8"));
	assert.deepEqual(stored.securityConfig.levels, actual.levels);
	assert.deepEqual(snapshot.levels, actual.levels);
});

test("native security preserves explicit empty PowerShell rules and user actions", { skip }, async (t) => {
	const config = createDefaultSecurityConfig();
	const standard = config.levels.find((level) => level.id === "standard");
	const strict = config.levels.find((level) => level.id === "strict");
	standard.denyPowerShellPatterns = [];
	standard.toolActions.powershell = "allow";
	strict.denyPowerShellPatterns = ["\\bStop-Service\\b"];
	strict.toolActions.powershell = "deny";
	const session = await startBackendSession(t, { settings: { securityConfig: config } });
	assert.deepEqual(await getConfig(session), config);
	const saved = await session.invoke("security:update-config", [{ levels: config.levels }]);
	assert.equal(saved.payload.result.ok, true, JSON.stringify(saved.payload));
	assert.deepEqual(saved.payload.result.config, config);
	assert.deepEqual(await getConfig(session), config);
});

test("native security persists edited PowerShell rules independently of Bash rules", { skip }, async (t) => {
	const session = await startBackendSession(t);
	const config = await getConfig(session);
	const standard = config.levels.find((level) => level.id === "standard");
	const bashPatterns = [...standard.denyBashPatterns];
	standard.denyPowerShellPatterns = ["\\bStop-Service\\b", "\\bRestart-Computer\\b"];
	const saved = await session.invoke("security:update-config", [{ levels: config.levels }]);
	assert.equal(saved.payload.result.ok, true, JSON.stringify(saved.payload));
	assert.deepEqual(saved.payload.result.config.levels, config.levels);
	assert.deepEqual((await getConfig(session)).levels, config.levels);
	const stored = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
	const snapshot = JSON.parse(readFileSync(join(session.fixture.userData, "security-policy.json"), "utf8"));
	assert.deepEqual(stored.securityConfig.levels, config.levels);
	assert.deepEqual(snapshot.levels, config.levels);
	assert.deepEqual(snapshot.levels.find((level) => level.id === "standard").denyBashPatterns, bashPatterns);
});

test("native security rejects malformed PowerShell rules without changing saved policy", { skip }, async (t) => {
	const session = await startBackendSession(t);
	const initialized = await session.invoke("security:update-config", [{ enabled: true }]);
	assert.equal(initialized.payload.result.ok, true, JSON.stringify(initialized.payload));
	const config = await getConfig(session);
	const settingsPath = join(session.fixture.userData, "settings.json");
	const snapshotPath = join(session.fixture.userData, "security-policy.json");
	const originalSettings = readFileSync(settingsPath, "utf8");
	const originalSnapshot = readFileSync(snapshotPath, "utf8");
	for (const invalid of [null, "not-an-array", [7], ["["]]) {
		const levels = structuredClone(config.levels);
		levels.find((level) => level.id === "standard").denyPowerShellPatterns = invalid;
		const result = await session.invoke("security:update-config", [{ levels }]);
		assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
		assert.equal(result.payload.result.ok, false);
		assert.equal(result.payload.result.code, "VALIDATION_FAILED");
		assert.deepEqual(await getConfig(session), config);
		assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);
		assert.equal(readFileSync(snapshotPath, "utf8"), originalSnapshot);
	}
});

for (const [field, flags] of [["denyBashPatterns", ""], ["denyPowerShellPatterns", "i"]]) {
	test(`native security accepts ECMAScript patterns in ${field}`, { skip }, async (t) => {
		const patterns = [
			String.raw`\u0061`,
			"(?<=prefix)foo",
			"(?<!prefix)foo",
			String.raw`(?<name>foo)\k<name>`,
			String.raw`(?<\u{105C0}>a)`,
			String.raw`(?<${String.fromCodePoint(0x105c0)}>a)\k<\uD801\uDDC0>`,
			String.raw`(?<a\u0301>a)\k<a\u0301>`,
			// Named groups require a second parser pass, which must reset its count.
			"()".repeat(32766) + "(?<last>)",
			"[]",
			"[^]",
		];
		for (const pattern of patterns) assert.doesNotThrow(() => new RegExp(pattern, flags));
		const session = await startBackendSession(t);
		const config = await getConfig(session);
		config.levels.find((level) => level.id === "standard")[field] = patterns;
		const saved = await session.invoke("security:update-config", [{ levels: config.levels }]);
		assert.equal(saved.payload.result.ok, true, JSON.stringify(saved.payload));
		assert.deepEqual((await getConfig(session)).levels, config.levels);
		const snapshot = JSON.parse(readFileSync(join(session.fixture.userData, "security-policy.json"), "utf8"));
		assert.deepEqual(snapshot.levels, config.levels);
	});

	test(`native security rejects unsupported patterns in ${field} without changing policy`, { skip }, async (t) => {
		const session = await startBackendSession(t);
		const initialized = await session.invoke("security:update-config", [{ enabled: true }]);
		assert.equal(initialized.payload.result.ok, true, JSON.stringify(initialized.payload));
		const config = await getConfig(session);
		const settingsPath = join(session.fixture.userData, "settings.json");
		const snapshotPath = join(session.fixture.userData, "security-policy.json");
		const originalSettings = readFileSync(settingsPath, "utf8");
		const originalSnapshot = readFileSync(snapshotPath, "utf8");
		// Node 22-based Pi runtimes lack the two ECMAScript 2025 features, even
		// though the repository's Node 24 build runtime accepts them.
		const unsupported = ["(?i)Remove-Item", "(?|a|b)", "(?>foo)", "foo++", "(?R)",
			"(?i:foo)", "(?<name>foo)|(?<name>bar)"];
		for (const pattern of unsupported) {
			const levels = structuredClone(config.levels);
			levels.find((level) => level.id === "standard")[field] = [pattern];
			const result = await session.invoke("security:update-config", [{ levels }]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			assert.equal(result.payload.result.ok, false, `${field}: ${pattern}`);
			assert.equal(result.payload.result.code, "VALIDATION_FAILED");
			assert.deepEqual(await getConfig(session), config);
			assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);
			assert.equal(readFileSync(snapshotPath, "utf8"), originalSnapshot);
		}
	});

	for (const [label, pattern] of [
		["Unicode 17 group names", String.raw`(?<\u{11DB0}>a)`],
		["literal Unicode 17 group names", `(?<${String.fromCodePoint(0x11db0)}>a)`],
		["Unicode 17 continuation characters in group names", String.raw`(?<a\u{1ACF}>a)`],
		["more than 32767 captures", "()".repeat(32768)],
	]) {
		test(`native security rejects ${label} in ${field} without changing policy`, { skip }, async (t) => {
			const session = await startBackendSession(t);
			const initialized = await session.invoke("security:update-config", [{ enabled: true }]);
			assert.equal(initialized.payload.result.ok, true, JSON.stringify(initialized.payload));
			const config = await getConfig(session);
			const settingsPath = join(session.fixture.userData, "settings.json");
			const snapshotPath = join(session.fixture.userData, "security-policy.json");
			const originalSettings = readFileSync(settingsPath, "utf8");
			const originalSnapshot = readFileSync(snapshotPath, "utf8");
			const levels = structuredClone(config.levels);
			levels.find((level) => level.id === "standard")[field] = [pattern];
			const result = await session.invoke("security:update-config", [{ levels }]);
			assert.equal(result.payload.ok, true);
			assert.equal(result.payload.result.ok, false, label);
			assert.equal(result.payload.result.code, "VALIDATION_FAILED");
			assert.deepEqual(await getConfig(session), config);
			assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);
			assert.equal(readFileSync(snapshotPath, "utf8"), originalSnapshot);
		});
	}
}
