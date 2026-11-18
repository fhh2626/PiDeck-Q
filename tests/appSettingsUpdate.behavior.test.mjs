import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { deferred } from "./helpers/imagePreviewHarness.mjs";

const nodeRequire = createRequire(import.meta.url);
const { createStore } = nodeRequire("jotai");
const atoms = loadTsCommonJs("src/renderer/src/atoms/model-atoms.ts");
const modelSelection = loadTsCommonJs("src/renderer/src/utils/modelSelection.ts");
const preview = loadTsCommonJs("src/renderer/src/previewApi.ts", {
	stubs: { "./i18n": { t: (key) => key } },
}).createPreviewApi();

/** Execute the actual callback wired to SettingsFeatureRoot without booting unrelated App surfaces. */
function loadUpdateSettings(context) {
	const file = ts.createSourceFile("App.tsx", readFileSync("src/renderer/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	let callback;
	const visit = (node) => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === "updateSettings") callback = node;
		else ts.forEachChild(node, visit);
	};
	visit(file);
	assert.ok(callback, "App provides the settings persistence callback");
	const output = ts.transpileModule(`${callback.getText(file)}\nglobalThis.updateSettings = updateSettings;`, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
	vm.runInNewContext(output, context, { filename: "App.updateSettings.js" });
	return context.updateSettings;
}

async function setup({ update, get, settings: overrides = {} } = {}) {
	const initial = { ...await preview.settings.get(), ...overrides };
	let settings = initial;
	const store = createStore();
	const notices = [];
	const webTransitions = [];
	const context = {
		Error, store, ...atoms, ...modelSelection,
		api: { settings: { update: update ?? (async (patch) => ({ ...initial, ...patch })), get: get ?? (async () => initial) } },
		setSettings: (next) => { settings = typeof next === "function" ? next(settings) : next; },
		setWebServiceChanging: (next) => webTransitions.push(next),
		showToast: (message) => notices.push(message),
		t: (key) => key,
	};
	const remove = (provider, modelId) => store.set(atoms.sharedModelRemovalVersionsAtom, (previous) => {
		const key = JSON.stringify([provider, modelId]);
		return { ...previous, [key]: (previous[key] ?? 0) + 1 };
	});
	return { initial, settings: () => settings, store, notices, webTransitions, remove, update: loadUpdateSettings(context) };
}

test("App settings saves return an explicit success result after applying the confirmed response", async () => {
	const env = await setup();
	assert.equal(await env.update({ theme: "dark" }), true);
	assert.equal(env.settings().theme, "dark");
	assert.deepEqual(env.notices, ["app.settingsSaved"]);
});

test("App settings save failures return false even when the recovery read also fails", async () => {
	const env = await setup({
		update: async () => { throw new Error("settings write failed"); },
		get: async () => { throw new Error("settings recovery failed"); },
	});
	assert.equal(await env.update({ webServiceEnabled: true }), false);
	assert.equal(env.settings(), env.initial);
	assert.deepEqual(env.notices, ["app.webApplying", "settings write failed"]);
	assert.deepEqual(env.webTransitions, [true, false]);
});

test("a delayed settings save cannot restore Git or favorite models removed while it was pending", async () => {
	const reply = deferred();
	const env = await setup({ update: () => reply.promise });
	const pending = env.update({ theme: "dark" });
	env.remove("custom", "same/id");
	reply.resolve({ ...env.initial, theme: "dark", gitCommitMessageProvider: "custom", gitCommitMessageModel: "same/id",
		favoriteModels: ["custom/same/id", "other/same/id"] });
	const saved = await pending;
	assert.equal(env.settings().gitCommitMessageProvider, "");
	assert.equal(env.settings().gitCommitMessageModel, "");
	assert.deepEqual([...env.settings().favoriteModels], ["other/same/id"]);
	assert.equal(env.settings().theme, "dark");
	assert.equal(saved, true);
});

test("settings recovery preserves the host's rollback without reviving a removed Git model", async () => {
	const recovery = deferred();
	const env = await setup({
		update: async () => { throw new Error("listener start failed"); },
		get: () => recovery.promise,
	});
	const pending = env.update({ webServiceEnabled: true });
	await Promise.resolve();
	env.remove("custom", "old");
	recovery.resolve({ ...env.initial, webServiceEnabled: false, gitCommitMessageProvider: "custom", gitCommitMessageModel: "old",
		favoriteModels: ["custom/old"] });
	const saved = await pending;
	assert.equal(env.settings().webServiceEnabled, false);
	assert.equal(env.settings().gitCommitMessageModel, "");
	assert.deepEqual([...env.settings().favoriteModels], []);
	assert.deepEqual(env.webTransitions, [true, false]);
	assert.equal(env.notices.at(-1), "listener start failed");
	assert.equal(saved, false);
});

test("an explicit settings choice after an earlier deletion remains valid when no new deletion occurs", async () => {
	const env = await setup();
	env.remove("custom", "restored");
	assert.equal(await env.update({ gitCommitMessageProvider: "custom", gitCommitMessageModel: "restored", favoriteModels: ["custom/restored"] }), true);
	assert.equal(env.settings().gitCommitMessageModel, "restored");
	assert.deepEqual([...env.settings().favoriteModels], ["custom/restored"]);
});
