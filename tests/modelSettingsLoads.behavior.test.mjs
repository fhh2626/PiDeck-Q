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
	for (const name of ["ModelsTab", "RawTab", "SettingsTab", "PromptsTab", "SkillsTab", "ExtensionsTab"]) stubs[`./config/${name}`] = primitive(name);
	const { ConfigModal } = host.load("src/renderer/src/ConfigModal.tsx", {
		stubs,
		globals: { localStorage: { getItem: () => options.initialTab ?? "config:settings", setItem() {} } },
	});
	const props = { open: true, onClose: options.onClose ?? (() => {}), onSaved() {} };
	const content = ConfigModal(props).props.children;
	if (!options.realModels) return host.mount(content.type, props, env.wrap);
	const { ModelsTab } = host.load("src/renderer/src/config/ModelsTab.tsx", { stubs: {
		...uiStubs("../components/ui-shadcn"),
		"../components/ui-shadcn/checkbox": primitive("Checkbox"),
		"../components/ui-shadcn/label": primitive("Label"),
		"../components/ui-shadcn/table": primitive("Table", "TableBody", "TableCell", "TableHead", "TableHeader", "TableRow"),
		"./ConfigShared": { ...primitive("ApiTypeInput", "ConfigSelect", "SecretInput"), ...stubs["./config/ConfigShared"] },
		"../desktopApi": stubs["./desktopApi"],
		"../utils/notice": stubs["./utils/notice"],
		"../i18n": stubs["./i18n"],
	} });
	// Run both production render functions in the hook probe, keeping the visual primitives opaque.
	return host.mount((props) => {
		const modal = content.type(props);
		const tab = nodes(modal, (node) => node.type === "ModelsTab")[0];
		const models = ModelsTab(tab?.props ?? { data: { providers: {} } });
		return { modal, models };
	}, props, env.wrap);
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

