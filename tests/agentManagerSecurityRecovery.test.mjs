import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createSecurityStoreFixture, deferred } from "./helpers/securityStoreFixture.mjs";

test("AgentManager public create rejects snapshot failure, leaves no runtime and retries the same session", async (t) => {
	const entered = deferred();
	const release = deferred();
	let fail = true;
	const { store } = createSecurityStoreFixture({ writeSnapshot: async () => {
		if (fail) { entered.resolve(); await release.promise; throw new Error("snapshot unavailable"); }
	} });
	const processes = [];
	const sessionPath = join(process.cwd(), "test-session.jsonl");
	class MockPiProcess extends EventEmitter {
		constructor(_cwd, _settings, _unused, options) {
			super();
			this.options = options;
			this.started = false;
			this.client = { request: async ({ type }) => ({ success: true, data: type === "get_state"
				? { sessionId: "pi-session", sessionFile: sessionPath } : { messages: [] } }) };
			processes.push(this);
		}
		async start() { this.started = true; return this.client; }
		getDiagnostics() { return undefined; }
		stop() { this.started = false; this.removeAllListeners(); }
	}
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", { stubs: {
		"./PiProcess": { PiProcess: MockPiProcess },
		"node:fs": { existsSync: () => false, statSync: () => ({ size: 0 }) },
		"node:fs/promises": { stat: async () => ({ size: 0, mtimeMs: 1 }) },
		"./SessionHistoryReader": { SessionHistoryReader: class {
			async getActiveEntryCount() { return 0; }
			async scanCompactions() { return { compactions: [] }; }
		} },
	} });
	const project = { id: "project", path: process.cwd(), name: "Test" };
	const manager = new AgentManager(() => project, () => {},
		{ get: () => ({ rpcTimeout: 100, removedBuiltInExtensions: [] }) },
		{ ensureTrustedDirectory: async () => {} }, undefined, undefined, undefined, () => "", undefined, store);
	t.after(() => manager.stopAll());
	const input = { projectId: project.id, sessionPath, deckSessionId: "catalog-uuid" };
	const first = manager.create(input);
	await entered.promise;
	const second = manager.create(input);
	assert.equal(manager.list().length, 0);
	assert.equal(processes.length, 0);
	const rejections = Promise.all([first, second].map((promise) => assert.rejects(promise, { code: "SECURITY_SNAPSHOT_WRITE_FAILED" })));
	release.resolve();
	await rejections;
	assert.equal(manager.list().length, 0, "failure must not leave a starting/error runtime to be reused");
	assert.equal(processes.length, 0);
	fail = false;
	const tab = await manager.create(input);
	assert.equal(tab.status, "idle");
	assert.equal(manager.list().length, 1);
	assert.equal(processes.length, 1, "same-session in-flight rejection must be cleared for retry");
	assert.equal(processes[0].started, true);
	assert.equal(processes[0].options.securitySessionId, "catalog-uuid");
	assert.equal(processes[0].options.securitySnapshotPath, store.getSnapshotPath());
	await new Promise((resolve) => setImmediate(resolve));
	await manager.stop(tab.id);
	assert.equal(manager.list().length, 0);
	assert.equal(processes[0].started, false);
});
