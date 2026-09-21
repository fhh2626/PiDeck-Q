import assert from "node:assert/strict";
import test from "node:test";
import { createSecurityStoreFixture, deferred } from "./helpers/securityStoreFixture.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("SecurityStore queued removal invalidates a pending level request without clearing another override", async () => {
	const { store, snapshots } = createSecurityStoreFixture();
	const config = store.getConfig();
	const custom = { ...config.levels[1], id: "custom", builtin: false };
	await store.updateConfig({ levels: [...config.levels, custom], sessionOverrides: { s1: "strict", s2: "custom" } });
	const remove = store.updateConfig({ levels: config.levels });
	const set = store.setSessionLevel("s1", "custom");
	const rejected = assert.rejects(set, { code: "SECURITY_CONFIG_VALIDATION_FAILED" });
	await remove;
	await rejected;
	assert.equal(store.getConfig().sessionOverrides.s1, "strict");
	assert.equal(store.getConfig().sessionOverrides.s2, undefined);
	assert.equal(snapshots.length, 2, "rejected request must not publish a snapshot");
	await store.ensureSnapshotWritten();
	assert.deepEqual(snapshots.at(-1).sessionLevels, { s1: "strict" });
});

test("SecurityStore serializes writes and startup barrier publishes the latest queued state", async () => {
	const started = deferred();
	const release = deferred();
	let active = 0;
	let maximum = 0;
	let writes = 0;
	const { store, saved, snapshots } = createSecurityStoreFixture({ writeSnapshot: async () => {
		maximum = Math.max(maximum, ++active);
		if (++writes === 1) { started.resolve(); await release.promise; }
		active--;
	} });
	const first = store.updateConfig({ enabled: true });
	await started.promise;
	const second = store.setSessionLevel("s1", "strict");
	let barrierDone = false;
	const barrier = store.ensureSnapshotWritten().then(() => { barrierDone = true; });
	await tick();
	assert.equal(saved.length, 1);
	assert.equal(writes, 1);
	assert.equal(barrierDone, false);
	release.resolve();
	await Promise.all([first, second, barrier]);
	assert.equal(maximum, 1);
	assert.equal(snapshots.length, 3);
	assert.equal(snapshots[0].enabled, true);
	assert.deepEqual(snapshots[0].sessionLevels, {});
	assert.deepEqual(snapshots[1].sessionLevels, { s1: "strict" });
	assert.deepEqual(snapshots[2], snapshots[1]);
});

test("SecurityStore unconfirmed save remains observable and a later barrier republishes it", async () => {
	let fail = true;
	let published;
	const { store } = createSecurityStoreFixture({ writeSnapshot: async (snapshot) => {
		if (fail) throw new Error("disk full");
		published = snapshot;
	} });
	await assert.rejects(store.updateConfig({ enabled: true }), { code: "SECURITY_SNAPSHOT_WRITE_FAILED" });
	assert.equal(store.getConfig().enabled, true, "settings persist before snapshot publication; this is not rollback");
	assert.equal(published, undefined);
	fail = false;
	await store.ensureSnapshotWritten();
	assert.equal(published.enabled, true);
});
