import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred, nodes } from "./helpers/imagePreviewHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, atom, createStore } = nodeRequire("jotai");
const model = { provider: "custom", modelId: "old/id" };
const available = { provider: model.provider, id: model.modelId };
const primitive = (...names) => Object.fromEntries(names.map((name) => [name, name]));

/** Exercise real modal draft, save and reopen behavior with only its visual leaves replaced. */
async function setup(host, save = async () => true, options = {}) {
	const store = createStore();
	const atoms = host.load("src/renderer/src/atoms/model-atoms.ts");
	const writes = [];
	const closes = [];
	const visionAtoms = host.load("src/renderer/src/atoms/vision-atoms.ts");
	const visionHook = options.realVision ? host.load("src/renderer/src/components/app/settings/visionDraft.ts", {
		stubs: {
			"../../../atoms/model-atoms": atoms,
			"../../../atoms/vision-atoms": visionAtoms,
			"../../../atoms/session-atoms": { visionConfigRevisionAtom: atom(0) },
			"../../../desktopApi": { desktopApi: { config: {
				visionGetConfig: async () => ({ config: { enabled: true, provider: "custom", model: "vision", promptTemplate: "original" }, configDir: "/config" }),
				visionSaveConfig: options.saveVision ?? (async () => ({ ok: true })),
			} } },
			"../../../i18n": { t: (key) => key },
			"../../../utils/notice": { showNotice() {} },
		},
	}).useVisionBridgeDraft : () => ({ draft: null, dirty: false, saving: false, save: async () => true, reset() {}, getEditRevision: () => 0 });
	let settings = { gitCommitMessageProvider: "", gitCommitMessageModel: "", favoriteModels: [], uiFontSize: null, chatFontSize: null, inputFontSize: null };
	let mounted;
	const { SettingsModal } = host.load("src/renderer/src/components/app/SettingsModal.tsx", {
		stubs: {
			"../../atoms/model-atoms": atoms,
			"../atoms/model-atoms": atoms,
			"../../i18n": { t: (key) => key },
			"../../utils/notice": { showNotice() {} },
			"../utils/notice": { showNotice() {} },
			"./settings/visionDraft.ts": { useVisionBridgeDraft: visionHook },
			"./settings/gitModels.ts": { useGitModels: () => ({ gitModels: [available], gitModelPickerOpen: true, openPicker() {}, closePicker() {} }) },
			"../ui-shadcn/button": { Button: "Button", buttonVariants: () => "" },
			"../ui-shadcn/tabs": primitive("Tabs", "TabsContent", "TabsList", "TabsTrigger"),
			"../ui-shadcn/dialog": primitive("Dialog", "DialogClose", "DialogContent", "DialogHeader", "DialogTitle"),
			"../ui-shadcn/alert-dialog": primitive("AlertDialog", "AlertDialogAction", "AlertDialogCancel", "AlertDialogContent", "AlertDialogDescription", "AlertDialogFooter", "AlertDialogHeader", "AlertDialogTitle"),
		},
		globals: { localStorage: { getItem: () => "common", setItem() {} } },
	});
	const open = async () => {
		if (mounted) await mounted.unmount();
		const props = {
			settings, appInfo: { platform: "linux" }, onClose: () => closes.push(true),
			onChange: async (patch) => { writes.push(patch); const result = await save(patch); if (result) settings = { ...settings, ...patch }; return result; },
		};
		const content = SettingsModal.type(props).props.children;
		mounted = await host.mount(content.type, props, (node) => host.React.createElement(Provider, { store }, node));
	};
	await open();
	const common = () => nodes(mounted.result(), (node) => typeof node.props?.onPickGitModel === "function")[0].props;
	const button = (label) => nodes(mounted.result(), (node) => node.type === "Button" && node.props.children === label)[0];
	return {
		store, atoms, writes, closes, open, common, button,
		vision: () => nodes(mounted.result(), (node) => typeof node.props?.configDir === "string" && typeof node.props?.onChange === "function")[0].props,
		tab: (value) => host.act(async () => nodes(mounted.result(), (node) => node.type === "Tabs")[0].props.onValueChange(value)),
		startSaveAndClose: async () => {
			await host.act(async () => nodes(mounted.result(), (node) => node.type === "Dialog")[0].props.onOpenChange(false));
			await host.act(async () => { void nodes(mounted.result(), (node) => node.type === "AlertDialogAction" && node.props.children === "settings.saveAndClose")[0].props.onClick(); });
		},
		remove: () => host.act(async () => {
			store.set(atoms.removedModelReferencesByScopeAtom, { native: [], wsl: [{ ...model }] });
			store.set(atoms.sharedRemovedModelReferencesAtom, [{ ...model }]);
			store.set(atoms.sharedModelRemovalVersionsAtom, (current) => ({ ...current, [JSON.stringify([model.provider, model.modelId])]: (current[JSON.stringify([model.provider, model.modelId])] ?? 0) + 1 }));
		}),
		pick: (value = available) => host.act(async () => common().onPickGitModel(value)),
		save: () => host.act(async () => button("common.save").props.onClick()),
		startSave: () => host.act(async () => { void button("common.save").props.onClick(); }),
	};
}

