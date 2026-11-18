import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred } from "./helpers/imagePreviewHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore, atom } = nodeRequire("jotai");
const missing = { enabled: true, provider: "", model: "", promptTemplate: "saved prompt" };
const replacement = { provider: "new-provider", model: "new-model" };

/** Real React hooks share the same production state while IPC completion remains controllable. */
async function setup(host, { api, withCapabilities = false, withModelSync = false } = {}) {
	const store = createStore();
	const models = host.load("src/renderer/src/atoms/model-atoms.ts");
	const vision = host.load("src/renderer/src/atoms/vision-atoms.ts");
	const revision = atom(0);
	let onModelsChanged;
	const baseApi = api ?? { config: { visionGetConfig: async () => ({ config: { ...missing }, configDir: "/config" }), visionSaveConfig: async () => ({ ok: true }) } };
	const desktopApi = { ...baseApi, projects: { ...baseApi.projects, onModelsChanged: (listener) => {
		onModelsChanged = listener;
		return () => { onModelsChanged = undefined; };
	} } };
	store.set(vision.visionBridgeCapabilitiesAtom, { ready: true, models: [], config: { ...missing }, loadKey: "previous" });
	const { useVisionBridgeDraft } = host.load("src/renderer/src/components/app/settings/visionDraft.ts", {
		stubs: {
			"../../../desktopApi": { desktopApi },
			"../../../atoms/model-atoms": models,
			"../../../atoms/vision-atoms": vision,
			"../../../atoms/session-atoms": { visionConfigRevisionAtom: revision },
			"../../../i18n": { t: (key) => key },
			"../../../utils/notice": { showNotice() {} },
		},
	});
	const { useVisionBridgeCapabilities } = host.load("src/renderer/src/hooks/useVisionBridgeCapabilities.ts", {
		stubs: { "../desktopApi": { desktopApi }, "../atoms/model-atoms": models,
			"../atoms/vision-atoms": vision, "../atoms/session-atoms": { visionConfigRevisionAtom: revision } },
	});
	const { useModelListSync } = host.load("src/renderer/src/hooks/useModelListSync.ts", {
		stubs: {
			"../desktopApi": { desktopApi }, "../atoms/model-atoms": models, "../atoms/vision-atoms": vision,
			"../atoms/session-atoms": { sessionRecordsAtom: atom({}), sessionRuntimeByIdAtom: atom({}) },
			"../atoms/composer-atoms": { modelPendingByIdAtom: atom({}) },
		},
	});
	const hook = () => {
		if (withModelSync) useModelListSync();
		const draft = useVisionBridgeDraft();
		if (withCapabilities) useVisionBridgeCapabilities();
		return draft;
	};
	const mounted = await host.mount(hook, undefined, (node) => host.React.createElement(Provider, { store }, node));
	return { store, models, vision, mounted, modelsChanged: (change) => onModelsChanged(change),
		remount: () => host.mount(hook, undefined, (node) => host.React.createElement(Provider, { store }, node)) };
}

test("reset after replacing a removed vision model restores the latest successful save", async () => {
	await withHookHost(async (host) => {
		const { mounted } = await setup(host);
		await host.act(async () => mounted.result().updateDraft(replacement));
		await host.act(async () => assert.equal(await mounted.result().save(), true));
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "discard this edit" }));
		await host.act(async () => mounted.result().reset());
		assert.equal(mounted.result().draft.provider, replacement.provider);
		assert.equal(mounted.result().draft.model, replacement.model);
		assert.equal(mounted.result().draft.promptTemplate, missing.promptTemplate);
		assert.equal(mounted.result().dirty, false);
	});
});

test("disabling a missing vision bridge immediately updates image submission capabilities", async () => {
	await withHookHost(async (host) => {
		const { mounted, store, vision } = await setup(host);
		await host.act(async () => mounted.result().updateDraft({ enabled: false }));
		await host.act(async () => assert.equal(await mounted.result().save(), true));
		assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.enabled, false,
			"a successful disable must not leave the composer blocked until another list read completes");
	});
});

test("a late capability read cannot replace a successful vision save after consumers unmount", async () => {
	await withHookHost(async (host) => {
		const oldRead = deferred();
		const save = deferred();
		let reads = 0;
		const api = {
			projects: { listModels: async () => [] },
			config: {
				visionGetConfig: () => ++reads === 1 ? Promise.resolve({ config: { ...missing }, configDir: "/config" }) : oldRead.promise,
				visionSaveConfig: () => save.promise,
			},
		};
		const { mounted, store, vision } = await setup(host, { api, withCapabilities: true });
		await host.act(async () => mounted.result().updateDraft(replacement));
		let pendingSave;
		await host.act(async () => { pendingSave = mounted.result().save(); });
		await mounted.unmount();
		await host.act(async () => { save.resolve({ ok: true }); await pendingSave; });
		await host.act(async () => oldRead.resolve({ config: { ...missing }, configDir: "/config" }));
		assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.model, replacement.model);
	});
});

