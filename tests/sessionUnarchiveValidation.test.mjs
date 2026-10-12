import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 捕获 router.handle 注册的 handler，供测试直接调用。 */
function createFakeRouter() {
	const handlers = new Map();
	return {
		router: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
		invoke: (channel, ...args) => {
			const handler = handlers.get(channel);
			if (!handler) throw new Error(`no handler registered for ${channel}`);
			return handler(...args);
		},
	};
}

function loadSessionIpc() {
	return loadTsCommonJs("src/main/ipc/sessionIpc.ts");
}

/** 只提供 unarchive handler 需要的依赖；handler 未触发时不读其余字段。 */
function registerUnarchive({ unarchive }) {
	const { registerSessionIpc } = loadSessionIpc();
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const fake = createFakeRouter();
	registerSessionIpc(fake.router, {
		sessionScanner: { unarchive },
		sessionCatalog: { get: () => undefined, listEntries: () => [] },
		sessionRuntimeCoordinator: { getTarget: () => undefined, isActivating: () => false },
		agentManager: { list: () => [] },
		appLogger: { info: () => {}, error: () => {}, warn: () => {} },
		mainCopy: (key) => key,
		sendToRenderer: () => {},
	});
	return { invoke: fake.invoke, channels: ipcChannels };
}

test("unarchive rejects a JSONL path that is not inside a .pideck-archive directory", async () => {
	let unarchiveCalled = false;
	const { invoke, channels } = registerUnarchive({
		unarchive: async (path) => {
			unarchiveCalled = true;
			return path;
		},
	});

	await assert.rejects(
		() => invoke(channels.sessionsCatalogUnarchive, "C:\\x\\a.jsonl"),
		/session\.invalidArchivePath/,
	);
	// 校验必须在触碰文件系统之前完成
	assert.equal(unarchiveCalled, false, "非法归档路径不得进入扫描器");
});

test("unarchive accepts a path inside .pideck-archive and defers to the index", async () => {
	const seen = [];
	const { invoke, channels } = registerUnarchive({
		unarchive: async (path) => {
			seen.push(path);
			// 与真实实现一致：索引里没有该条记录时抛「找不到」
			throw new Error("归档索引中找不到该会话");
		},
	});

	await assert.rejects(
		() => invoke(channels.sessionsCatalogUnarchive, "C:\\x\\.pideck-archive\\a.jsonl"),
		/归档索引中找不到该会话/,
	);
	assert.deepEqual(seen, ["C:\\x\\.pideck-archive\\a.jsonl"]);
});

test("unarchive accepts WSL-style separators inside the archive directory", async () => {
	const seen = [];
	const { invoke, channels } = registerUnarchive({
		unarchive: async (path) => {
			seen.push(path);
			return path;
		},
	});

	await invoke(channels.sessionsCatalogUnarchive, "/home/u/.pi/agent/sessions/.pideck-archive/a.jsonl");
	assert.deepEqual(seen, ["/home/u/.pi/agent/sessions/.pideck-archive/a.jsonl"]);
});

test("unarchive still rejects non-jsonl input", async () => {
	const { invoke, channels } = registerUnarchive({ unarchive: async () => "x" });
	await assert.rejects(
		() => invoke(channels.sessionsCatalogUnarchive, "C:\\x\\.pideck-archive\\a.txt"),
		/session\.invalidArchivePath/,
	);
});
