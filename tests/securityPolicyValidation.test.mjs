import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createSecurityStoreFixture } from "./helpers/securityStoreFixture.mjs";

const { resolvePolicyPath, validateSecurityConfig, buildSnapshot } = loadTsCommonJs("src/main/security/policy.ts");
const { createDefaultSecurityConfig } = loadTsCommonJs("src/shared/types/security.ts");
const gate = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts");

test("SecurityStore rejects explicit invalid overrides without clearing existing protection", async () => {
	const config = createDefaultSecurityConfig();
	config.sessionOverrides.s1 = "strict";
	const { store, saved, snapshots } = createSecurityStoreFixture({ config });
	await assert.rejects(store.updateConfig({ levels: config.levels, sessionOverrides: { s1: "typo" } }),
		{ code: "SECURITY_CONFIG_VALIDATION_FAILED" });
	assert.equal(store.getConfig().sessionOverrides.s1, "strict");
	assert.equal(saved.length, 0);
	assert.equal(snapshots.length, 0);
});

test("SecurityStore validates malformed levels before inspecting their ids", async () => {
	const { store, saved, snapshots } = createSecurityStoreFixture();
	await assert.rejects(store.updateConfig({ levels: [null] }), { code: "SECURITY_CONFIG_VALIDATION_FAILED" });
	assert.equal(saved.length, 0);
	assert.equal(snapshots.length, 0);
});

test("SecurityStore rejects malformed explicit override maps and inherited dangling references", async () => {
	const { store, saved } = createSecurityStoreFixture();
	for (const sessionOverrides of [null, [], { s1: 42 }]) {
		await assert.rejects(store.updateConfig({ levels: store.getConfig().levels, sessionOverrides }),
			{ code: "SECURITY_CONFIG_VALIDATION_FAILED" });
	}
	assert.equal(saved.length, 0);
	const config = createDefaultSecurityConfig();
	config.sessionOverrides.s1 = "already-missing";
	const stale = createSecurityStoreFixture({ config });
	await assert.rejects(stale.store.updateConfig({ levels: config.levels }), { code: "SECURITY_CONFIG_VALIDATION_FAILED" });
	assert.equal(stale.saved.length, 0, "only references to levels actually deleted by this update may be cleaned");
});

test("gate and main reject custom builtin identities even in disabled snapshots", () => {
	for (const enabled of [false, true]) {
		const config = createDefaultSecurityConfig();
		config.enabled = enabled;
		config.levels.push({ ...config.levels[1], id: "custom", builtin: true });
		assert.ok(validateSecurityConfig(config).length > 0);
		assert.equal(gate.validateSnapshotShape(buildSnapshot(config)), null);
		config.levels.at(-1).builtin = false;
		assert.equal(validateSecurityConfig(config).length, 0);
		assert.ok(gate.validateSnapshotShape(buildSnapshot(config)));
	}
});

for (const malformed of ["//outside", "///outside/a", "//server/", "//server//share", "\\\\outside", "\\\\\\outside\\a"]) {
	test(`Windows rejects malformed UNC in input and cwd: ${malformed}`, () => {
		assert.equal(resolvePolicyPath(malformed, "C:/workspace", "win32"), null);
		assert.equal(resolvePolicyPath("file.txt", malformed, "win32"), null);
	});
}

test("Windows valid UNC keeps normalization and relative cwd resolution", () => {
	assert.equal(resolvePolicyPath("//server/share/sub/../file.txt", undefined, "win32"), "\\\\server\\share\\file.txt");
	assert.equal(resolvePolicyPath("sub/file.txt", "//server/share", "win32"), "\\\\server\\share\\sub\\file.txt");
});

for (const platform of ["win32", "linux"]) {
	test(`gate checks ambiguous UNC without changing ${platform} path semantics`, async () => {
		const config = createDefaultSecurityConfig();
		config.enabled = true;
		const level = config.levels.find((entry) => entry.id === "standard");
		level.pathPolicy = "unrestricted";
		level.protectSensitivePaths = false;
		const handlers = new Map();
		const instance = loadTsCommonJs("resources/extensions/pi-deck-security-gate.ts", {
			stubs: { "node:fs": { existsSync: () => true, readFileSync: () => JSON.stringify(buildSnapshot(config)) } },
			globals: { process: { platform, env: { PIDECK_SECURITY_CONFIG: "policy.json" } } },
		});
		instance.default({ on: (name, fn) => handlers.set(name, fn) });
		const call = (path, cwd) => handlers.get("tool_call")({ toolName: "read", input: { path } }, { cwd, hasUI: false });
		for (const path of ["//outside", "///outside/a"]) {
			assert.equal((await call(path, platform === "win32" ? "C:/workspace" : "/workspace"))?.block === true, platform === "win32");
			assert.equal((await call("file.txt", path))?.block === true, platform === "win32");
		}
		assert.equal(await call("//server/share/file.txt", "//server/share"), undefined);
		assert.equal(await call("sub/file.txt", "//server/share"), undefined);
	});
}
