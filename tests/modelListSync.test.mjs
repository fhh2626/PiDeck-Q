import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred } from "./helpers/imagePreviewHarness.mjs";

// models:changed 订阅契约（AGENTS.md：注册 listener 的地方必须能在同一模块找到清理路径）：
// 1. 主进程广播一次 → 修订号 +1（驱动视觉桥能力/模型选择器重读列表）；
// 2. 卸载时必须把 transport 的取消订阅交还，否则长会话反复挂载会累积监听。
// 真实挂载 hook（真实 React + jotai store），只替身化桌面 API。

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");
const { atom } = nodeRequire("jotai/vanilla");
const modelAtoms = loadTsCommonJs("src/renderer/src/atoms/model-atoms.ts");

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
					"../atoms/model-atoms": { ...modelAtoms, modelListRevisionAtom: revisionAtom },
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

test("confirmed model deletion clears current, pending, and welcome selections and refreshes settings", async () => {
	await withHookHost(async (host) => {
		let listener;
		let refreshed;
		const removed = { provider: "custom", modelId: "nested/id" };
		const kept = { provider: "other", modelId: "nested/id" };
		const wslRecord = { id: "wsl", environment: "wsl", model: removed };
		const revisionAtom = atom(0);
		const removedAtom = modelAtoms.removedModelReferencesAtom;
		const recordsAtom = atom({ affected: { id: "affected", environment: "native", model: removed }, other: { id: "other", environment: "native", model: kept }, wsl: wslRecord, observed: { id: "observed", environment: "native" } });
		const runtimesAtom = atom({ affected: { state: { ...removed, modelName: "Old" } }, other: { state: kept }, wsl: { state: removed }, observed: { state: removed } });
		const pendingAtom = atom({ affected: { from: kept, to: removed }, wsl: { from: kept, to: removed } });
		const visionAtom = atom({ config: { enabled: true, provider: removed.provider, model: removed.modelId, api: "openai-completions", baseUrl: "https://old.invalid", apiKey: "old-key" }, loadKey: "0:0", ready: true, models: [] });
		const visionSeqAtom = atom(1);
		const store = createStore();
		const values = new Map([["welcome", JSON.stringify({ model: removed })]]);
		const savedSettings = { gitCommitMessageProvider: removed.provider, gitCommitMessageModel: removed.modelId, favoriteModels: [], theme: "dark" };
		const { useModelListSync } = loadTsCommonJs("src/renderer/src/hooks/useModelListSync.ts", {
			globals: { localStorage: { removeItem: (key) => values.delete(key) } },
			stubs: {
				"../desktopApi": { desktopApi: {
					projects: { onModelsChanged: (callback) => { listener = callback; return () => { listener = undefined; }; } },
					settings: { get: async () => savedSettings },
				} },
				"../atoms/model-atoms": { ...modelAtoms, modelListRevisionAtom: revisionAtom },
				"../atoms/session-atoms": { sessionRecordsAtom: recordsAtom, sessionRuntimeByIdAtom: runtimesAtom },
				"../atoms/composer-atoms": { modelPendingByIdAtom: pendingAtom },
				"../atoms/vision-atoms": { visionBridgeCapabilitiesAtom: visionAtom, visionBridgeRequestSeqAtom: visionSeqAtom },
				"../utils/chatSessionBootstrap": { WELCOME_MODEL_KEY: "welcome", readWelcomeModelPreference: () => values.has("welcome") ? JSON.parse(values.get("welcome")) : undefined },
			},
		});
		const mounted = await host.mount(useModelListSync, (update) => { refreshed = update(savedSettings); }, (node) => host.React.createElement(Provider, { store }, node));
		await host.act(async () => { listener({ environment: "native", removedModels: [removed], changedModels: [] }); });
		assert.equal(store.get(recordsAtom).affected.model.modelId, "");
		assert.equal(store.get(recordsAtom).other.model, kept);
		assert.equal(store.get(recordsAtom).wsl, wslRecord, "same identity in the other runtime environment remains selected");
		assert.equal(store.get(recordsAtom).observed.model.modelId, "", "a removed live default becomes an explicit empty catalog choice");
		assert.equal(store.get(runtimesAtom).affected.state.modelId, "");
		assert.equal(store.get(runtimesAtom).other.state, kept);
		assert.equal(store.get(runtimesAtom).wsl.state, removed);
		assert.equal(store.get(pendingAtom).affected, undefined);
		assert.equal(store.get(pendingAtom).wsl.to, removed);
		assert.equal(store.get(visionAtom).config.model, "", "shared vision capabilities are cleared before their async refresh");
		assert.equal(store.get(visionAtom).config.enabled, true);
		for (const field of ["api", "baseUrl", "apiKey"]) assert.equal(field in store.get(visionAtom).config, false);
		assert.equal(store.get(visionSeqAtom), 2, "in-flight vision capability results cannot restore the removed model");
		assert.equal(values.has("welcome"), false);
		assert.equal(refreshed.gitCommitMessageModel, "");
		assert.equal(refreshed.theme, "dark", "unrelated current settings survive invalidation");
		await host.act(async () => { listener({ removedModels: [], changedModels: [removed] }); });
		assert.equal(store.get(removedAtom).length, 0);
		assert.equal(store.get(recordsAtom).affected.model.modelId, "", "restoring availability does not silently reselect a deleted choice");
		await mounted.unmount();
		assert.equal(listener, undefined);
	});
});

