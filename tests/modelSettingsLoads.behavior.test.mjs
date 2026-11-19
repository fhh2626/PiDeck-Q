import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { deferred, nodes } from "./helpers/imagePreviewHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore, atom } = nodeRequire("jotai");
const removedModel = { provider: "custom", modelId: "old/model" };
const model = (id) => ({ provider: "custom", id, name: id, images: true });
const copy = (value) => JSON.parse(JSON.stringify(value));
const primitive = (...names) => Object.fromEntries(names.map((name) => [name, name]));

/** Keep the production React effects and Jotai subscriptions, with opaque visual primitives. */
function setup(host) {
	const atoms = host.load("src/renderer/src/atoms/model-atoms.ts");
	const { removedModelReferencesByScopeAtom, sharedRemovedModelReferencesAtom, modelListRevisionAtom } = atoms;
	const store = createStore();
	const wrap = (node) => host.React.createElement(Provider, { store }, node);
	const remove = (environment = "native") => host.act(async () => {
		const removal = { ...removedModel };
		store.set(removedModelReferencesByScopeAtom, (current) => ({ ...current, [environment]: [removal] }));
		store.set(sharedRemovedModelReferencesAtom, [removal]);
		store.set(atoms.modelRemovalVersionsByScopeAtom, (current) => {
			const key = JSON.stringify([removal.provider, removal.modelId]);
			return { ...current, [environment]: { ...current[environment], [key]: (current[environment]?.[key] ?? 0) + 1 } };
		});
		store.set(atoms.sharedModelRemovalVersionsAtom, (current) => {
			const key = JSON.stringify([removal.provider, removal.modelId]);
			return { ...current, [key]: (current[key] ?? 0) + 1 };
		});
	});
	const revise = () => host.act(async () => store.set(modelListRevisionAtom, (value) => value + 1));
	return { atoms, store, wrap, remove, revise };
}

