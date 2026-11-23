import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred, nodes } from "./helpers/imagePreviewHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, atom, createStore } = nodeRequire("jotai");
const { atomFamily } = nodeRequire("jotai/utils");
const selected = { provider: "custom", modelId: "old/model" };
const replacement = { provider: "custom", modelId: "replacement" };
const available = (model) => ({ provider: model.provider, id: model.modelId, name: model.modelId });
const target = { sessionId: "session", agentId: "agent", runtimeGeneration: 1 };
const success = (value, handle = target) => ({ ok: true, value: { target: handle, value } });

/** Mount the real picker and model-event subscriber against one observable session store. */
async function setup(host, options = {}) {
	const store = createStore();
	const modelAtoms = host.load("src/renderer/src/atoms/model-atoms.ts");
	const initialRecord = { id: "session", projectId: "project", environment: "native", model: options.model ?? selected, thinkingLevel: "medium", updatedAt: 1 };
	const sessionRecordsAtom = atom({ session: initialRecord });
	const sessionRuntimeByIdAtom = atom(options.stopped ? {} : { session: { ...target, status: options.busy ? "running" : "idle", state: { ...(options.runtimeModel ?? initialRecord.model), thinkingLevel: "medium", isStreaming: Boolean(options.busy) } } });
	const modelPendingByIdAtom = atom(options.pending ? { session: options.pending } : {});
	const thinkingLevelPendingByIdAtom = atom({});
	const atoms = {
		sessionRecordsAtom,
		sessionRuntimeByIdAtom,
		modelPendingByIdAtom,
		thinkingLevelPendingByIdAtom,
		sessionRecordByIdAtomFamily: atomFamily((id) => atom((get) => get(sessionRecordsAtom)[id])),
		sessionRuntimeBySessionIdAtomFamily: atomFamily((id) => atom((get) => get(sessionRuntimeByIdAtom)[id])),
		modelPendingAtomFamily: atomFamily((id) => atom((get) => get(modelPendingByIdAtom)[id])),
		thinkingLevelPendingAtomFamily: atomFamily((id) => atom((get) => get(thinkingLevelPendingByIdAtom)[id])),
		sessionComposerModeAtomFamily: atomFamily(() => atom("normal")),
		setSessionComposerModeAtom: atom(null, () => {}),
		upsertSessionAtom: atom(null, (get, set, record) => set(sessionRecordsAtom, { ...get(sessionRecordsAtom), [record.id]: record })),
	};
	let listener;
	const notices = [];
	const updates = [];
	const restarts = [];
	const api = {
		projects: {
			listModels: async () => [available(selected), available(replacement)],
			onModelsChanged: (callback) => { listener = callback; return () => { listener = undefined; }; },
		},
		settings: { get: async () => ({ favoriteModels: [] }), update: async () => ({}) },
		sessions: {
			setRuntimeModel: options.setRuntimeModel ?? (async (_handle, provider, modelId) => success({ provider, modelId })),
			setRuntimeThinking: options.setRuntimeThinking ?? (async (_handle, level) => success({ ...selected, thinkingLevel: level })),
			listRuntimeModels: options.listRuntimeModels ?? (async () => success([available(selected), available(replacement)])),
			updateRecord: (id, patch) => {
				updates.push({ id, patch });
				return options.updateRecord?.(id, patch) ?? Promise.resolve({ ...store.get(sessionRecordsAtom)[id], ...patch });
			},
		},
	};
	const stubs = {
		"../../atoms": atoms,
		"../atoms": atoms,
		"../../atoms/model-atoms": modelAtoms,
		"../atoms/model-atoms": modelAtoms,
		"../atoms/session-atoms": atoms,
		"../atoms/composer-atoms": atoms,
		"../atoms/vision-atoms": { visionBridgeCapabilitiesAtom: atom({ config: null }), visionBridgeRequestSeqAtom: atom(0) },
		"../../desktopApi": { desktopApi: api },
		"../desktopApi": { desktopApi: api },
		"../../i18n": { t: (key) => key },
		"../i18n": { t: (key) => key },
		"../../utils/notice": { showNotice: (message) => notices.push(message) },
		"../utils/notice": { showNotice: (message) => notices.push(message) },
		"./ComposerParts": { ComposerModePicker: "ComposerModePicker", ModelPicker: "ModelPicker", PromptTemplatePicker: "PromptTemplatePicker", ThinkingPicker: "ThinkingPicker" },
		"../app/AppParts": { ConfirmDialog: "ConfirmDialog" },
		"./SessionPaneServices": { useSessionPaneActions: () => ({ restartActiveAgent: async (agentId) => restarts.push(agentId) }) },
	};
	const globals = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
	const { ComposerPickerHost } = host.load("src/renderer/src/components/session/ComposerPickerHost.tsx", { stubs, globals });
	const { useModelListSync } = host.load("src/renderer/src/hooks/useModelListSync.ts", { stubs, globals });
	const mounted = await host.mount(() => {
		const [picker, setPicker] = host.React.useState(options.picker ?? "model");
		useModelListSync();
		return ComposerPickerHost({ sessionId: "session", picker, templates: [], onClose: () => setPicker(null), onInsertTemplate() {} });
	}, undefined, (node) => host.React.createElement(Provider, { store }, node));
	return {
		store, atoms, modelAtoms, mounted, notices, updates, restarts,
		record: () => store.get(sessionRecordsAtom).session,
		runtime: () => store.get(sessionRuntimeByIdAtom).session,
		pick: (model = selected) => host.act(async () => nodes(mounted.result(), (node) => node.type === "ModelPicker")[0].props.onPick(available(model))),
		remove: () => listener({ environment: "native", removedModels: [selected], changedModels: [] }),
		change: (change) => listener(change),
	};
}