test("model removal records stay scoped while switching the active configuration environment", async () => {
	await withHookHost(async (host) => {
		let listener;
		const store = createStore();
		const model = { provider: "custom", modelId: "same" };
		const { useModelListSync } = loadTsCommonJs("src/renderer/src/hooks/useModelListSync.ts", {
			stubs: {
				"../desktopApi": { desktopApi: { projects: { onModelsChanged: (callback) => { listener = callback; return () => {}; } } } },
				"../atoms/model-atoms": modelAtoms,
				"../atoms/session-atoms": { sessionRecordsAtom: atom({}), sessionRuntimeByIdAtom: atom({}) },
				"../atoms/composer-atoms": { modelPendingByIdAtom: atom({}) },
				"../atoms/vision-atoms": { visionBridgeCapabilitiesAtom: atom({ config: null }), visionBridgeRequestSeqAtom: atom(0) },
				"../utils/chatSessionBootstrap": { WELCOME_MODEL_KEY: "welcome", readWelcomeModelPreference: () => undefined },
			},
		});
		const mounted = await host.mount((environment) => useModelListSync(undefined, environment), "wsl",
			(node) => host.React.createElement(Provider, { store }, node));
		await host.act(async () => { listener({ environment: "native", removedModels: [model], changedModels: [] }); });
		assert.equal(store.get(modelAtoms.removedModelReferencesAtom).length, 0);
		assert.deepEqual(Array.from(store.get(modelAtoms.removedModelReferencesByEnvironmentAtom).native), [model]);
		await host.act(async () => { listener({ environment: "wsl", removedModels: [], changedModels: [model] }); });
		assert.deepEqual(Array.from(store.get(modelAtoms.removedModelReferencesByEnvironmentAtom).native), [model]);
		await mounted.rerender("native");
		assert.deepEqual(Array.from(store.get(modelAtoms.removedModelReferencesAtom)), [model]);
		await host.act(async () => { listener({ environment: "native", removedModels: [], changedModels: [model] }); });
		assert.equal(store.get(modelAtoms.removedModelReferencesAtom).length, 0);
	});
});

test("deletion invalidates an initial vision read while capability consumers remount", async () => {
	await withHookHost(async (host) => {
		let listener;
		const modelCalls = [];
		const configCalls = [];
		const removed = { provider: "custom", modelId: "old-vision" };
		const oldConfig = { enabled: true, provider: removed.provider, model: removed.modelId };
		const visionAtoms = loadTsCommonJs("src/renderer/src/atoms/vision-atoms.ts");
		const store = createStore();
		const observedConfigs = [];
		const unsubscribe = store.sub(visionAtoms.visionBridgeCapabilitiesAtom, () => {
			observedConfigs.push(store.get(visionAtoms.visionBridgeCapabilitiesAtom).config);
		});
		const stubs = {
			"../desktopApi": { desktopApi: {
				projects: {
					onModelsChanged: (callback) => { listener = callback; return () => {}; },
					listModels: () => { const request = deferred(); modelCalls.push(request); return request.promise; },
				},
				config: { visionGetConfig: () => { const request = deferred(); configCalls.push(request); return request.promise; } },
			} },
			"../atoms/model-atoms": modelAtoms,
			"../atoms/session-atoms": { sessionRecordsAtom: atom({}), sessionRuntimeByIdAtom: atom({}), visionConfigRevisionAtom: atom(0) },
			"../atoms/composer-atoms": { modelPendingByIdAtom: atom({}) },
			"../atoms/vision-atoms": visionAtoms,
			"../utils/chatSessionBootstrap": { WELCOME_MODEL_KEY: "welcome", readWelcomeModelPreference: () => undefined },
		};
		const { useModelListSync } = loadTsCommonJs("src/renderer/src/hooks/useModelListSync.ts", { stubs });
		const { useVisionBridgeCapabilities } = loadTsCommonJs("src/renderer/src/hooks/useVisionBridgeCapabilities.ts", { stubs });
		function CapabilitiesProbe() { useVisionBridgeCapabilities(); return null; }
		let showCapabilities = true;
		const mounted = await host.mount(useModelListSync, undefined,
			(node) => host.React.createElement(Provider, { store }, node,
				showCapabilities ? host.React.createElement(CapabilitiesProbe) : null));
		assert.equal(store.get(visionAtoms.visionBridgeCapabilitiesAtom).config, null);
		assert.equal(configCalls.length, 1);
		// The shared cache can outlive a pane. Its old request must remain invalid
		// when a deletion arrives between this consumer unmount and the next mount.
		showCapabilities = false;
		await mounted.rerender(undefined);
		await host.act(async () => {
			listener({ environment: "native", removedModels: [removed], changedModels: [] });
			modelCalls[0].resolve([{ provider: removed.provider, id: removed.modelId }]);
			configCalls[0].resolve({ config: oldConfig });
		});
		assert.equal(observedConfigs.some((config) => config?.model === removed.modelId), false,
			"a deleted model must never appear even briefly while the initial request is completing");
		showCapabilities = true;
		await mounted.rerender(undefined);
		assert.equal(configCalls.length, 2, "deletion still starts a fresh capability request");
		const cleared = { enabled: true, provider: "", model: "" };
		await host.act(async () => {
			modelCalls[1].resolve([]);
			configCalls[1].resolve({ config: cleared });
		});
		assert.equal(store.get(visionAtoms.visionBridgeCapabilitiesAtom).config, cleared);
		assert.equal(store.get(visionAtoms.visionBridgeCapabilitiesAtom).ready, true);
		unsubscribe();
	});
});