/** Exercise an actual save and reopen, retaining the same Jotai store across component lifetimes. */
async function sharedSettingsEditor(host, env, kind, saveResult = async () => ({ ok: true })) {
	let mounted;
	let writes = 0;
	let saved = kind === "vision"
		? { enabled: true, provider: "", model: "", promptTemplate: "keep" }
		: { global: { useOwnModel: true, preferDelegation: false }, project: null };
	const write = async (value) => {
		writes += 1;
		const result = await saveResult();
		if (result.ok) saved = kind === "vision" ? copy(value) : { ...saved, global: copy(value) };
		return result;
	};
	const open = async () => {
		if (mounted) await mounted.unmount();
		mounted = kind === "vision"
			? await host.mount(loadVisionDraft(host, env, { visionGetConfig: async () => ({ config: copy(saved), configDir: "/config" }), visionSaveConfig: write }), undefined, env.wrap)
			: await mountSubagents(host, env, { getSettings: async () => copy(saved), saveSettings: (_scope, _project, value) => write(value) }, async () => [model(removedModel.modelId)]);
	};
	await open();
	return {
		open,
		writes: () => writes,
		selected: () => kind === "vision"
			? mounted.result().draft.model
			: subagentModel(mounted.result()).props.title.replace(/^custom\//, "").replace(/^subagents.pickModel$/, ""),
		select: () => host.act(async () => {
			if (kind === "vision") mounted.result().updateDraft({ provider: removedModel.provider, model: removedModel.modelId });
			else nodes(mounted.result(), (node) => node.type === "CommandItem")[0].props.onSelect();
		}),
		save: () => host.act(async () => {
			if (kind === "vision") await mounted.result().save();
			else saveButton(mounted.result()).props.onClick();
		}),
		startSave: () => host.act(async () => {
			if (kind === "vision") void mounted.result().save();
			else saveButton(mounted.result()).props.onClick();
		}),
	};
}

for (const kind of ["vision", "subagent"]) {
	test(`${kind} can save and reopen a native choice after the same WSL identity was deleted`, async () => {
		await withHookHost(async (host) => {
			const env = setup(host);
			await env.remove("wsl");
			const editor = await sharedSettingsEditor(host, env, kind);
			await editor.select();
			await editor.save();
			assert.equal(editor.writes(), 1);
			await editor.open();
			assert.equal(editor.selected(), removedModel.modelId);
			assert.equal(env.store.get(env.atoms.removedModelReferencesByScopeAtom).wsl.length, 1, "the WSL removal remains valid for WSL sessions");
		});
	});
	test(`${kind} cannot save a stale picker choice deleted in the current environment`, async () => {
		await withHookHost(async (host) => {
			const env = setup(host);
			await env.remove("native");
			const editor = await sharedSettingsEditor(host, env, kind);
			await editor.select();
			await editor.save();
			assert.equal(editor.writes(), 0);
			assert.equal(editor.selected(), "");
		});
	});
	test(`${kind} failed saves retain the shared removal`, async () => {
		await withHookHost(async (host) => {
			const env = setup(host);
			await env.remove("wsl");
			const editor = await sharedSettingsEditor(host, env, kind, async () => ({ ok: false }));
			await editor.select();
			await editor.save();
			assert.equal(env.store.get(env.atoms.sharedRemovedModelReferencesAtom).length, 1);
			assert.equal(editor.selected(), removedModel.modelId, "failed saves must preserve the editable choice");
		});
	});
	test(`${kind} successful saves cannot erase a newer deletion received while saving`, async () => {
		await withHookHost(async (host) => {
			const env = setup(host);
			await env.remove("wsl");
			const pending = deferred();
			const editor = await sharedSettingsEditor(host, env, kind, () => pending.promise);
			await editor.select();
			await editor.startSave();
			await env.remove("wsl");
			await host.act(async () => pending.resolve({ ok: true }));
			await editor.open();
			assert.equal(editor.selected(), "");
			assert.equal(env.store.get(env.atoms.sharedRemovedModelReferencesAtom).length, 1);
		});
	});
}

function uiStubs(prefix) {
	return {
		[`${prefix}/button`]: { ...primitive("Button"), buttonVariants: () => "" },
		[`${prefix}/dialog`]: primitive("Dialog", "DialogClose", "DialogContent", "DialogDescription", "DialogHeader", "DialogTitle"),
		[`${prefix}/select`]: primitive("Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"),
		[`${prefix}/switch`]: primitive("Switch"),
		[`${prefix}/popover`]: primitive("Popover", "PopoverContent", "PopoverTrigger"),
		[`${prefix}/command`]: primitive("Command", "CommandEmpty", "CommandInput", "CommandItem", "CommandList"),
		[`${prefix}/tabs`]: primitive("Tabs", "TabsContent", "TabsList", "TabsTrigger"),
		[`${prefix}/input`]: primitive("Input"),
		[`${prefix}/textarea`]: primitive("Textarea"),
		[`${prefix}/ConfirmDialog`]: primitive("ConfirmDialog"),
		[`${prefix}/alert-dialog`]: primitive("AlertDialog", "AlertDialogAction", "AlertDialogCancel", "AlertDialogContent", "AlertDialogDescription", "AlertDialogFooter", "AlertDialogHeader", "AlertDialogTitle"),
	};
}

function saveButton(tree) {
	return nodes(tree, (node) => node.type === "Button" && (node.props.children === "common.save" || node.props.children?.includes?.("common.save")))[0];
}

async function mountConfig(host, env, getSettings, options = {}) {
	const stubs = {
		...uiStubs("./components/ui-shadcn"),
		"./desktopApi": { desktopApi: { config: { getSettings, getModels: async () => ({ parsed: { providers: {} }, raw: "{}" }), ...options.config }, projects: { listModels: async () => [], ...options.projects } } },
		"./atoms/model-atoms": env.atoms,
		"./utils/notice": { showNotice() {} },
		"./i18n": { t: (key) => key },
		"./config/ConfigShared": { openDocsInSystemBrowser: () => () => {} },
		"./components/config/SecuritySection": primitive("SecuritySection"),
		"./components/app/CodeMirrorEditor": primitive("CodeMirrorEditor"),
		"./config/promptEditorStorage": { createGlobalPromptEditorStorage: () => ({}) },
		"./hooks/usePromptTemplateEditor": { usePromptTemplateEditor: () => ({}) },
		"./composerBehavior": { translateBuiltinPromptDescription: (value) => value },
	};
	for (const name of ["ModelsTab", "RawTab", "TrustTab", "SettingsTab", "PromptsTab", "SkillsTab", "ExtensionsTab"]) stubs[`./config/${name}`] = primitive(name);
	const { ConfigModal } = host.load("src/renderer/src/ConfigModal.tsx", {
		stubs,
		globals: { localStorage: { getItem: () => options.initialTab ?? "config:settings", setItem() {} } },
	});
	const props = { open: true, onClose() {}, onSaved() {} };
	const content = ConfigModal(props).props.children;
	return host.mount(content.type, props, env.wrap);
}

test("Pi settings use runtime model metadata without exposing credential management", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const mounted = await mountConfig(host, env, async () => ({ parsed: { defaultProvider: "external", defaultModel: "runtime-model" }, raw: "{}" }), {
			projects: { listModels: async () => [{ provider: "external", id: "runtime-model", name: "Available model" }] },
		});
		const settings = nodes(mounted.result(), (node) => node.type === "SettingsTab")[0];
		assert.deepEqual(copy(settings.props.discoveredModels), { external: [{ id: "runtime-model", name: "Available model" }] });
		assert.equal(Object.hasOwn(settings.props, "authData"), false);
		assert.equal(settings.props.data.defaultModel, "runtime-model");
		assert.equal(nodes(mounted.result(), (node) => node.type === "TabsTrigger" && node.props.value === "config:auth").length, 0);
	});
});

