import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// Vision 桥配置刷新契约（Review P2）：
// visionGetConfig 成功但 config 为空（配置被删除/失效）时必须清掉 stale 值；
// 只有成功且非空才 setConfig(res.config) 的旧写法会让已挂载 Composer 永远用旧配置。
// 这里真实挂载 hook（真实 React + jotai store），只替身化桌面 API。

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");
const { atom } = nodeRequire("jotai/vanilla");

/** 可手动完成的 visionGetConfig 替身：每次调用记录一条待决请求。 */
function createVisionApi() {
	const calls = [];
	return {
		calls,
		api: {
			config: {
				visionGetConfig: () =>
					new Promise((resolve, reject) => {
						calls.push({ resolve, reject });
					}),
			},
		},
	};
}

function loadHook(api, revisionAtom) {
	return loadTsCommonJs("src/renderer/src/hooks/useVisionBridgeConfig.ts", {
		stubs: {
			"../desktopApi": { desktopApi: api },
			"../atoms/session-atoms": { visionConfigRevisionAtom: revisionAtom },
		},
	}).useVisionBridgeConfig;
}

async function setup(host) {
	const { calls, api } = createVisionApi();
	const revisionAtom = atom(0);
	const store = createStore();
	const useHook = loadHook(api, revisionAtom);
	const wrap = (node) => host.React.createElement(Provider, { store }, node);
	const mounted = await host.mount(useHook, undefined, wrap);
	return { calls, store, revisionAtom, mounted, wrap };
}

const CONFIG_A = { enabled: true, modelId: "vision-a" };

test("useVisionBridgeConfig clears stale config when fetch resolves with an empty config", async () => {
	await withHookHost(async (host) => {
		const { calls, store, revisionAtom, mounted } = await setup(host);
		await host.act(async () => calls[0].resolve({ config: CONFIG_A }));
		assert.deepEqual(mounted.result(), CONFIG_A);

		// 保存/删除配置后 revision 递增触发重取，这次成功返回但 config 为空
		await host.act(async () => store.set(revisionAtom, 1));
		assert.equal(calls.length, 2);
		await host.act(async () => calls[1].resolve({ config: null }));
		assert.equal(mounted.result(), null, "成功返回空 config 时必须清掉旧值");
	});
});

test("useVisionBridgeConfig clears stale config when the refetch resolves with no response", async () => {
	await withHookHost(async (host) => {
		const { calls, store, revisionAtom, mounted } = await setup(host);
		await host.act(async () => calls[0].resolve({ config: CONFIG_A }));
		await host.act(async () => store.set(revisionAtom, 1));
		await host.act(async () => calls[1].resolve(undefined));
		assert.equal(mounted.result(), null);
	});
});

test("useVisionBridgeConfig clears stale config when the refetch fails", async () => {
	await withHookHost(async (host) => {
		const { calls, store, revisionAtom, mounted } = await setup(host);
		await host.act(async () => calls[0].resolve({ config: CONFIG_A }));
		assert.deepEqual(mounted.result(), CONFIG_A);
		await host.act(async () => store.set(revisionAtom, 1));
		await host.act(async () => calls[1].reject(new Error("rpc down")));
		assert.equal(mounted.result(), null);
	});
});

test("useVisionBridgeConfig refetches when the config revision is bumped", async () => {
	await withHookHost(async (host) => {
		const { calls, store, revisionAtom, mounted } = await setup(host);
		assert.equal(calls.length, 1);
		await host.act(async () => calls[0].resolve({ config: CONFIG_A }));
		await host.act(async () => store.set(revisionAtom, 1));
		assert.equal(calls.length, 2, "revision 递增必须触发重新读取");
		const next = { enabled: true, modelId: "vision-b" };
		await host.act(async () => calls[1].resolve({ config: next }));
		assert.deepEqual(mounted.result(), next);
	});
});

test("useVisionBridgeConfig ignores a superseded in-flight response", async () => {
	await withHookHost(async (host) => {
		const { calls, store, revisionAtom, mounted } = await setup(host);
		await host.act(async () => store.set(revisionAtom, 1));
		assert.equal(calls.length, 2);
		await host.act(async () => calls[1].resolve({ config: { enabled: true, modelId: "fresh" } }));
		// 旧请求迟到：不得覆盖新结果
		await host.act(async () => calls[0].resolve({ config: CONFIG_A }));
		assert.equal(mounted.result().modelId, "fresh");
	});
});
