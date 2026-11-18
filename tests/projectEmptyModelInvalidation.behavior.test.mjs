import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred, nodes } from "./helpers/imagePreviewHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");
const removed = { provider: "custom", modelId: "old/model" };
const replacement = { provider: "custom", id: "replacement" };

async function setup(host, getSettings) {
	const atoms = host.load("src/renderer/src/atoms/model-atoms.ts");
	const store = createStore();
	const created = [];
	const notices = [];
	const { ProjectEmptyState } = host.load("src/renderer/src/components/session/ProjectEmptyState.tsx", {
		stubs: {
			"../../atoms": atoms,
			"../../atoms/model-atoms": atoms,
			"../../desktopApi": { desktopApi: {
				config: { getSettings, getModels: async () => ({ parsed: { providers: {} } }) },
				projects: { listModels: async () => [{ provider: removed.provider, id: removed.modelId }, replacement] },
			} },
			"../../i18n": { t: (key) => key },
			"../../utils/notice": { showNotice: (message) => notices.push(message) },
			"../ui-shadcn/button": { Button: "Button" },
			"./ComposerComponents": { ModelPicker: "ModelPicker", ThinkingPicker: "ThinkingPicker" },
			"./SurfaceParts": { EmptyState: "EmptyState" },
		},
		globals: { localStorage: { setItem() {} } },
	});
	const mounted = await host.mount(ProjectEmptyState, {
		activeProject: { id: "project", path: "/project" },
		onCreateAgent: (preferences) => created.push(preferences),
		onCreateAnonymous: (preferences) => created.push(preferences),
		onAddProject() {},
	}, (node) => host.React.createElement(Provider, { store }, node));
	const surface = () => nodes(mounted.result(), (node) => node.type === "EmptyState")[0].props;
	return { atoms, store, mounted, created, notices, surface };
}

test("a late empty-state default cannot restore a removed model or launch through the fallback action", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, () => pending.promise);
		await host.act(async () => {
			env.store.set(env.atoms.removedModelReferencesByScopeAtom, { native: [removed], wsl: [] });
			pending.resolve({ parsed: { defaultProvider: removed.provider, defaultModel: removed.modelId } });
		});
		const modelButton = nodes(env.surface().footer, (node) => node.type === "button")[0];
		assert.equal(modelButton.props.title, "app.model");
		await host.act(async () => env.surface().onCreate());
		assert.equal(env.created.length, 0);
		assert.equal(env.notices.at(-1), "app.modelSelectionRequired");
		const picker = nodes(env.surface().footer, (node) => node.type === "ModelPicker")[0];
		await host.act(async () => picker.props.onPick(replacement));
		await host.act(async () => env.surface().onCreate());
		assert.equal(env.created.length, 1);
		assert.equal(env.created[0].model.modelId, replacement.id);
	});
});

test("an explicitly cleared pi default keeps both create actions waiting for a new model", async () => {
	await withHookHost(async (host) => {
		const env = await setup(host, async () => ({ parsed: { defaultProvider: "", defaultModel: "" } }));
		for (const button of nodes(env.surface().actions, (node) => node.type === "Button")) {
			await host.act(async () => button.props.onClick());
		}
		assert.equal(env.created.length, 0);
		assert.equal(env.notices.length, 2);
	});
});

test("an empty-state config read from the previous environment cannot replace the current default", async () => {
	await withHookHost(async (host) => {
		const requests = [];
		const env = await setup(host, () => { const request = deferred(); requests.push(request); return request.promise; });
		const native = requests[0];
		await host.act(async () => env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl"));
		const wsl = requests.at(-1);
		assert.notEqual(wsl, native);
		await host.act(async () => wsl.resolve({ parsed: { defaultProvider: "wsl", defaultModel: "current" } }));
		await host.act(async () => native.resolve({ parsed: { defaultProvider: "native", defaultModel: "old" } }));
		await host.act(async () => env.surface().onCreate());
		assert.equal(env.created[0].model.provider, "wsl");
		assert.equal(env.created[0].model.modelId, "current");
	});
});

test("a late deleted default cannot erase a replacement picked while settings were loading", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, () => pending.promise);
		await host.act(async () => env.store.set(env.atoms.removedModelReferencesByScopeAtom, { native: [removed], wsl: [] }));
		await host.act(async () => nodes(env.surface().footer, (node) => node.type === "button")[0].props.onClick());
		await host.act(async () => nodes(env.surface().footer, (node) => node.type === "ModelPicker")[0].props.onPick(replacement));
		await host.act(async () => pending.resolve({ parsed: { defaultProvider: removed.provider, defaultModel: removed.modelId } }));
		await host.act(async () => env.surface().onCreate());
		assert.equal(env.created.length, 1);
		assert.equal(env.created[0].model.modelId, replacement.id);
	});
});

test("changing WSL accounts waits for that account's defaults before creating a session", async () => {
	await withHookHost(async (host) => {
		const requests = [];
		const env = await setup(host, () => { const request = deferred(); requests.push(request); return request.promise; });
		await host.act(async () => {
			env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl");
			env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "alice" });
		});
		const alice = requests.at(-1);
		await host.act(async () => alice.resolve({ parsed: { defaultProvider: "alice", defaultModel: "current" } }));
		await host.act(async () => env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "bob" }));
		assert.notEqual(requests.at(-1), alice);
		await host.act(async () => env.surface().onCreate());
		assert.equal(env.created.length, 0);
		await host.act(async () => requests.at(-1).resolve({ parsed: { defaultProvider: "bob", defaultModel: "new" } }));
		await host.act(async () => env.surface().onCreate());
		assert.equal(env.created.length, 1);
		assert.equal(env.created[0].model.provider, "bob");
	});
});

test("a welcome default deleted and re-added during its initial read still requires a new choice", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, () => pending.promise);
		const key = JSON.stringify([removed.provider, removed.modelId]);
		await host.act(async () => {
			env.store.set(env.atoms.sharedModelRemovalVersionsAtom, { [key]: 1 });
			env.store.set(env.atoms.modelConfigurationVersionsByScopeAtom, { native: { [key]: 1 }, wsl: {} });
			env.store.set(env.atoms.modelRemovalVersionsByScopeAtom, { native: { [key]: 1 }, wsl: {} });
			env.store.set(env.atoms.removedModelReferencesByScopeAtom, { native: [removed], wsl: [] });
		});
		await host.act(async () => env.store.set(env.atoms.removedModelReferencesByScopeAtom, { native: [], wsl: [] }));
		await host.act(async () => pending.resolve({ parsed: { defaultProvider: removed.provider, defaultModel: removed.modelId } }));
		await host.act(async () => env.surface().onCreate());
		assert.equal(env.created.length, 0);
		assert.equal(env.notices.at(-1), "app.modelSelectionRequired");
	});
});