test("an initial vision config reply cannot revive a choice removed and re-added before the read settles", async () => {
	await withHookHost(async (host) => {
		const initial = deferred();
		const { mounted, modelsChanged } = await setup(host, { withModelSync: true, api: { config: {
			visionGetConfig: () => initial.promise,
			visionSaveConfig: async () => ({ ok: true }),
		} } });
		const identity = { provider: replacement.provider, modelId: replacement.model };
		const scope = { environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev" };
		await host.act(async () => modelsChanged({ ...scope, removedModels: [identity] }));
		await host.act(async () => modelsChanged({ ...scope, changedModels: [identity] }));
		await host.act(async () => initial.resolve({ config: { ...missing, ...replacement }, configDir: "/config" }));
		assert.equal(mounted.result().draft.model, "", "the delayed snapshot predates deletion of the shared bridge choice");
		await host.act(async () => mounted.result().reset());
		assert.equal(mounted.result().draft.model, "");
	});
});

for (const scope of [{ environment: "native" }, { environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev" }]) {
test(`a late vision save reply cannot restore a selection deleted and re-added in ${scope.environment} while it was pending`, async () => {
	await withHookHost(async (host) => {
		const reply = deferred();
		let persisted = { ...missing, ...replacement };
		const { mounted, store, vision, modelsChanged } = await setup(host, { withModelSync: true, api: {
			config: {
				visionGetConfig: async () => ({ config: { ...persisted }, configDir: "/config" }),
				visionSaveConfig: (config) => { persisted = { ...config }; return reply.promise; },
			},
		} });
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "confirmed before deletion" }));
		let pendingSave;
		await host.act(async () => { pendingSave = mounted.result().save(); });
		const identity = { provider: replacement.provider, modelId: replacement.model };
		persisted = { ...persisted, provider: "", model: "" };
		await host.act(async () => modelsChanged({ ...scope, removedModels: [identity] }));
		assert.equal(mounted.result().draft.model, "");
		await host.act(async () => modelsChanged({ ...scope, changedModels: [identity] }));
		await host.act(async () => { reply.resolve({ ok: true }); await pendingSave; });
		assert.equal(mounted.result().draft.model, persisted.model, "re-adding a model does not reselect it in the saved bridge config");
		assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.model, "", "the composer must retain the missing-model choice");
		await host.act(async () => mounted.result().reset());
		assert.equal(mounted.result().draft.model, "", "reset must not revive the pre-deletion save either");
	});
});
}

test("edits during a vision save remain in the draft and stay dirty after success", async () => {
	await withHookHost(async (host) => {
		const reply = deferred();
		const { mounted, store, vision } = await setup(host, { api: { config: {
			visionGetConfig: async () => ({ config: { ...missing, ...replacement }, configDir: "/config" }),
			visionSaveConfig: () => reply.promise,
		} } });
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "save this" }));
		let pendingSave;
		await host.act(async () => { pendingSave = mounted.result().save(); });
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "keep editing" }));
		let savedAllEdits;
		await host.act(async () => { reply.resolve({ ok: true }); savedAllEdits = await pendingSave; });
		assert.equal(mounted.result().draft.promptTemplate, "keep editing");
		assert.equal(mounted.result().dirty, true);
		assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.promptTemplate, "save this");
		assert.equal(savedAllEdits, false, "Save and Close must not discard an edit made while the previous snapshot was saving");
		await host.act(async () => mounted.result().reset());
		assert.equal(mounted.result().draft.promptTemplate, "save this");
	});
});

test("reset during a vision save adopts the confirmed baseline when the write succeeds", async () => {
	await withHookHost(async (host) => {
		const reply = deferred();
		const { mounted } = await setup(host, { api: { config: {
			visionGetConfig: async () => ({ config: { ...missing, ...replacement }, configDir: "/config" }),
			visionSaveConfig: () => reply.promise,
		} } });
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "saved replacement" }));
		let pendingSave;
		await host.act(async () => { pendingSave = mounted.result().save(); });
		await host.act(async () => mounted.result().reset());
		assert.equal(mounted.result().draft.promptTemplate, missing.promptTemplate);
		await host.act(async () => { reply.resolve({ ok: true }); await pendingSave; });
		assert.equal(mounted.result().draft.promptTemplate, "saved replacement");
		assert.equal(mounted.result().dirty, false);
		await host.act(async () => mounted.result().reset());
		assert.equal(mounted.result().draft.promptTemplate, "saved replacement");
	});
});