test("a saved authentication tab migrates to model settings", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const mounted = await mountConfig(host, env, async () => ({ parsed: {}, raw: "{}" }), { initialTab: "config:auth" });
		assert.equal(nodes(mounted.result(), (node) => node.type === "Tabs")[0].props.value, "config:models");
		assert.equal(nodes(mounted.result(), (node) => node.type === "ModelsTab").length, 1);
	});
});

test("Pi settings ignore runtime models from a previous configuration scope", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const old = deferred();
		let requests = 0;
		const mounted = await mountConfig(host, env, async () => ({ parsed: {}, raw: "{}" }), {
			projects: { listModels: () => ++requests === 1 ? old.promise : Promise.resolve([{ provider: "wsl", id: "current" }]) },
		});
		await host.act(async () => env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl"));
		await host.act(async () => old.resolve([{ provider: "native", id: "stale" }]));
		const settings = nodes(mounted.result(), (node) => node.type === "SettingsTab")[0];
		assert.deepEqual(copy(settings.props.discoveredModels), { wsl: [{ id: "current" }] });
	});
});

test("late pi settings loads cannot restore deleted defaults or mark untouched settings dirty", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const pending = deferred();
		const mounted = await mountConfig(host, env, () => pending.promise);
		await env.remove();
		await host.act(async () => pending.resolve({ parsed: { defaultProvider: removedModel.provider, defaultModel: removedModel.modelId, defaultThinkingLevel: "high", subagents: { defaultProvider: removedModel.provider, defaultModel: removedModel.modelId, preferDelegation: true } }, raw: "{}" }));
		const data = nodes(mounted.result(), (node) => node.type === "SettingsTab")[0].props.data;
		assert.equal(data.defaultModel, "");
		assert.equal(data.defaultProvider, "");
		assert.equal(data.subagents.defaultModel, "");
		assert.equal(data.subagents.preferDelegation, true);
		assert.equal(data.defaultThinkingLevel, "high");
		assert.equal(saveButton(mounted.result()).props.disabled, true);
	});
});

