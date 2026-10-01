import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionRecordService } = loadTsCommonJs("src/main/sessions/SessionRecordService.ts");

function createService({ entries, busy = [], agents = [], messages = [] }) {
	const calls = { deleted: [], refreshed: [], renamedFiles: [], renamedRuntime: [] };
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const service = new SessionRecordService({
		sessionCatalog: {
			get: (id) => byId.get(id),
			listEntries: () => [...byId.values()],
			remove: async (id) => byId.delete(id),
			update: async (id, patch) => ({ ...byId.get(id), ...patch }),
		},
		sessionScanner: {
			delete: async (path) => { calls.deleted.push(path); },
			rename: async (path, title) => { calls.renamedFiles.push([path, title]); },
			archive: async (path) => `${path}.archived`,
			readSessionRawText: async () => "raw",
		},
		readDisplayMessages: async () => messages,
		sessionRuntimeCoordinator: {
			getTarget: (id) => (busy.includes(id) ? { sessionId: id, agentId: "a1", runtimeGeneration: 1 } : undefined),
			isActivating: () => false,
			renameRuntime: async (target, title) => { calls.renamedRuntime.push([target.sessionId, title]); return { ok: true, value: target }; },
		},
		listAgents: () => agents,
		isAnonymousActivating: () => false,
		notifyCatalogRefreshed: (projectId) => calls.refreshed.push(projectId),
		toCommandError: (error) => new Error(error.code),
		mainCopy: (key) => key,
		logger: { info: () => {}, error: () => {} },
	});
	return { service, calls };
}

const parent = { id: "p", projectId: "proj", title: "P", filePath: "C:\\s\\p.jsonl", environment: "native" };
const child = { id: "c", projectId: "proj", title: "C", filePath: "C:\\s\\p\\run\\c.jsonl", environment: "native" };

test("delete removes the file, then broadcasts a refresh for the project", async () => {
	const { service, calls } = createService({ entries: [parent] });
	assert.equal(await service.delete("p"), true);
	assert.equal(JSON.stringify(calls.deleted), JSON.stringify([parent.filePath]));
	assert.equal(JSON.stringify(calls.refreshed), JSON.stringify(["proj"]));
});

test("a running child session blocks deleting its parent and nothing is moved", async () => {
	const { service, calls } = createService({ entries: [parent, child], busy: ["c"] });
	await assert.rejects(() => service.delete("p"), (error) => error.code === "SESSION_DELETE_BLOCKED");
	assert.equal(calls.deleted.length, 0);
});

test("rename without a runtime rewrites the file and broadcasts", async () => {
	const { service, calls } = createService({ entries: [parent] });
	await service.update("p", { title: "New" });
	assert.equal(calls.renamedFiles.length, 1);
	assert.equal(calls.refreshed.length, 1);
});

test("rename with a runtime goes through pi and never touches the file", async () => {
	const { service, calls } = createService({ entries: [parent], busy: ["p"] });
	await service.update("p", { title: "New" });
	assert.equal(calls.renamedRuntime.length, 1);
	assert.equal(calls.renamedFiles.length, 0);
});

test("readMessages strips tool result payloads before delivery", async () => {
	const { service } = createService({
		entries: [parent],
		messages: [
			{ id: "t1", role: "tool", text: "compact", timestamp: 1, meta: { result: { huge: "x".repeat(100) } } },
			{ id: "u1", role: "user", text: "hi", timestamp: 2 },
		],
	});
	const messages = await service.readMessages("p");
	assert.equal(messages.length, 2);
	// 工具结果的原始大对象只留给主进程「查看完整输出」，不得随消息下发。
	assert.equal(messages[0].meta?.result, undefined);
	assert.equal(messages[0].text, "compact");
});

test("readMessages on an unknown session returns an empty list", async () => {
	const { service } = createService({ entries: [] });
	assert.equal((await service.readMessages("ghost")).length, 0);
});