test("a Git model reselected in native survives saving and reopening after its WSL identity was deleted", async () => {
	await withHookHost(async (host) => {
		const env = await setup(host);
		await env.remove();
		await env.pick();
		await env.save();
		assert.equal(env.writes.length, 1);
		await env.open();
		assert.equal(env.common().draft.gitCommitMessageModel, model.modelId);
		assert.equal(env.store.get(env.atoms.removedModelReferencesByScopeAtom).wsl.length, 1);
	});
});

test("failed application settings saves retain model edits and the shared removal record", async () => {
	await withHookHost(async (host) => {
		const env = await setup(host, async () => false);
		await env.remove();
		await env.pick();
		await env.save();
		assert.equal(env.common().draft.gitCommitMessageModel, model.modelId);
		assert.equal(env.button("common.save").props.disabled, false);
		assert.equal(env.store.get(env.atoms.sharedRemovedModelReferencesAtom).length, 1);
	});
});

test("deletion and re-addition during a Git model save cannot restore its old cancellation baseline", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, () => pending.promise);
		await env.pick();
		await env.startSave();
		await env.remove();
		await host.act(async () => env.store.set(env.atoms.sharedRemovedModelReferencesAtom, []));
		await host.act(async () => pending.resolve(true));
		await host.act(async () => env.common().updateDraft({ theme: "dark" }));
		await host.act(async () => env.button("common.cancel").props.onClick());
		assert.equal(env.common().draft.gitCommitMessageModel, "");
	});
});

test("Save and Close preserves vision edits made while application settings are saving", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, () => pending.promise, { realVision: true });
		await host.act(async () => env.common().updateDraft({ theme: "dark" }));
		await env.startSaveAndClose();
		await env.tab("vision");
		await host.act(async () => env.vision().onChange({ promptTemplate: "new vision edit" }));
		await host.act(async () => pending.resolve(true));
		assert.equal(env.closes.length, 0);
		assert.equal(env.vision().draft.promptTemplate, "new vision edit");
		assert.equal(env.button("common.save").props.disabled, false);
	});
});

test("Save and Close preserves application edits made while vision settings are saving", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const env = await setup(host, async () => true, { realVision: true, saveVision: () => pending.promise });
		await host.act(async () => env.common().updateDraft({ theme: "dark" }));
		await env.tab("vision");
		await host.act(async () => env.vision().onChange({ promptTemplate: "saved vision edit" }));
		await env.startSaveAndClose();
		await env.tab("common");
		await host.act(async () => env.common().updateDraft({ theme: "light" }));
		await host.act(async () => pending.resolve({ ok: true }));
		assert.equal(env.closes.length, 0);
		assert.equal(env.common().draft.theme, "light");
		assert.equal(env.button("common.save").props.disabled, false);
	});
});
