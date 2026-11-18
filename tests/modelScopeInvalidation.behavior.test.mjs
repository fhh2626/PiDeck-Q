import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, atom, createStore } = nodeRequire("jotai");
const removed = { provider: "custom", modelId: "same/id" };

test("WSL model removal clears only the matching distro and case-sensitive user", async () => {
	await withHookHost(async (host) => {
		const store = createStore();
		const modelAtoms = host.load("src/renderer/src/atoms/model-atoms.ts");
		const records = {
			matching: { id: "matching", environment: "wsl", wslDistro: " Ubuntu ", wslUser: " alice ", model: removed },
			distro: { id: "distro", environment: "wsl", wslDistro: "Debian", wslUser: "alice", model: removed },
			user: { id: "user", environment: "wsl", wslDistro: "Ubuntu", wslUser: "Alice", model: removed },
			legacy: { id: "legacy", environment: "wsl", model: removed },
			native: { id: "native", environment: "native", model: removed },
		};
		const recordsAtom = atom(records);
		const runtimesAtom = atom(Object.fromEntries(Object.keys(records).map((id) => [id, { state: { ...removed } }])));
		const pendingAtom = atom(Object.fromEntries(Object.keys(records).map((id) => [id, { from: { provider: "other", modelId: "source" }, to: removed }])));
		let listener;
		const { useModelListSync } = host.load("src/renderer/src/hooks/useModelListSync.ts", {
			stubs: {
				"../desktopApi": { desktopApi: { projects: { onModelsChanged: (callback) => { listener = callback; return () => {}; } } } },
				"../atoms/model-atoms": modelAtoms,
				"../atoms/session-atoms": { sessionRecordsAtom: recordsAtom, sessionRuntimeByIdAtom: runtimesAtom },
				"../atoms/composer-atoms": { modelPendingByIdAtom: pendingAtom },
				"../atoms/vision-atoms": { visionBridgeCapabilitiesAtom: atom({ config: null }), visionBridgeRequestSeqAtom: atom(0) },
				"../utils/chatSessionBootstrap": { readWelcomeModelPreference: () => undefined },
			},
		});
		await host.mount(() => useModelListSync(undefined, "wsl", { wslDistro: "Ubuntu", wslUser: "alice" }), undefined,
			(node) => host.React.createElement(Provider, { store }, node));
		await host.act(async () => listener({ environment: "wsl", wslDistro: "ubuntu", wslUser: "alice", removedModels: [removed], changedModels: [] }));
		assert.equal(store.get(recordsAtom).matching.model.modelId, "");
		assert.equal(store.get(runtimesAtom).matching.state.modelId, "");
		assert.equal(store.get(pendingAtom).matching, undefined);
		for (const id of ["distro", "user", "legacy", "native"]) {
			assert.equal(store.get(recordsAtom)[id].model.modelId, removed.modelId, `${id} catalog choice remains valid`);
			assert.equal(store.get(runtimesAtom)[id].state.modelId, removed.modelId, `${id} runtime choice remains valid`);
			assert.equal(store.get(pendingAtom)[id].to.modelId, removed.modelId, `${id} pending choice remains valid`);
		}
	});
});
