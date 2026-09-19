import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function createFakeSettingsStore(initialConfig = {
	enabled: false,
	defaultLevelId: "standard",
	levels: [
		{
			id: "standard",
			name: "Standard",
			description: "",
			toolActions: {},
			denyBashPatterns: [],
			pathPolicy: "unrestricted",
			customAllowDirs: [],
			denyDirs: [],
			protectSensitivePaths: false,
			defaultAction: "allow",
		},
		{
			id: "strict",
			name: "Strict",
			description: "",
			toolActions: {},
			denyBashPatterns: [],
			pathPolicy: "unrestricted",
			customAllowDirs: [],
			denyDirs: [],
			protectSensitivePaths: false,
			defaultAction: "allow",
		},
	],
	sessionOverrides: {},
}) {
	let config = JSON.parse(JSON.stringify(initialConfig));
	return {
		get: () => ({ securityConfig: JSON.parse(JSON.stringify(config)) }),
		update: async (patch) => {
			if (patch.securityConfig) {
				config = JSON.parse(JSON.stringify(patch.securityConfig));
			}
		},
	};
}

test("SecurityStore: write failure throws SecuritySnapshotWriteError and propagates failure without disk assumptions", async () => {
	let writeAttempts = 0;
	const storeModule = loadTsCommonJs("src/main/security/SecurityStore.ts", {
		stubs: {
			"node:fs/promises": {
				mkdir: async () => {},
				writeFile: async () => {
					writeAttempts++;
					throw new Error("ENOSPC: no space left on device");
				},
			},
			"../utils/fsRetry": {
				renameWithRetry: async () => {},
			},
		},
	});

	const { SecurityStore, SecuritySnapshotWriteError } = storeModule;
	const settingsStore = createFakeSettingsStore();
	const store = new SecurityStore({
		settingsStore,
		userDataDir: "/mock/user/data",
		log: () => {},
	});

	await assert.rejects(
		async () => {
			await store.updateConfig({ enabled: true });
		},
		(err) => {
			assert.ok(err instanceof SecuritySnapshotWriteError || err?.code === "SECURITY_SNAPSHOT_WRITE_FAILED");
			assert.equal(err.code, "SECURITY_SNAPSHOT_WRITE_FAILED");
			return true;
		},
		"updateConfig must reject when snapshot write fails",
	);
	assert.equal(writeAttempts, 1);
});

test("SecurityStore: rename failure throws SecuritySnapshotWriteError and propagates failure", async () => {
	const storeModule = loadTsCommonJs("src/main/security/SecurityStore.ts", {
		stubs: {
			"node:fs/promises": {
				mkdir: async () => {},
				writeFile: async () => {},
			},
			"../utils/fsRetry": {
				renameWithRetry: async () => {
					throw new Error("EBUSY: resource locked");
				},
			},
		},
	});

	const { SecurityStore, SecuritySnapshotWriteError } = storeModule;
	const settingsStore = createFakeSettingsStore();
	const store = new SecurityStore({
		settingsStore,
		userDataDir: "/mock/user/data",
		log: () => {},
	});

	await assert.rejects(
		async () => {
			await store.setSessionLevel("session-1", "strict");
		},
		(err) => {
			assert.ok(err instanceof SecuritySnapshotWriteError || err?.code === "SECURITY_SNAPSHOT_WRITE_FAILED");
			assert.equal(err.code, "SECURITY_SNAPSHOT_WRITE_FAILED");
			return true;
		},
	);
});