test("a pi settings read cannot restore a default deleted and re-added while it was pending", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const pending = deferred();
		const mounted = await mountConfig(host, env, () => pending.promise);
		await env.remove();
		await host.act(async () => {
			env.store.set(env.atoms.removedModelReferencesByScopeAtom, { native: [], wsl: [] });
			env.store.set(env.atoms.sharedRemovedModelReferencesAtom, []);
		});
		await host.act(async () => pending.resolve({ parsed: { defaultProvider: removedModel.provider, defaultModel: removedModel.modelId }, raw: "{}" }));
		assert.equal(nodes(mounted.result(), (node) => node.type === "SettingsTab")[0].props.data.defaultModel, "");
	});
});

test("editing model metadata keeps a pending pi default valid", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const pending = deferred();
		const mounted = await mountConfig(host, env, () => pending.promise);
		await host.act(async () => env.store.set(env.atoms.modelConfigurationVersionsByScopeAtom, {
			native: { [JSON.stringify([removedModel.provider, removedModel.modelId])]: 1 }, wsl: {},
		}));
		await host.act(async () => pending.resolve({ parsed: { defaultProvider: removedModel.provider, defaultModel: removedModel.modelId }, raw: "{}" }));
		assert.equal(nodes(mounted.result(), (node) => node.type === "SettingsTab")[0].props.data.defaultModel, removedModel.modelId);
	});
});

test("pi settings invalidation preserves edited fields and their dirty state", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const mounted = await mountConfig(host, env, async () => ({ parsed: { defaultProvider: removedModel.provider, defaultModel: removedModel.modelId }, raw: "{}" }));
		const settings = nodes(mounted.result(), (node) => node.type === "SettingsTab")[0];
		await host.act(async () => settings.props.onChange({ ...settings.props.data, defaultThinkingLevel: "low", customOption: "unsaved" }));
		await env.remove();
		const data = nodes(mounted.result(), (node) => node.type === "SettingsTab")[0].props.data;
		assert.equal(data.defaultModel, "");
		assert.equal(data.defaultThinkingLevel, "low");
		assert.equal(data.customOption, "unsaved");
		assert.equal(saveButton(mounted.result()).props.disabled, false);
	});
});

test("pi settings from an old environment cannot replace the current environment's settings", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const requests = [];
		const mounted = await mountConfig(host, env, () => {
			const pending = deferred(); requests.push(pending); return pending.promise;
		});
		const native = requests[0];
		await env.remove("native");
		await host.act(async () => env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl"));
		assert.notEqual(requests.at(-1), native, "changing config roots must start a current read");
		await host.act(async () => requests.at(-1).resolve({ parsed: { defaultProvider: removedModel.provider, defaultModel: removedModel.modelId, cwd: "wsl" }, raw: "{}" }));
		await host.act(async () => native.resolve({ parsed: { defaultProvider: "native", defaultModel: "stale", cwd: "native" }, raw: "{}" }));
		const data = nodes(mounted.result(), (node) => node.type === "SettingsTab")[0].props.data;
		assert.equal(data.cwd, "wsl");
		assert.equal(data.defaultModel, removedModel.modelId, "native removals cannot clear WSL defaults");
	});
});

test("pi settings reload when only the WSL user changes and reject the old account read", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl");
		env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "alice" });
		const requests = [];
		const mounted = await mountConfig(host, env, () => { const request = deferred(); requests.push(request); return request.promise; });
		const old = requests[0];
		await host.act(async () => env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "bob" }));
		assert.notEqual(requests.at(-1), old);
		await host.act(async () => requests.at(-1).resolve({ parsed: { defaultProvider: "bob", defaultModel: "current" }, raw: "{}" }));
		await host.act(async () => old.resolve({ parsed: { defaultProvider: "alice", defaultModel: "stale" }, raw: "{}" }));
		assert.equal(nodes(mounted.result(), (node) => node.type === "SettingsTab")[0].props.data.defaultProvider, "bob");
	});
});