test("an in-flight vision save refuses a second write and preserves newer edits for retry", async () => {
	await withHookHost(async (host) => {
		const firstReply = deferred();
		const writes = [];
		const { mounted, store, vision } = await setup(host, { api: { config: {
			visionGetConfig: async () => ({ config: { ...missing, ...replacement }, configDir: "/config" }),
			visionSaveConfig: (config) => {
				writes.push({ ...config });
				return firstReply.promise;
			},
		} } });
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "first save" }));
		let firstSave;
		await host.act(async () => { firstSave = mounted.result().save(); });
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "second save" }));
		let secondSave;
		await host.act(async () => { secondSave = mounted.result().save(); });
		try {
			assert.deepEqual(writes.map((config) => config.promptTemplate), ["first save"], "close-confirm must not start another write while Save is pending");
			assert.equal(await secondSave, false, "Save and Close must keep the dialog open for the unsaved newer edit");
			assert.equal(mounted.result().saving, true);
			await host.act(async () => { firstReply.resolve({ ok: true }); await firstSave; });
			assert.equal(mounted.result().draft.promptTemplate, "second save");
			assert.equal(mounted.result().dirty, true);
			assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.promptTemplate, "first save");
			await host.act(async () => mounted.result().reset());
			assert.equal(mounted.result().draft.promptTemplate, "first save");
		} finally {
			await host.act(async () => { firstReply.resolve({ ok: true }); await Promise.all([firstSave, secondSave]); });
		}
	});
});

test("a save from a closed vision dialog cannot overwrite a newer confirmed configuration", async () => {
	await withHookHost(async (host) => {
		const firstReply = deferred();
		const secondReply = deferred();
		let persisted = { ...missing, ...replacement };
		let writes = 0;
		const { mounted, remount, store, vision } = await setup(host, { api: { config: {
			visionGetConfig: async () => ({ config: { ...persisted }, configDir: "/config" }),
			visionSaveConfig: (config) => {
				persisted = { ...config };
				return ++writes === 1 ? firstReply.promise : secondReply.promise;
			},
		} } });
		await host.act(async () => mounted.result().updateDraft({ promptTemplate: "older dialog" }));
		let firstSave;
		await host.act(async () => { firstSave = mounted.result().save(); });
		await mounted.unmount();
		const current = await remount();
		await host.act(async () => current.result().updateDraft({ promptTemplate: "current dialog" }));
		let secondSave;
		await host.act(async () => { secondSave = current.result().save(); });
		await host.act(async () => { secondReply.resolve({ ok: true }); await secondSave; });
		assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.promptTemplate, "current dialog");
		await host.act(async () => { firstReply.resolve({ ok: true }); await firstSave; });
		assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.promptTemplate, persisted.promptTemplate,
			"the previous dialog's delayed acknowledgement must not replace the newer persisted bridge configuration");
	});
});

test("a failed save in a reopened vision dialog cannot hide an earlier successful disable", async () => {
	await withHookHost(async (host) => {
		const firstReply = deferred();
		const secondReply = deferred();
		let persisted = { ...missing };
		let writes = 0;
		const { mounted, remount, store, vision } = await setup(host, { withCapabilities: true, api: {
			projects: { listModels: async () => [] },
			config: {
				visionGetConfig: async () => ({ config: { ...persisted }, configDir: "/config" }),
				visionSaveConfig: (config) => {
					if (++writes === 1) { persisted = { ...config }; return firstReply.promise; }
					return secondReply.promise;
				},
			},
		} });
		await host.act(async () => mounted.result().updateDraft({ enabled: false }));
		let firstSave;
		await host.act(async () => { firstSave = mounted.result().save(); });
		await mounted.unmount();
		const current = await remount();
		await host.act(async () => current.result().updateDraft({ enabled: true, ...replacement }));
		let secondSave;
		await host.act(async () => { secondSave = current.result().save(); });
		await host.act(async () => { secondReply.resolve({ ok: false, error: "write failed" }); await secondSave; });
		await host.act(async () => { firstReply.resolve({ ok: true }); await firstSave; });
		assert.equal(store.get(vision.visionBridgeCapabilitiesAtom).config.enabled, persisted.enabled,
			"a failed newer write must not leave the composer blocked after disabling the missing bridge succeeded");
		assert.equal(current.result().dirty, true, "the failed replacement remains editable");
	});
});
