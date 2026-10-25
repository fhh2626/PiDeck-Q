import assert from "node:assert/strict";
import test from "node:test";
import {
	createFakePiManager,
	loadAgentManagerWithFakePi,
} from "./helpers/l4_agentManagerHarness.mjs";
import { createFakeRouter, runBackendRpcWiring } from "./helpers/l3_ipcHarness.mjs";
import { startCreateBackendHarness } from "./helpers/l4_createBackendHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { ipcChannels } from "../src/shared/ipc.ts";

/**
 * 模型列表缓存的“接线”行为：谁在什么时候让缓存失效 / 刷新 / 预取。
 * 缓存本身的语义见 modelListCacheBehavior.test.mjs；这里用真实的 systemIpc / AgentManager /
 * registerBackendRpc，只把缓存模块换成录制替身，断言触发时机与实参。
 */

// ── 配置保存 → 失效 + 后台重取 ─────────────────────────────────────

function loadSystemIpcWithCacheSpy() {
	const events = [];
	const { registerSystemIpc } = loadTsCommonJs("src/main/ipc/systemIpc.ts", {
		stubs: {
			"../pi/modelListCache": {
				fetchModelList: async () => [],
				getCachedModelList: () => null,
				invalidateModelListCache: () => events.push("invalidate"),
				refreshModelList: (locator, store) => {
					events.push({ refresh: [locator, store] });
					return Promise.resolve([]);
				},
			},
		},
	});
	const router = createFakeRouter();
	const piLocator = { name: "locator" };
	const settingsStore = {
		get: () => ({}),
		update: async (patch) => ({ ...patch }),
	};
	const configManager = {
		saveModelsConfig: async () => ({ ok: true }),
		saveAuthConfig: async () => ({ ok: true }),
	};
	const inert = () => undefined;
	const deps = new Proxy(
		{
			piLocator,
			settingsStore,
			configManager,
			appLogger: { info: inert, warn: inert, error: inert },
			platformApplication: { hideApplicationMenu: inert },
			mainWindowControls: { notifyTitleBarChange: inert },
		},
		{ get: (target, key) => (key in target ? target[key] : inert) },
	);
	registerSystemIpc(router, deps);
	return { router, events, piLocator, settingsStore };
}

function assertInvalidatedThenRefreshed(spy) {
	assert.equal(spy.events.length, 2);
	assert.equal(spy.events[0], "invalidate", "the cache must be invalidated before the refetch is started");
	assert.equal(spy.events[1].refresh[0], spy.piLocator);
	assert.equal(spy.events[1].refresh[1], spy.settingsStore);
}

test("saving models.json invalidates the model cache and refetches in the background", async () => {
	const spy = loadSystemIpcWithCacheSpy();
	await spy.router.invoke(ipcChannels.configSaveModels, { providers: {} });
	assertInvalidatedThenRefreshed(spy);
});

test("saving auth.json invalidates the model cache too (auth decides which models are available)", async () => {
	const spy = loadSystemIpcWithCacheSpy();
	await spy.router.invoke(ipcChannels.configSaveAuth, {});
	assertInvalidatedThenRefreshed(spy);
});

for (const key of ["piRuntimePreference", "piTypescriptPath", "piRustPath", "piBoltPath"]) {
	test(`changing ${key} refreshes the model list (a different Pi runtime may list different models)`, async () => {
		const spy = loadSystemIpcWithCacheSpy();
		await spy.router.invoke(ipcChannels.settingsUpdate, { [key]: "x" });
		assertInvalidatedThenRefreshed(spy);
	});
}

test("unrelated settings changes leave the model cache alone", async () => {
	const spy = loadSystemIpcWithCacheSpy();
	await spy.router.invoke(ipcChannels.settingsUpdate, { closeToTray: true });
	assert.deepEqual(spy.events, []);
});

// ── 每次 spawn 前刷新 ─────────────────────────────────────────────

test("every agent spawn kicks off a model-list refresh before the Pi process is constructed", async () => {
	const harness = loadAgentManagerWithFakePi();
	const manager = createFakePiManager(harness, {
		onBeforeAgentSpawn: () => harness.log.push("refresh-models"),
	});

	await manager.create({ projectId: "p1" });

	const refresh = harness.log.indexOf("refresh-models");
	assert.ok(refresh >= 0, "the pre-spawn hook must run");
	assert.ok(refresh < harness.log.indexOf("construct"), "the refresh must be started before the process exists");
	assert.equal(harness.log.filter((entry) => entry === "refresh-models").length, 1);
});