test("Git model lists refresh on configuration scope changes and hide the previous scope while loading", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const requests = [];
		const { useGitModels } = host.load("src/renderer/src/components/app/settings/gitModels.ts", {
			stubs: {
				"../../../atoms/model-atoms": env.atoms,
				"../../../desktopApi": { desktopApi: { projects: { listModels: () => { const request = deferred(); requests.push(request); return request.promise; } } } },
			},
		});
		const mounted = await host.mount(useGitModels, undefined, env.wrap);
		await host.act(async () => requests[0].resolve([model("native")]));
		await host.act(async () => {
			env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl");
			env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "alice" });
		});
		assert.equal(mounted.result().gitModels.length, 0);
		const alice = requests.at(-1);
		await host.act(async () => env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "bob" }));
		assert.notEqual(requests.at(-1), alice);
		await host.act(async () => requests.at(-1).resolve([model("bob")]));
		await host.act(async () => alice.resolve([model("alice")]));
		assert.equal(mounted.result().gitModels[0].id, "bob");
	});
});

test("a model save awaiting specification lookup cannot write into a newly selected configuration scope", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const pending = deferred();
		const writes = [];
		const mounted = await mountConfig(host, env, async () => ({ parsed: {}, raw: "{}" }), {
			initialTab: "config:models",
			config: {
				getModels: async () => ({ parsed: { providers: { custom: { models: [{ id: "one" }] } } }, raw: "{}" }),
				saveModels: async (value) => { writes.push(value); return { valid: true }; },
			},
			projects: { getModelSpec: () => pending.promise },
		});
		await host.act(async () => { void nodes(mounted.result(), (node) => node.type === "ModelsTab")[0].props.onSave(); });
		await host.act(async () => env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl"));
		await host.act(async () => pending.resolve(null));
		assert.equal(writes.length, 0);
	});
});

test("failed pi settings saves keep the editable draft and dirty marker", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const mounted = await mountConfig(host, env, async () => ({ parsed: { defaultThinkingLevel: "medium" }, raw: "{}" }), {
			config: { saveSettings: async () => ({ valid: false, error: "read-only" }) },
		});
		const settings = () => nodes(mounted.result(), (node) => node.type === "SettingsTab")[0];
		await host.act(async () => settings().props.onChange({ ...settings().props.data, defaultThinkingLevel: "high" }));
		await host.act(async () => settings().props.onSave());
		assert.equal(settings().props.data.defaultThinkingLevel, "high");
		assert.equal(saveButton(mounted.result()).props.disabled, false);
	});
});

test("a successful pi settings save cannot discard edits made while it was pending", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const pending = deferred();
		const mounted = await mountConfig(host, env, async () => ({ parsed: { defaultThinkingLevel: "medium" }, raw: "{}" }), {
			config: { saveSettings: () => pending.promise },
		});
		const settings = () => nodes(mounted.result(), (node) => node.type === "SettingsTab")[0];
		await host.act(async () => settings().props.onChange({ ...settings().props.data, defaultThinkingLevel: "high" }));
		await host.act(async () => { void settings().props.onSave(); });
		await host.act(async () => settings().props.onChange({ ...settings().props.data, defaultThinkingLevel: "low" }));
		await host.act(async () => pending.resolve({ valid: true }));
		assert.equal(settings().props.data.defaultThinkingLevel, "low");
		assert.equal(saveButton(mounted.result()).props.disabled, false);
	});
});

