import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createSecurityStoreFixture } from "./helpers/securityStoreFixture.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { createPiDesktopApi } = loadTsCommonJs("src/shared/desktop/createPiDesktopApi.ts");

function setup(options = {}) {
	const fixture = createSecurityStoreFixture(options);
	// Use the SAME class objects as the real store, not two isolated loader graphs.
	const { registerSecurityIpc } = loadTsCommonJs("src/main/ipc/securityIpc.ts", {
		stubs: { "../security/SecurityStore": fixture.module },
	});
	const handlers = new Map();
	registerSecurityIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
		securityStore: fixture.store, log: () => {},
	});
	return { ...fixture, invoke: (channel, ...args) => handlers.get(channel)(...args) };
}

for (const patch of [{ levels: [null] }, { sessionOverrides: { s1: "missing" } }, { sessionOverrides: null }, { sessionOverrides: [] }, { sessionOverrides: { s1: 42 } }]) {
	test(`securityIpc classifies malformed update without mutations: ${JSON.stringify(patch)}`, async () => {
		const { invoke, saved, snapshots } = setup();
		const result = await invoke(ipcChannels.securityUpdateConfig, patch);
		assert.equal(result.ok, false);
		assert.equal(result.code, "VALIDATION_FAILED");
		assert.equal(saved.length, 0);
		assert.equal(snapshots.length, 0);
	});
}

test("securityIpc propagates in-queue validation after initially valid level passes IPC precheck", async () => {
	const { store, invoke, saved } = setup();
	const config = store.getConfig();
	await store.updateConfig({ levels: [...config.levels, { ...config.levels[1], id: "custom", builtin: false }], sessionOverrides: { s1: "strict" } });
	const removal = store.updateConfig({ levels: config.levels });
	const request = invoke(ipcChannels.securitySetSessionLevel, "s1", "custom");
	await removal;
	const result = await request;
	assert.equal(result.code, "VALIDATION_FAILED");
	assert.equal(store.getConfig().sessionOverrides.s1, "strict");
	assert.equal(saved.length, 2);
});

for (const operation of ["update", "session"]) {
	for (const failure of ["snapshot", "settings"]) {
		test(`securityIpc ${operation} classifies real ${failure} failure`, async () => {
			const fail = async () => { throw new Error("disk unavailable"); };
			const { invoke } = setup(failure === "snapshot" ? { writeSnapshot: fail } : { saveSettings: fail });
			const result = operation === "update"
				? await invoke(ipcChannels.securityUpdateConfig, { enabled: true })
				: await invoke(ipcChannels.securitySetSessionLevel, "s1", "strict");
			assert.equal(result.ok, false);
			assert.equal(result.code, failure === "snapshot" ? "SNAPSHOT_WRITE_FAILED" : "UNKNOWN_ERROR");
			assert.match(result.error, /disk unavailable/);
		});
	}
}

test("securityIpc successful update, session override and explicit clearing retain result contract", async () => {
	const { invoke } = setup();
	const update = await invoke(ipcChannels.securityUpdateConfig, { enabled: true });
	assert.equal(update.ok, true);
	assert.equal(update.config.enabled, true);
	const pick = await invoke(ipcChannels.securitySetSessionLevel, "s1", "strict");
	assert.equal(pick.ok, true);
	assert.equal(pick.config.sessionOverrides.s1, "strict");
	const clear = await invoke(ipcChannels.securitySetSessionLevel, "s1", null);
	assert.equal(clear.ok, true);
	assert.equal(clear.config.sessionOverrides.s1, undefined);
});

test("securityIpc recognizes same-graph error identity and explicit foreign structured error", async () => {
	const { invoke, store, module } = setup();
	const error = new module.SecuritySnapshotWriteError("same graph");
	Object.defineProperty(error, "code", { value: undefined }); // force instanceof, not the fallback
	store.updateConfig = async () => { throw error; };
	assert.equal((await invoke(ipcChannels.securityUpdateConfig, {})).code, "SNAPSHOT_WRITE_FAILED");
	const validation = new module.SecurityConfigValidationError("same graph");
	Object.defineProperty(validation, "code", { value: undefined });
	store.setSessionLevel = async () => { throw validation; };
	assert.equal((await invoke(ipcChannels.securitySetSessionLevel, "s1", "strict")).code, "VALIDATION_FAILED");
	store.updateConfig = async () => { throw { code: "SECURITY_SNAPSHOT_WRITE_FAILED" }; };
	assert.equal((await invoke(ipcChannels.securityUpdateConfig, {})).code, "SNAPSHOT_WRITE_FAILED");
});

test("createPiDesktopApi security transport preserves arguments, successes and all failure codes", async () => {
	const calls = [];
	let response;
	const api = createPiDesktopApi({ invoke: async (channel, ...args) => { calls.push({ channel, args }); return response; }, on: () => () => {} }, {});
	const config = createSecurityStoreFixture().store.getConfig();
	response = config;
	assert.equal(await api.security.getConfig(), config);
	assert.deepEqual(calls.at(-1), { channel: ipcChannels.securityGetConfig, args: [] });
	for (const result of [{ ok: true, config }, ...["VALIDATION_FAILED", "SNAPSHOT_WRITE_FAILED", "UNKNOWN_ERROR"].map((code) => ({ ok: false, code, error: "failure" }))]) {
		response = result;
		const patch = { enabled: true };
		assert.equal(await api.security.updateConfig(patch), result);
		assert.deepEqual(calls.at(-1), { channel: ipcChannels.securityUpdateConfig, args: [patch] });
		for (const level of ["strict", null]) {
			assert.equal(await api.security.setSessionLevel("s1", level), result);
			assert.deepEqual(calls.at(-1), { channel: ipcChannels.securitySetSessionLevel, args: ["s1", level] });
		}
	}
});