test("a delayed model-switch response cannot restore a model removed by SSE", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, { setRuntimeModel: () => pending.promise });
		await env.pick();
		await host.act(async () => env.remove());
		await host.act(async () => pending.resolve(success({ ...selected, thinkingLevel: "medium" })));
		assert.equal(env.record().model.modelId, "");
		assert.equal(env.runtime().state.modelId, "");
	});
});

test("a delayed catalog response cannot restore a removed model for a stopped session", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, { stopped: true, updateRecord: () => pending.promise });
		const staleRecord = { ...env.record() };
		await env.pick();
		await host.act(async () => env.remove());
		await host.act(async () => pending.resolve(staleRecord));
		assert.equal(env.record().model.modelId, "");
	});
});

test("a busy picker does not queue a catalog write after its target was deleted", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, { busy: true, listRuntimeModels: () => pending.promise });
		await env.pick();
		await host.act(async () => env.remove());
		await host.act(async () => pending.resolve(success([available(selected)])));
		assert.equal(env.updates.length, 0);
		assert.equal(env.store.get(env.atoms.modelPendingByIdAtom).session, undefined);
		assert.equal(env.record().model.modelId, "");
	});
});

test("deleting a model during restart confirmation prevents the late save from restarting", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, {
			model: replacement,
			setRuntimeModel: async () => ({ ok: false, error: { code: "SESSION_MODEL_NOT_FOUND", needsRestart: true } }),
			updateRecord: () => pending.promise,
		});
		await env.pick();
		await host.act(async () => nodes(env.mounted.result(), (node) => node.type === "ConfirmDialog")[0].props.onConfirm());
		assert.equal(env.updates.length, 1);
		await host.act(async () => env.remove());
		await host.act(async () => pending.resolve({ ...env.record(), model: selected }));
		assert.equal(env.record().model.modelId, replacement.modelId);
		assert.equal(env.restarts.length, 0);
	});
});

test("a delayed thinking response changes only thinking after model deletion", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, { picker: "thinking", setRuntimeThinking: () => pending.promise });
		await host.act(async () => nodes(env.mounted.result(), (node) => node.type === "ThinkingPicker")[0].props.onPick("high"));
		await host.act(async () => env.remove());
		await host.act(async () => pending.resolve(success({ ...selected, thinkingLevel: "high" })));
		assert.equal(env.record().thinkingLevel, "high");
		assert.equal(env.record().model.modelId, "");
		assert.equal(env.runtime().state.modelId, "");
	});
});

