import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// models:changed 订阅契约（AGENTS.md：注册 listener 的地方必须能在同一模块找到清理路径）：
// 1. 主进程广播一次 → 修订号 +1（驱动视觉桥能力/模型选择器重读列表）；
// 2. 卸载时必须把 transport 的取消订阅交还，否则长会话反复挂载会累积监听。
// 真实挂载 hook（真实 React + jotai store），只替身化桌面 API。

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");
const { atom } = nodeRequire("jotai/vanilla");

test("useModelListSync bumps the revision per event and unsubscribes on unmount", async () => {
	await withHookHost(async (host) => {
		const listeners = new Set();
		let subscribeCount = 0;
		const api = {
			projects: {
				onModelsChanged: (callback) => {
					subscribeCount += 1;
					listeners.add(callback);
					return () => listeners.delete(callback);
				},
			},
		};
		const revisionAtom = atom(0);
		const store = createStore();
		const { useModelListSync } = loadTsCommonJs(
			"src/renderer/src/hooks/useModelListSync.ts",
			{
				stubs: {
					"../desktopApi": { desktopApi: api },
					"../atoms/model-atoms": { modelListRevisionAtom: revisionAtom },
				},
			},
		);
		const wrap = (node) => host.React.createElement(Provider, { store }, node);
		const mounted = await host.mount(useModelListSync, undefined, wrap);

		assert.equal(subscribeCount, 1, "挂载即订阅一次");
		await host.act(async () => {
			for (const listener of [...listeners]) listener();
		});
		assert.equal(store.get(revisionAtom), 1);
		await host.act(async () => {
			for (const listener of [...listeners]) listener();
		});
		assert.equal(store.get(revisionAtom), 2, "每次广播都要让修订号前进");

		await mounted.unmount();
		assert.equal(listeners.size, 0, "卸载必须取消订阅");
	});
});
