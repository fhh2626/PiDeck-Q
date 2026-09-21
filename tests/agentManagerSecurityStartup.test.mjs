import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("AgentManager: awaits ensureSnapshotWritten before starting PiProcess", async () => {
	let snapshotWritten = false;
	let spawnStarted = false;
	let snapshotResolvedBeforeSpawn = false;

	const agentManagerModule = loadTsCommonJs("src/main/pi/AgentManager.ts", {
		stubs: {
			"./PiProcess": {
				PiProcess: class MockPiProcess {
					constructor() {
						spawnStarted = true;
						snapshotResolvedBeforeSpawn = snapshotWritten;
					}
					on() {}
					start() { return Promise.resolve(); }
					stop() { return Promise.resolve(); }
				},
			},
		},
	});

	const { AgentManager } = agentManagerModule;
	const fakeSecurityStore = {
		ensureSnapshotWritten: async () => {
			await new Promise((r) => setTimeout(r, 10));
			snapshotWritten = true;
		},
		getSnapshotPath: () => "/mock/path/snapshot.json",
		getSessionLevelId: () => "standard",
		getConfig: () => ({ enabled: true, defaultLevelId: "standard", levels: [] }),
	};

	const manager = new AgentManager(
		() => undefined, // getProject
		() => {}, // sendToRenderer
		{ get: () => ({ removedBuiltInExtensions: [] }) }, // settingsStore
		{}, // configManager
		undefined, // rpcLogger
		undefined, // appLogger
		undefined, // sessionFileEditor
		() => "", // translate
		undefined, // onBeforeAgentSpawn
		fakeSecurityStore, // securityStore
	);

	// 调用内部 createPiProcess（私有方法在测试中通过反射调用）
	await manager.createPiProcess(process.cwd(), "/path/session.jsonl", "test-session");

	assert.equal(spawnStarted, true, "PiProcess must be instantiated");
	assert.equal(snapshotResolvedBeforeSpawn, true, "ensureSnapshotWritten must be resolved before PiProcess starts");
});

test("AgentManager: fails creation and does not spawn PiProcess if ensureSnapshotWritten rejects", async () => {
	let spawnStarted = false;

	const agentManagerModule = loadTsCommonJs("src/main/pi/AgentManager.ts", {
		stubs: {
			"./PiProcess": {
				PiProcess: class MockPiProcess {
					constructor() {
						spawnStarted = true;
					}
					on() {}
					start() { return Promise.resolve(); }
				},
			},
		},
	});

	const { AgentManager } = agentManagerModule;
	const fakeSecurityStore = {
		ensureSnapshotWritten: async () => {
			throw new Error("Disk write failed");
		},
		getSnapshotPath: () => "/mock/path/snapshot.json",
		getSessionLevelId: () => "standard",
		getConfig: () => ({ enabled: true, defaultLevelId: "standard", levels: [] }),
	};

	const manager = new AgentManager(
		() => undefined,
		() => {},
		{ get: () => ({ removedBuiltInExtensions: [] }) },
		{},
		undefined,
		undefined,
		undefined,
		() => "",
		undefined,
		fakeSecurityStore,
	);

	await assert.rejects(
		async () => {
			await manager.createPiProcess(process.cwd(), "/path/session.jsonl", "test-session");
		},
		/Disk write failed/,
	);

	assert.equal(spawnStarted, false, "PiProcess must not be instantiated if snapshot write rejects");
});