test("Pi management removes project trust and migrates its saved tab to models", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const mounted = await mountConfig(host, env, async () => ({ parsed: {}, raw: "{}" }), { initialTab: "config:trust" });
		assert.equal(nodes(mounted.result(), (node) => node.type === "Tabs")[0].props.value, "config:models");
		assert.equal(nodes(mounted.result(), (node) => node.type === "ModelsTab").length, 1);
		assert.equal(nodes(mounted.result(), (node) => node.type === "TabsTrigger" && node.props.value === "config:trust").length, 0);
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

test("a new model without a known output limit leaves maxTokens unset when saved", async () => {
	await withHookHost(async (host) => {
		const env = setup(host);
		const writes = [];
		const mounted = await mountConfig(host, env, async () => ({ parsed: {}, raw: "{}" }), {
			initialTab: "config:models",
			config: {
				getModels: async () => ({ parsed: writes.at(-1) ?? { providers: { custom: { models: [{ id: "existing", maxTokens: 128000 }] } } }, raw: "{}" }),
				saveModels: async (value) => { writes.push(copy(value)); return { valid: true }; },
			},
			projects: { getModelSpec: async () => null },
		});
		const models = () => nodes(mounted.result(), (node) => node.type === "ModelsTab")[0].props;
		await host.act(() => models().onAddModel("custom"));
		await host.act(() => models().onUpdateModel("custom", 1, "id", "custom-model"));
		await host.act(async () => models().onSave());
		assert.equal(writes.length, 1);
		assert.equal(writes[0].providers.custom.models[0].maxTokens, 128000);
		assert.equal(Object.hasOwn(writes[0].providers.custom.models[1], "maxTokens"), false);

		await host.act(() => models().onUpdateModel("custom", 1, "maxTokens", 16384));
		await host.act(async () => models().onSave());
		assert.equal(writes.length, 2);
		assert.equal(writes[1].providers.custom.models[1].maxTokens, 16384, "entering the fallback explicitly still saves it");
	});
});

const catalogSpec = { source: "models-dev", matchedId: "gpt-4o", maxTokens: 16384, contextWindow: 128000 };

/** Drive the model inputs and dialog Save button with only the persistence/catalog boundary mocked. */
async function openModelEditor(host, getModelSpec, initialModels = [], beforeRead = () => {}, options = {}) {
	const writes = [];
	const mounted = await mountConfig(host, setup(host), async () => ({ parsed: {}, raw: "{}" }), {
		initialTab: "config:models",
		realModels: true,
		onClose: options.onClose,
		config: {
			getModels: async () => {
				beforeRead(writes.length);
				return { parsed: writes.at(-1) ?? { providers: {
					openai: { baseUrl: "https://openai.example", apiKey: "mock", models: initialModels },
					...options.providers,
				} }, raw: "{}" };
			},
			saveModels: async (value) => { writes.push(copy(value)); return { valid: true }; },
			fetchModels: async () => ({ success: true, models: [{ id: "gpt-4o" }] }),
		},
		projects: { getModelSpec },
	});
	const find = (predicate) => nodes(mounted.result().models, predicate)[0].props;
	const input = (placeholder) => find((node) => node.type === "Input" && node.props.placeholder === placeholder);
	const change = (placeholder, value) => host.act(() => input(placeholder).onChange({ target: { value } }));
	await host.act(() => find((node) => node.type === "div" && node.props.className?.startsWith("flex cursor-pointer items-center justify-between")).onClick());
	const click = (label) => host.act(() => find((node) => node.type === "Button"
		&& (node.props.title === label || node.props.children?.includes?.(label))).onClick({ stopPropagation() {} }));
	if (initialModels.length === 0 && !options.skipManualAdd) {
		await click("config.addModelManual");
		await change("model-id", "gpt-4o");
	}
	return {
		writes,
		change,
		duplicate: () => click("config.duplicateProvider"),
		requestDeletion: (kind) => host.act(() => {
			const tab = nodes(mounted.result().modal, (node) => node.type === "ModelsTab")[0].props;
			if (kind === "model") tab.onDeleteModel("openai", 0);
			else if (kind === "provider") tab.onDeleteProvider("unrelated");
			else tab.onDeleteProviders(["unrelated", "another"]);
		}),
		confirmDeletion: () => host.act(() => nodes(mounted.result().modal,
			(node) => node.type === "ConfirmDialog" && node.props.confirmLabel === "common.delete")[0].props.onConfirm()),
		addFetched: async () => {
			await click("config.fetchModels");
			await host.act(() => find((node) => typeof node.type === "function" && node.props.existingModelIds).onChange(["gpt-4o"]));
			await host.act(() => { void find((node) => node.type === "Button" && node.props.children === "config.saveSelectedModels").onClick(); });
		},
		value: (placeholder) => input(placeholder).value,
		blur: () => host.act(() => input("model-id").onBlur({ target: { value: input("model-id").value } })),
		save: () => host.act(() => saveButton(mounted.result().modal).props.onClick()),
		saveAndClose: async () => {
			await host.act(() => nodes(mounted.result().modal, (node) => node.type === "Dialog")[0].props.onOpenChange(false));
			await host.act(() => nodes(mounted.result().modal, (node) => node.type === "AlertDialogAction"
				&& node.props.children === "config.saveAndClose")[0].props.onClick());
		},
	};
}

for (const kind of ["model", "provider", "batch"]) {
	test(`confirming a ${kind} deletion preserves fetched models appended while confirmation is open`, async () => {
		await withHookHost(async (host) => {
			const pending = deferred();
			const editor = await openModelEditor(host, (_provider, id) => id === "gpt-4o" ? pending.promise : Promise.resolve(null),
				[{ id: "existing", maxTokens: 2048 }], undefined,
				{ providers: { unrelated: { models: [] }, another: { models: [] } } });
			await editor.addFetched();
			await editor.requestDeletion(kind);
			await host.act(() => pending.resolve(catalogSpec));
			await editor.confirmDeletion();
			await editor.save();
			const { providers } = editor.writes[0];
			assert.deepEqual(providers.openai.models.map(({ id, maxTokens }) => [id, maxTokens]),
				kind === "model" ? [["gpt-4o", 16384]] : [["existing", 2048], ["gpt-4o", 16384]]);
			assert.equal(Object.hasOwn(providers, "unrelated"), kind === "model");
			assert.equal(Object.hasOwn(providers, "another"), kind !== "batch");
		});
	});
}

for (const [placeholder, value, expected] of [["16384", "2048", 2048], ["model-id", "unknown-b", "unknown-b"]]) {
	test(`a late model spec does not overwrite the edited ${placeholder === "model-id" ? "identity" : "output limit"}`, async () => {
		await withHookHost(async (host) => {
			const pending = deferred();
			const editor = await openModelEditor(host, (_provider, id) => id === "gpt-4o" ? pending.promise : Promise.resolve(null));
			await editor.blur();
			await editor.change(placeholder, value);
			await host.act(() => pending.resolve(catalogSpec));
			assert.equal(editor.value(placeholder), expected);
			await editor.save();
			const saved = editor.writes[0].providers.openai.models[0];
			assert.equal(saved.maxTokens, placeholder === "model-id" ? undefined : 2048);
		});
	});
}

test("an unsaved catalog limit does not follow a corrected model ID", async () => {
	await withHookHost(async (host) => {
		const editor = await openModelEditor(host, async (_provider, id) => id === "gpt-4o" ? catalogSpec : null);
		await editor.blur();
		assert.equal(editor.value("16384"), 16384);
		await editor.change("model-id", "unknown-b");
		await editor.blur();
		await editor.save();
		const saved = editor.writes[0].providers.openai.models[0];
		assert.equal(saved.id, "unknown-b");
		assert.equal(Object.hasOwn(saved, "maxTokens"), false);
	});
});

test("saving a known model keeps the settings of an unrelated empty provider", async () => {
	await withHookHost(async (host) => {
		const vendor = {
			baseUrl: "https://proxy.example", models: [],
			compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
		};
		const editor = await openModelEditor(host, async () => catalogSpec, [], undefined, { providers: { vendor } });
		await editor.save();
		const { providers } = editor.writes[0];
		assert.equal(providers.openai.models[0].maxTokens, 16384);
		assert.deepEqual(providers.vendor, vendor);
	});
});

for (const origin of ["fetched", "duplicated"]) {
	test(`correcting a ${origin} model ID drops its unsaved catalog limit`, async () => {
		await withHookHost(async (host) => {
			const editor = await openModelEditor(host, async (_provider, id) => id === "gpt-4o"
				? { ...catalogSpec, maxTokens: 30123 } : null, [], undefined, { skipManualAdd: origin === "fetched" });
			if (origin === "fetched") await editor.addFetched();
			else {
				await editor.blur();
				await editor.duplicate();
			}
			assert.equal(editor.value("16384"), 30123);
			await editor.change("model-id", "unknown-b");
			await editor.save();
			const saved = editor.writes[0].providers[origin === "fetched" ? "openai" : "openai copy"].models[0];
			assert.equal(saved.id, "unknown-b");
			assert.equal(Object.hasOwn(saved, "maxTokens"), false);
		});
	});
}

test("a fetched add completing after an output limit edit retains the edit", async () => {
	await withHookHost(async (host) => {
		const lookup = deferred();
		const editor = await openModelEditor(host, (_provider, id) => id === "gpt-4o" ? lookup.promise : Promise.resolve(null),
			[{ id: "existing-model", maxTokens: 256 }]);
		await editor.addFetched();
		await editor.change("16384", "2048");
		await host.act(() => lookup.resolve(catalogSpec));
		await editor.save();
		assert.deepEqual(editor.writes[0].providers.openai.models.map(({ id, maxTokens }) => [id, maxTokens]),
			[["existing-model", 2048], ["gpt-4o", 16384]]);
	});
});

for (const action of ["save", "saveAndClose"]) {
	test(`${action} includes an already selected fetched model before refreshing the draft`, async () => {
		await withHookHost(async (host) => {
			const fetched = deferred();
			let closes = 0;
			const editor = await openModelEditor(host, (_provider, id) => id === "gpt-4o" ? fetched.promise : Promise.resolve(null),
				[{ id: "existing-model", maxTokens: 256 }], undefined, { onClose: () => { closes++; } });
			await editor.change("16384", "2048");
			await editor.addFetched();
			await editor[action]();
			const wroteBeforeLookup = editor.writes.length;
			await host.act(() => fetched.resolve(catalogSpec));
			assert.equal(wroteBeforeLookup, 0);
			assert.deepEqual(editor.writes[0]?.providers.openai.models.map(({ id, maxTokens }) => [id, maxTokens]),
				[["existing-model", 2048], ["gpt-4o", 16384]]);
			assert.equal(editor.writes.length, 1);
			assert.equal(closes, action === "saveAndClose" ? 1 : 0);
		});
	});
}

test("a fetched add invalidates a Save still preparing an older model list", async () => {
	await withHookHost(async (host) => {
		const fetched = deferred();
		const saving = deferred();
		const editor = await openModelEditor(host, (_provider, id) => id === "gpt-4o" ? fetched.promise : saving.promise,
			[{ id: "existing-model", maxTokens: 256 }]);
		await editor.change("16384", "2048");
		await editor.save();
		await editor.addFetched();
		await host.act(() => {
			saving.resolve(null);
			fetched.resolve(catalogSpec);
		});
		assert.deepEqual(editor.writes, []);
		await editor.save();
		assert.deepEqual(editor.writes[0].providers.openai.models.map(({ id }) => id), ["existing-model", "gpt-4o"]);
	});
});

test("editing an auto-filled limit makes it explicit across a subsequent ID correction", async () => {
	await withHookHost(async (host) => {
		const editor = await openModelEditor(host, async (_provider, id) => id === "gpt-4o" ? catalogSpec : null);
		await editor.blur();
		await editor.change("16384", "2048");
		await editor.change("model-id", "unknown-b");
		await editor.save();
		assert.equal(editor.writes[0].providers.openai.models[0].maxTokens, 2048);
	});
});

test("correcting a persisted model ID preserves its saved limit", async () => {
	await withHookHost(async (host) => {
		const editor = await openModelEditor(host, async () => null, [{ id: "gpt-4o", maxTokens: 128000 }]);
		await editor.change("model-id", "unknown-b");
		await editor.save();
		assert.equal(editor.writes[0].providers.openai.models[0].maxTokens, 128000);
	});
});

test("a successfully persisted limit survives an ID correction even if the save refresh failed", async () => {
	await withHookHost(async (host) => {
		const editor = await openModelEditor(host, async (_provider, id) => id === "gpt-4o" ? catalogSpec : null, [], (writeCount) => {
			if (writeCount === 1) throw new Error("mock config refresh failure");
		});
		await editor.blur();
		await editor.save();
		assert.equal(editor.writes[0].providers.openai.models[0].maxTokens, 16384);
		await editor.change("model-id", "unknown-b");
		await editor.save();
		assert.equal(editor.writes[1].providers.openai.models[0].maxTokens, 16384);
	});
});

test("the first Save persists a known model while its blur lookup is pending", async () => {
	await withHookHost(async (host) => {
		const blur = deferred();
		const save = deferred();
		let lookup = 0;
		const editor = await openModelEditor(host, () => (++lookup === 1 ? blur : save).promise);
		await editor.blur();
		await editor.save();
		await host.act(() => blur.resolve(catalogSpec));
		await host.act(() => save.resolve(catalogSpec));
		assert.deepEqual(editor.writes.map((value) => value.providers.openai.models[0].maxTokens), [16384]);
	});
});

test("a user edit still invalidates a model Save awaiting the catalog", async () => {
	await withHookHost(async (host) => {
		const pending = deferred();
		const editor = await openModelEditor(host, () => pending.promise);
		await editor.save();
		await editor.change("16384", "2048");
		await host.act(() => pending.resolve(catalogSpec));
		assert.equal(editor.writes.length, 0);
		assert.equal(editor.value("16384"), 2048);
		await editor.save();
		assert.deepEqual(editor.writes.map((value) => value.providers.openai.models[0].maxTokens), [2048]);
	});
});

test("the ID input can repair a model row loaded without an ID", async () => {
	await withHookHost(async (host) => {
		const editor = await openModelEditor(host, async () => catalogSpec, [{ name: "Model without ID" }]);
		await editor.change("model-id", "gpt-4o");
		await editor.blur();
		assert.equal(editor.value("model-id"), "gpt-4o");
		assert.equal(editor.value("16384"), 16384);
	});
});

test("one blur applies all catalog fields to an incomplete model row", async () => {
	await withHookHost(async (host) => {
		const editor = await openModelEditor(host, async () => catalogSpec, [{ id: "gpt-4o" }]);
		await editor.blur();
		assert.equal(editor.value("1000000"), 128000);
		assert.equal(editor.value("16384"), 16384);
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