test("the backend hands the model-list refresh to AgentManager as its pre-spawn hook", async () => {
	// 装配契约：createBackend 把 refreshModelList(piLocator, settingsStore) 注入 AgentManager 的 onBeforeAgentSpawn。
	const refreshes = [];
	const harness = await startCreateBackendHarness({
		refreshModelList: (...args) => {
			refreshes.push(args);
			return Promise.resolve([]);
		},
	});
	try {
		const hook = harness.agentManagerArgs[0][8];
		assert.equal(typeof hook, "function");
		const before = refreshes.length;
		hook();
		assert.equal(refreshes.length, before + 1);
		assert.equal(refreshes.at(-1).length, 2, "refreshModelList receives (piLocator, settingsStore)");
	} finally {
		await harness.dispose();
	}
});

// ── 启动预取 ───────────────────────────────────────────────────────

test("startup prefetches the model list once when nothing is cached yet", () => {
	const timers = [];
	const fetches = [];
	const run = (cached) => {
		fetches.length = 0;
		runBackendRpcWiring({
			modelListCache: {
				fetchModelList: (locator, store) => {
					fetches.push([locator, store]);
					return Promise.resolve([]);
				},
				getCachedModelList: () => cached,
			},
			timers,
		});
		for (const fire of timers.splice(0)) fire();
		return fetches.slice();
	};

	const cold = run(null);
	assert.equal(cold.length, 1);
	assert.equal(cold[0][0].__name, "piLocator");
	assert.equal(cold[0][1].__name, "settingsStore");
	assert.deepEqual(run([{ id: "cached" }]), [], "a warm cache must not trigger another prefetch");
});

// ── setModel：模型不在运行中进程的快照里 ───────────────────────────

function createModelManager({ requestResponse, modelsConfig }) {
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
	const manager = new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({}) },
		{ getModelsConfig: modelsConfig },
	);
	manager.agents.set("a1", {
		tab: { id: "a1", projectId: "p1", cwd: "/p", title: "t", status: "idle", createdAt: 1 },
		process: { client: { request: async () => requestResponse }, isRunning: () => true },
	});
	manager.getRuntimeState = async () => ({ ok: true });
	return manager;
}

const NOT_FOUND = { success: false, error: "Model not found: acme/fast" };
const localModels = (providers) => async () => ({ parsed: { providers } });

test("setModel asks for a restart when Pi does not know a model that models.json already has", async () => {
	const manager = createModelManager({
		requestResponse: NOT_FOUND,
		modelsConfig: localModels({ acme: { models: [{ id: "fast" }] } }),
	});

	await assert.rejects(manager.setModel("a1", "acme", "fast"), (error) => {
		assert.equal(error.needsRestart, true);
		assert.match(error.message, /Model not found/);
		return true;
	});
});

test("setModel reports a plain error when the model is genuinely unknown", async () => {
	const manager = createModelManager({
		requestResponse: NOT_FOUND,
		modelsConfig: localModels({ acme: { models: [{ id: "other" }] } }),
	});

	await assert.rejects(manager.setModel("a1", "acme", "fast"), (error) => {
		assert.equal(error.needsRestart, undefined);
		assert.match(error.message, /Model not found/);
		return true;
	});
});

test("setModel does not claim a restart is needed when models.json cannot be read", async () => {
	const manager = createModelManager({
		requestResponse: NOT_FOUND,
		modelsConfig: async () => { throw new Error("EACCES"); },
	});

	await assert.rejects(manager.setModel("a1", "acme", "fast"), (error) => {
		assert.equal(error.needsRestart, undefined);
		return true;
	});
});

test("setModel does not turn other failures into restart prompts", async () => {
	const manager = createModelManager({
		requestResponse: { success: false, error: "rate limited" },
		modelsConfig: localModels({ acme: { models: [{ id: "fast" }] } }),
	});

	await assert.rejects(manager.setModel("a1", "acme", "fast"), (error) => {
		assert.equal(error.needsRestart, undefined);
		assert.equal(error.message, "rate limited");
		return true;
	});
});

test("setModel returns the new runtime state on success", async () => {
	const manager = createModelManager({ requestResponse: { success: true, data: {} }, modelsConfig: localModels({}) });
	assert.deepEqual({ ...(await manager.setModel("a1", "acme", "fast")) }, { ok: true });
});