test("a model response for the previous runtime cannot replace a newer runtime selection", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, { setRuntimeModel: () => pending.promise });
		await env.pick();
		await host.act(async () => {
			env.store.set(env.atoms.sessionRecordsAtom, { session: { ...env.record(), model: replacement } });
			env.store.set(env.atoms.sessionRuntimeByIdAtom, { session: { ...env.runtime(), agentId: "next-agent", runtimeGeneration: 2, state: { ...replacement, thinkingLevel: "high" } } });
		});
		await host.act(async () => pending.resolve(success(selected)));
		assert.equal(env.record().model.modelId, replacement.modelId);
		assert.equal(env.runtime().state.modelId, replacement.modelId);
		assert.equal(env.runtime().runtimeGeneration, 2);
	});
});

test("pending model application checks deletion before React effect cleanup runs", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, { pending: { from: replacement, to: selected }, setRuntimeModel: () => pending.promise });
		await host.act(async () => {
			env.remove();
			pending.resolve(success(selected));
			await pending.promise;
		});
		assert.equal(env.record().model.modelId, "");
		assert.equal(env.runtime().state.modelId, "");
	});
});

test("adding back a removed identity requires a fresh picker action instead of accepting the old response", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		let calls = 0;
		const env = await setup(host, { setRuntimeModel: () => ++calls === 1 ? pending.promise : Promise.resolve(success(selected)) });
		await env.pick();
		await host.act(async () => env.remove());
		await host.act(async () => env.change({ environment: "native", removedModels: [], changedModels: [selected] }));
		await host.act(async () => pending.resolve(success(selected)));
		assert.equal(env.record().model.modelId, "");
		assert.equal(env.runtime().state.modelId, "");
		await env.pick();
		assert.equal(env.record().model.modelId, selected.modelId);
		assert.equal(env.runtime().state.modelId, selected.modelId);
	});
});

test("a current idle model choice updates the record and runtime immediately", async () => {
	await withHookHost(async (host) => {
		const env = await setup(host);
		await env.pick(replacement);
		assert.equal(env.record().model.modelId, replacement.modelId);
		assert.equal(env.runtime().state.modelId, replacement.modelId);
	});
});

test("a current stopped-session model choice preserves concurrent record edits", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, { stopped: true, updateRecord: () => pending.promise });
		const old = env.record();
		await env.pick(replacement);
		await host.act(async () => env.store.set(env.atoms.sessionRecordsAtom, { session: { ...old, title: "renamed while saving" } }));
		await host.act(async () => pending.resolve({ ...old, model: replacement }));
		assert.equal(env.record().model.modelId, replacement.modelId);
		assert.equal(env.record().title, "renamed while saving");
	});
});

test("a busy choice remains pending until its current runtime accepts the target", async () => {
	await withHookHost(async (host) => {
		const env = await setup(host, { busy: true });
		await env.pick(replacement);
		assert.equal(env.record().model.modelId, replacement.modelId);
		assert.equal(env.runtime().state.modelId, selected.modelId);
		assert.equal(env.store.get(env.atoms.modelPendingByIdAtom).session.to.modelId, replacement.modelId);
		await host.act(async () => env.store.set(env.atoms.sessionRuntimeByIdAtom, {
			session: { ...env.runtime(), status: "idle", state: { ...env.runtime().state, isStreaming: false } },
		}));
		assert.equal(env.runtime().state.modelId, replacement.modelId);
		assert.equal(env.store.get(env.atoms.modelPendingByIdAtom).session, undefined);
	});
});

test("confirming a current unavailable model persists it before using the shared restart action", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, {
			model: replacement,
			setRuntimeModel: async () => ({ ok: false, error: { code: "SESSION_MODEL_NOT_FOUND", needsRestart: true } }),
			updateRecord: () => pending.promise,
		});
		await env.pick();
		assert.equal(env.updates.length, 0, "offering a restart must preserve the current choice until confirmed");
		await host.act(async () => nodes(env.mounted.result(), (node) => node.type === "ConfirmDialog")[0].props.onConfirm());
		assert.equal(env.updates.length, 1);
		assert.equal(env.restarts.length, 0);
		await host.act(async () => pending.resolve({ ...env.record(), model: selected }));
		assert.equal(env.record().model.modelId, selected.modelId);
		assert.deepEqual(env.restarts, [target.agentId]);
	});
});