function loadVisionDraft(host, env, config) {
	return host.load("src/renderer/src/components/app/settings/visionDraft.ts", {
		stubs: {
			"../../../desktopApi": { desktopApi: { config } },
			"../../../atoms/model-atoms": env.atoms,
			"../../../atoms/session-atoms": { visionConfigRevisionAtom: atom(0) },
			"../../../i18n": { t: (key) => key },
			"../../../utils/notice": { showNotice() {} },
		},
	}).useVisionBridgeDraft;
}

for (const environment of ["native", "wsl"]) {
	test(`late vision config loads use the latest ${environment} deletion record`, async () => {
		await withHookHost(async (host) => {
			const env = setup(host);
			env.store.set(env.atoms.modelConfigurationEnvironmentAtom, environment);
			const pending = deferred();
			const hook = loadVisionDraft(host, env, { visionGetConfig: () => pending.promise });
			const mounted = await host.mount(hook, undefined, env.wrap);
			await env.remove(environment);
			await host.act(async () => pending.resolve({ config: { enabled: true, provider: removedModel.provider, model: removedModel.modelId, maxTokens: 1234, api: "openai-completions", baseUrl: "https://old.invalid/v1", apiKey: "old-test-key" }, configDir: "/config" }));
			assert.equal(mounted.result().draft.provider, "");
			assert.equal(mounted.result().draft.model, "");
			assert.equal(mounted.result().draft.maxTokens, 1234);
			for (const key of ["api", "baseUrl", "apiKey"]) assert.equal(key in mounted.result().draft, false, `${key} must not carry into the replacement model`);
			assert.equal(mounted.result().dirty, false);
			await host.act(async () => mounted.result().reset());
			assert.equal(mounted.result().draft.model, "", "reset must use the sanitized baseline too");
		});
	});
}

test("shared vision config clears removals from either environment and preserves unsaved nonmodel edits", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const pending = deferred();
		const hook = loadVisionDraft(host, env, { visionGetConfig: () => pending.promise });
		const mounted = await host.mount(hook, undefined, env.wrap);
		await host.act(async () => pending.resolve({ config: { enabled: true, provider: removedModel.provider, model: removedModel.modelId, promptTemplate: "original", api: "openai-completions", baseUrl: "https://old.invalid/v1", apiKey: "old-test-key" }, configDir: "/config" }));
		assert.equal(mounted.result().draft.model, removedModel.modelId);
		await host.act(async () => mounted.result().updateDraft({ enabled: false, promptTemplate: "unsaved prompt", timeoutMs: 12345, concurrency: 4 }));
		await env.remove("wsl");
		assert.equal(mounted.result().draft.model, "");
		assert.equal(mounted.result().draft.promptTemplate, "unsaved prompt");
		assert.equal(mounted.result().draft.timeoutMs, 12345);
		assert.equal(mounted.result().draft.enabled, false);
		assert.equal(mounted.result().draft.concurrency, 4);
		for (const key of ["api", "baseUrl", "apiKey"]) assert.equal(key in mounted.result().draft, false);
		assert.equal(mounted.result().dirty, true);
	});
});

async function mountSubagents(host, env, subagents, listModels = async () => []) {
	const { SubagentSettingsDialog } = host.load("src/renderer/src/components/subagents/SubagentSettingsDialog.tsx", {
		stubs: {
			...uiStubs("../ui-shadcn"),
			"../../desktopApi": { desktopApi: { subagents, projects: { listModels } } },
			"../../atoms/model-atoms": env.atoms,
			"../../i18n": { t: (key) => key },
			"../../utils/notice": { showNotice() {} },
		},
	});
	return host.mount(SubagentSettingsDialog, { open: true, projectId: "project", onClose() {} }, env.wrap);
}

const subagentSnapshot = () => ({ global: { useOwnModel: true, preferDelegation: false, model: removedModel }, project: { useOwnModel: true, preferDelegation: true, model: removedModel } });
const subagentModel = (tree) => nodes(tree, (node) => node.type === "Button" && typeof node.props.title === "string")[0];

