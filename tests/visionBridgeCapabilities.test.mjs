import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// 视觉桥能力快照契约（模型列表 + 视觉桥配置）：
// 1. 只有拿到新数据才算「就绪」，失败降级为空列表/未配置，不阻断会话渲染；
// 2. 任一失效信号（配置修订 / 模型列表修订）都要重取；
// 3. 迟到的旧响应不得覆盖新结果；
// 4. 同一版本键下重复挂载（长列表逐行挂载）只允许发一次请求。
// 这里真实挂载 hook（真实 React + jotai store），只替身化桌面 API。

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");
const { atom } = nodeRequire("jotai/vanilla");

const MODELS_A = [
	{ id: "vision-a", provider: "provider-a", images: true },
	{ id: "text-only", provider: "provider-a", images: false },
];
const CONFIG_A = { enabled: true, provider: "provider-a", model: "vision-a" };

/** 可手动完成端点的桌面 API 替身：每次调用记录一条待决请求。 */
function createDesktopApi() {
	const modelCalls = [];
	const configCalls = [];
	const api = {
		projects: {
			listModels: () =>
				new Promise((resolve, reject) => {
					modelCalls.push({ resolve, reject });
				}),
		},
		config: {
			visionGetConfig: () =>
				new Promise((resolve, reject) => {
					configCalls.push({ resolve, reject });
				}),
		},
	};
	return { api, modelCalls, configCalls };
}

function loadHook(api, revisions) {
	return loadTsCommonJs("src/renderer/src/hooks/useVisionBridgeCapabilities.ts", {
		stubs: {
			"../desktopApi": { desktopApi: api },
			"../atoms/model-atoms": { modelListRevisionAtom: revisions.model },
			"../atoms/session-atoms": { visionConfigRevisionAtom: revisions.config },
		},
	}).useVisionBridgeCapabilities;
}

async function setup(host) {
	const { api, modelCalls, configCalls } = createDesktopApi();
	const revisions = { config: atom(0), model: atom(0) };
	const store = createStore();
	const useHook = loadHook(api, revisions);
	const wrap = (node) => host.React.createElement(Provider, { store }, node);
	const mounted = await host.mount(useHook, undefined, wrap);
	return { modelCalls, configCalls, revisions, store, useHook, mounted, wrap };
}

/** 把两个端点同时落地（Promise.all 需要两者都完成才会写入快照）。 */
async function resolveAll(host, modelCall, configCall, { models = MODELS_A, config = CONFIG_A } = {}) {
	await host.act(async () => {
		modelCall.resolve(models);
		configCall.resolve({ config });
	});
}

test("useVisionBridgeCapabilities loads models and config once and exposes them", async () => {
	await withHookHost(async (host) => {
		const { modelCalls, configCalls, mounted } = await setup(host);
		assert.equal(modelCalls.length, 1, "挂载即拉取模型列表");
		assert.equal(configCalls.length, 1, "挂载即拉取视觉桥配置");
		assert.equal(mounted.result().ready, false, "数据未到位前不算就绪");

		await resolveAll(host, modelCalls[0], configCalls[0]);
		const snapshot = mounted.result();
		assert.equal(snapshot.ready, true);
		assert.deepEqual(snapshot.models, MODELS_A);
		assert.deepEqual(snapshot.config, CONFIG_A);
	});
});

test("useVisionBridgeCapabilities clears stale config when the refetch returns an empty config", async () => {
	await withHookHost(async (host) => {
		const { modelCalls, configCalls, revisions, store, mounted } = await setup(host);
		await resolveAll(host, modelCalls[0], configCalls[0]);
		assert.deepEqual(mounted.result().config, CONFIG_A);

		// 保存/删除视觉桥配置后修订递增触发重取，这次成功但 config 为空
		await host.act(async () => store.set(revisions.config, 1));
		assert.equal(configCalls.length, 2, "配置修订递增必须重新读取");
		await resolveAll(host, modelCalls[1], configCalls[1], { config: null });
		assert.equal(mounted.result().config, null, "成功返回空 config 时必须清掉旧值");
	});
});

test("useVisionBridgeCapabilities refetches when the model list revision is bumped", async () => {
	await withHookHost(async (host) => {
		const { modelCalls, configCalls, revisions, store, mounted } = await setup(host);
		await resolveAll(host, modelCalls[0], configCalls[0]);

		// 主进程重取模型缓存（保存 models.json / 切换 pi 运行时）后广播 models:changed
		await host.act(async () => store.set(revisions.model, 1));
		assert.equal(modelCalls.length, 2, "模型列表修订递增必须重新读取");
		const next = [{ id: "new-model", provider: "provider-b", images: true }];
		await resolveAll(host, modelCalls[1], configCalls[1], { models: next });
		assert.deepEqual(mounted.result().models, next);
	});
});

test("useVisionBridgeCapabilities degrades to empty models when the list request fails", async () => {
	await withHookHost(async (host) => {
		const { modelCalls, configCalls, mounted } = await setup(host);
		await host.act(async () => {
			modelCalls[0].reject(new Error("rpc down"));
			configCalls[0].resolve({ config: CONFIG_A });
		});
		const snapshot = mounted.result();
		assert.equal(snapshot.ready, true, "一侧失败也要给出结论，不能让气泡一直等");
		// 降级用的是模块内的空数组（跨 vm 域原型不同），只比对长度与内容
		assert.equal(snapshot.models.length, 0, "读取失败降级为空列表（能力未知）");
		assert.deepEqual(snapshot.config, CONFIG_A, "另一侧成功结果不受影响");
	});
});

test("useVisionBridgeCapabilities ignores a superseded in-flight response", async () => {
	await withHookHost(async (host) => {
		const { modelCalls, configCalls, revisions, store, mounted } = await setup(host);
		// 首个请求未返回就保存了新配置：旧请求迟到不得覆盖新结果
		await host.act(async () => store.set(revisions.config, 1));
		assert.equal(configCalls.length, 2);

		await resolveAll(host, modelCalls[1], configCalls[1], {
			models: [{ id: "fresh", provider: "p", images: true }],
			config: { enabled: true, provider: "p", model: "fresh" },
		});
		await resolveAll(host, modelCalls[0], configCalls[0]);
		assert.equal(mounted.result().config.model, "fresh");
		assert.equal(mounted.result().models[0].id, "fresh");
	});
});

test("useVisionBridgeCapabilities does not refetch for a remount with the same revisions", async () => {
	await withHookHost(async (host) => {
		const { modelCalls, configCalls, useHook, mounted, wrap } = await setup(host);
		await resolveAll(host, modelCalls[0], configCalls[0]);

		// 长列表逐行挂载同一个 hook：版本键相同的后续挂载直接复用快照
		await mounted.unmount();
		const remounted = await host.mount(useHook, undefined, wrap);
		assert.equal(modelCalls.length, 1, "同一版本键不得重复拉取模型列表");
		assert.equal(configCalls.length, 1, "同一版本键不得重复拉取配置");
		assert.equal(remounted.result().ready, true, "复用已有快照");
	});
});