test("SecurityStore: operations are processed sequentially in FIFO order", async () => {
	const writtenSnapshots = [];
	const storeModule = loadTsCommonJs("src/main/security/SecurityStore.ts", {
		stubs: {
			"node:fs/promises": {
				mkdir: async () => {},
				writeFile: async (_path, content) => {
					writtenSnapshots.push(JSON.parse(content));
				},
			},
			"../utils/fsRetry": {
				renameWithRetry: async () => {},
			},
		},
	});

	const { SecurityStore } = storeModule;
	const settingsStore = createFakeSettingsStore();
	const store = new SecurityStore({
		settingsStore,
		userDataDir: "/mock/user/data",
		log: () => {},
	});

	// 并发触发两个会话设置
	const p1 = store.setSessionLevel("session-1", "strict");
	const p2 = store.setSessionLevel("session-2", "standard");

	const [res1, res2] = await Promise.all([p1, p2]);

	assert.equal(res2.sessionOverrides["session-1"], "strict", "session-1 override must be retained");
	assert.equal(res2.sessionOverrides["session-2"], "standard", "session-2 override must be retained");
	assert.equal(writtenSnapshots.length, 2);
});

test("SecurityStore: mixed queue (updateConfig, setSessionLevel, ensureSnapshotWritten) executes in order", async () => {
	const order = [];
	const storeModule = loadTsCommonJs("src/main/security/SecurityStore.ts", {
		stubs: {
			"node:fs/promises": {
				mkdir: async () => {},
				writeFile: async () => {},
			},
			"../utils/fsRetry": {
				renameWithRetry: async () => {},
			},
		},
	});

	const { SecurityStore } = storeModule;
	const settingsStore = createFakeSettingsStore();
	const store = new SecurityStore({
		settingsStore,
		userDataDir: "/mock/user/data",
		log: () => {},
	});

	const op1 = store.updateConfig({ enabled: true }).then(() => { order.push("updateConfig"); });
	const op2 = store.setSessionLevel("s1", "strict").then(() => { order.push("setSessionLevel"); });
	const op3 = store.ensureSnapshotWritten().then(() => { order.push("ensureSnapshotWritten"); });

	await Promise.all([op1, op2, op3]);
	assert.deepEqual(order, ["updateConfig", "setSessionLevel", "ensureSnapshotWritten"]);
});

test("SecurityStore: queue recovers and continues processing after a failure", async () => {
	let shouldFail = true;
	const storeModule = loadTsCommonJs("src/main/security/SecurityStore.ts", {
		stubs: {
			"node:fs/promises": {
				mkdir: async () => {},
				writeFile: async () => {
					if (shouldFail) throw new Error("Disk full");
				},
			},
			"../utils/fsRetry": {
				renameWithRetry: async () => {},
			},
		},
	});

	const { SecurityStore } = storeModule;
	const settingsStore = createFakeSettingsStore();
	const store = new SecurityStore({
		settingsStore,
		userDataDir: "/mock/user/data",
		log: () => {},
	});

	// 1. 第一次操作失败
	await assert.rejects(async () => {
		await store.setSessionLevel("s1", "strict");
	});

	// 2. 第二次操作应正常执行，不会被队列永远阻塞
	shouldFail = false;
	const res = await store.setSessionLevel("s2", "standard");
	assert.equal(res.sessionOverrides["s2"], "standard");
});

test("SecurityStore: setting nonexistent level throws SecurityConfigValidationError", async () => {
	const storeModule = loadTsCommonJs("src/main/security/SecurityStore.ts", {
		stubs: {
			"node:fs/promises": {
				mkdir: async () => {},
				writeFile: async () => {},
			},
			"../utils/fsRetry": {
				renameWithRetry: async () => {},
			},
		},
	});

	const { SecurityStore, SecurityConfigValidationError } = storeModule;
	const settingsStore = createFakeSettingsStore();
	const store = new SecurityStore({
		settingsStore,
		userDataDir: "/mock/user/data",
		log: () => {},
	});

	await assert.rejects(
		async () => {
			await store.setSessionLevel("s1", "nonexistent-level");
		},
		(err) => {
			assert.ok(err instanceof SecurityConfigValidationError || err?.code === "SECURITY_CONFIG_VALIDATION_FAILED");
			return true;
		},
	);
});