test("late subagent settings loads clear both scope defaults and keep the baseline clean", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const pending = deferred();
		const mounted = await mountSubagents(host, env, { getSettings: () => pending.promise });
		await env.remove();
		await host.act(async () => pending.resolve(subagentSnapshot()));
		assert.equal(subagentModel(mounted.result()).props.title, "subagents.pickModel");
		assert.equal(saveButton(mounted.result()).props.disabled, true);
		const projectButton = nodes(mounted.result(), (node) => node.type === "Button" && node.props.children === "subagents.scopeProject")[0];
		await host.act(async () => projectButton.props.onClick());
		assert.equal(subagentModel(mounted.result()).props.title, "subagents.pickModel");
		assert.equal(nodes(mounted.result(), (node) => node.type === "Switch" && node.props["aria-label"] === "subagents.preferDelegation")[0].props.checked, true);
		assert.equal(saveButton(mounted.result()).props.disabled, true);
	});
});

test("subagent deletion preserves unsaved delegation edits in both scopes", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const mounted = await mountSubagents(host, env, { getSettings: async () => subagentSnapshot() });
		const delegation = () => nodes(mounted.result(), (node) => node.type === "Switch" && node.props["aria-label"] === "subagents.preferDelegation")[0];
		await host.act(async () => delegation().props.onCheckedChange(true));
		await env.remove();
		assert.equal(delegation().props.checked, true);
		assert.equal(subagentModel(mounted.result()).props.title, "subagents.pickModel");
		assert.equal(saveButton(mounted.result()).props.disabled, false);
	});
});

test("late initial subagent model lists cannot overwrite a newer revision", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const requests = [];
		const mounted = await mountSubagents(host, env, { getSettings: async () => subagentSnapshot() }, () => {
			const pending = deferred(); requests.push(pending); return pending.promise;
		});
		const oldRequests = [...requests];
		await env.revise();
		await host.act(async () => requests.at(-1).resolve([model("fresh")]));
		await host.act(async () => oldRequests.forEach((pending) => pending.resolve([model("old")])));
		assert.deepEqual(nodes(mounted.result(), (node) => node.type === "CommandItem").map((node) => node.props.value), ["custom fresh fresh"]);
	});
});

test("subagent model lists reject reads from the previous WSL user", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl");
		env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "alice" });
		const requests = [];
		const mounted = await mountSubagents(host, env, { getSettings: async () => subagentSnapshot() }, () => {
			const pending = deferred(); requests.push(pending); return pending.promise;
		});
		const alice = requests[0];
		await host.act(async () => env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "bob" }));
		assert.notEqual(requests.at(-1), alice);
		await host.act(async () => requests.at(-1).resolve([model("bob")]));
		await host.act(async () => alice.resolve([model("alice")]));
		assert.deepEqual(nodes(mounted.result(), (node) => node.type === "CommandItem").map((node) => node.props.value), ["custom bob bob"]);
	});
});

test("subagent saves stop before the next scope write if the WSL account changes", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		env.store.set(env.atoms.modelConfigurationEnvironmentAtom, "wsl");
		env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "alice" });
		const pending = deferred();
		const writes = [];
		const mounted = await mountSubagents(host, env, {
			getSettings: async () => subagentSnapshot(),
			saveSettings: (scope) => { writes.push(scope); return writes.length === 1 ? pending.promise : Promise.resolve({ ok: true }); },
		});
		const delegation = () => nodes(mounted.result(), (node) => node.type === "Switch" && node.props["aria-label"] === "subagents.preferDelegation")[0];
		await host.act(async () => delegation().props.onCheckedChange(true));
		await host.act(async () => nodes(mounted.result(), (node) => node.type === "Button" && node.props.children === "subagents.scopeProject")[0].props.onClick());
		await host.act(async () => delegation().props.onCheckedChange(false));
		await host.act(async () => saveButton(mounted.result()).props.onClick());
		assert.deepEqual(writes, ["global"]);
		await host.act(async () => env.store.set(env.atoms.modelConfigurationWslIdentityAtom, { wslDistro: "Ubuntu", wslUser: "bob" }));
		await host.act(async () => pending.resolve({ ok: true }));
		assert.deepEqual(writes, ["global"]);
	});
});

