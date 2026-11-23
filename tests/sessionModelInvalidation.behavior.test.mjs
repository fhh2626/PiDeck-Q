import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred } from "./helpers/imagePreviewHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, atom, createStore } = nodeRequire("jotai");
const selected = { provider: "custom", modelId: "removed/model" };

for (const readded of [false, true]) {
test(`a catalog refresh started before deletion cannot restore the model${readded ? " after it is added back" : " when it completes"}`, async () => {
	await withHookHost(async (host) => {
		const modelAtoms = host.load("src/renderer/src/atoms/model-atoms.ts");
		const sessions = host.load("src/renderer/src/atoms/session-atoms.ts", {
			stubs: { "./model-atoms": modelAtoms },
		});
		const store = createStore();
		const record = { id: "session", projectId: "project", environment: "native", source: "pi", title: "Session", preview: "", messageCount: 0, status: "draft", createdAt: 1, updatedAt: 1, model: selected };
		store.set(sessions.replaceProjectSessionsAtom, { projectId: "project", sessions: [record] });
		const pending = deferred();
		let listener;
		const api = {
			projects: { list: async () => [], onModelsChanged: (callback) => { listener = callback; return () => {}; } },
			git: { branches: async () => ({ current: null, branches: [] }), worktreeList: async () => [] },
			sessions: { listCatalog: () => pending.promise },
			files: { list: async () => [] },
		};
		const { useModelListSync } = host.load("src/renderer/src/hooks/useModelListSync.ts", {
			stubs: {
				"../desktopApi": { desktopApi: api },
				"../atoms/model-atoms": modelAtoms,
				"../atoms/session-atoms": sessions,
				"../atoms/composer-atoms": { modelPendingByIdAtom: atom({}) },
				"../atoms/vision-atoms": { visionBridgeCapabilitiesAtom: atom({ config: null }), visionBridgeRequestSeqAtom: atom(0) },
				"../utils/chatSessionBootstrap": { readWelcomeModelPreference: () => undefined },
			},
		});
		const { useProjectSync } = host.load("src/renderer/src/hooks/useProjectSync.ts");
		const input = {
			projects: [], activeProjectId: undefined, setProjects() {}, setActiveProjectId() {}, showToast() {}, t: (key) => key,
			api, replaceProjectSessions: (value) => store.set(sessions.replaceProjectSessionsAtom, value),
			captureModelConfigurationVersions: () => store.get(modelAtoms.modelConfigurationVersionsByScopeAtom),
		};
		const mounted = await host.mount(() => { useModelListSync(); return useProjectSync(input); }, undefined,
			(node) => host.React.createElement(Provider, { store }, node));
		let refreshing;
		await host.act(async () => { refreshing = mounted.result().refreshProjectSessions("project", true); });
		await host.act(async () => listener({ environment: "native", removedModels: [selected], changedModels: [] }));
		assert.equal(store.get(sessions.sessionRecordsAtom).session.model.modelId, "");
		if (readded) await host.act(async () => listener({ environment: "native", removedModels: [], changedModels: [selected] }));
		await host.act(async () => { pending.resolve([record]); await refreshing; });
		assert.equal(store.get(sessions.sessionRecordsAtom).session.model.modelId, "");
	});
});
}