for (const phase of ["initial", "saved-read", "save-ack"]) {
	test(`subagent ${phase} cannot restore a model deleted and re-added while the request was pending`, async () => {
		await withHookHost(async (host) => {
			const env = setup(host);
			const pending = deferred();
			let reads = 0;
			const mounted = await mountSubagents(host, env, {
				getSettings: () => {
					reads += 1;
					return phase === "initial" || phase === "saved-read" && reads > 1 ? pending.promise : Promise.resolve(subagentSnapshot());
				},
				saveSettings: () => phase === "save-ack" ? pending.promise : Promise.resolve({ ok: true }),
			});
			if (phase !== "initial") {
				await host.act(async () => nodes(mounted.result(), (node) => node.type === "Switch" && node.props["aria-label"] === "subagents.preferDelegation")[0].props.onCheckedChange(true));
				await host.act(async () => saveButton(mounted.result()).props.onClick());
			}
			await env.remove();
			await host.act(async () => {
				env.store.set(env.atoms.sharedRemovedModelReferencesAtom, []);
				env.store.set(env.atoms.removedModelReferencesByScopeAtom, { native: [], wsl: [] });
			});
			await host.act(async () => pending.resolve(phase === "save-ack" ? { ok: true } : subagentSnapshot()));
			assert.equal(subagentModel(mounted.result()).props.title, "subagents.pickModel");
			if (phase === "initial") assert.equal(saveButton(mounted.result()).props.disabled, true);
		});
	});
}

for (const staleOutcome of ["success", "failure"]) {
	test(`late vision model list ${staleOutcome} cannot overwrite a newer revision`, async () => {
		await withHookHost(async (host) => {
			const env = setup(host);
			const requests = [];
			const { VisionBridgeSettingsTab } = host.load("src/renderer/src/components/app/settings/VisionBridgeSettingsTab.tsx", {
				stubs: {
					...uiStubs("../../ui-shadcn"),
					"../../../desktopApi": { desktopApi: { config: { visionGetLog: async () => null }, projects: { listModels: () => { const pending = deferred(); requests.push(pending); return pending.promise; } } } },
					"../../../atoms/model-atoms": env.atoms,
					"../../../atoms/session-atoms": { visionConfigRevisionAtom: atom(0) },
					"../../../i18n": { t: (key) => key },
					"../../../utils/notice": { showNotice() {} },
					"../../session/ComposerComponents": primitive("ModelPicker"),
					"./SettingsStorageTab": primitive("SettingsSection"),
					"./SettingRows": primitive("SettingRow", "SettingSwitchRow"),
				},
			});
			const mounted = await host.mount(VisionBridgeSettingsTab, { draft: { enabled: true, provider: "custom", model: "fresh" }, saving: false, configDir: "/config", notice: null, onChange() {} }, env.wrap);
			const pickerButton = nodes(mounted.result(), (node) => node.type === "Button" && node.props.className?.includes("font-mono"))[0];
			await host.act(async () => { void pickerButton.props.onClick(); });
			await host.act(async () => requests[1].resolve([model("intermediate")]));
			await env.revise();
			const latest = [model("fresh")];
			await host.act(async () => requests.at(-1).resolve(latest));
			await host.act(async () => staleOutcome === "success" ? requests[0].resolve([model("stale")]) : requests[0].reject(new Error("stale read failed")));
			assert.deepEqual(copy(nodes(mounted.result(), (node) => node.type === "ModelPicker")[0].props.models), latest);
		});
	});
}
