import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createFakePi, resolveBackendExecutable, SseClient, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor } from "./helpers/native2RuntimeEvents.mjs";

const executable = resolveBackendExecutable();
const model = { provider: "custom", modelId: "shared/name" };
const config = { providers: { custom: { models: [{ id: model.modelId, name: "Old name", contextWindow: 10000, maxTokens: 1000 }] } } };

async function start(t, scenario = {}) {
	let configDir;
	let projectDir;
	let fake;
	const session = await startBackendSession(t, {
		settings: { language: "en-US", gitCommitMessageProvider: model.provider, gitCommitMessageModel: model.modelId, favoriteModels: ["custom/shared/name", "other/shared/name"] },
		prepare(fixture) {
			configDir = join(fixture.home, ".pi", "agent");
			projectDir = join(fixture.root, "project");
			mkdirSync(configDir, { recursive: true });
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "project", path: projectDir }]));
			writeFileSync(join(configDir, "trust.json"), JSON.stringify({ [projectDir]: true }));
			writeFileSync(join(configDir, "models.json"), JSON.stringify(config));
			const defaults = { defaultProvider: model.provider, defaultModel: model.modelId, subagents: { defaultProvider: model.provider, defaultModel: model.modelId } };
			writeFileSync(join(configDir, "settings.json"), JSON.stringify(defaults));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(defaults));
			writeFileSync(join(configDir, "pi-deck-vision.json"), JSON.stringify({
				enabled: true, provider: model.provider, model: model.modelId,
				api: "openai-responses", baseUrl: "https://vision.invalid/v1", apiKey: "fixture-key",
			}));
			fake = createFakePi(fixture, { models: [{ provider: model.provider, id: model.modelId, name: "Old name" }], state: { model: { provider: model.provider, id: model.modelId } }, ...scenario });
			return {
				settings: { customPiPath: fake.shim },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			};
		},
	});
	const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
	await sse.connect();
	t.after(() => sse.close());
	return { ...session, sse, configDir, projectDir, fake };
}

test("saving a model edit refreshes the cached catalog without restarting the desktop", { skip: !executable }, async (t) => {
	const { invoke, sse, fake } = await start(t);
	const before = (await invoke("projects:list-models")).payload.result;
	assert.equal(before[0].name, "Old name");
	const changed = structuredClone(config);
	changed.providers.custom.models[0].name = "New name";
	// Each fake process snapshots this file at startup, like pi snapshots models.json.
	writeFileSync(fake.scenarioPath, JSON.stringify({ models: [{ provider: model.provider, id: model.modelId, name: "New name" }] }));
	const result = await invoke("config:save-models", [changed]);
	assert.equal(result.payload.result.valid, true);
	const event = await sse.waitFor("models:changed", 15000);
	assert.deepEqual(event.payload.args[0].removedModels, []);
	const after = (await invoke("projects:list-models")).payload.result;
	assert.equal(after[0].name, "New name");
});

test("deleting a model clears saved defaults and sessions, and refuses use until another model is selected", { skip: !executable }, async (t) => {
	const { invoke, sse, configDir, projectDir } = await start(t);
	const created = await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }]);
	assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
	const id = created.payload.result.id;
	const activation = (await invoke("sessions:runtime-activate", [id])).payload.result;
	assert.equal(activation.ok, true, JSON.stringify(activation));
	const result = await invoke("config:save-models", [{ providers: {} }]);
	assert.equal(result.payload.result.valid, true);
	const event = await sse.waitFor("models:changed", 15000);
	assert.deepEqual(event.payload.args[0].removedModels, [model]);
	for (const path of [join(configDir, "settings.json"), join(projectDir, ".pi", "settings.json")]) {
		const settings = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(settings.defaultModel, "");
		assert.equal(settings.defaultProvider, "");
		assert.equal(settings.subagents.defaultModel, "");
		assert.equal(settings.subagents.defaultProvider, "");
	}
	const desktop = (await invoke("settings:get")).payload.result;
	assert.equal(desktop.gitCommitMessageProvider, "");
	assert.equal(desktop.gitCommitMessageModel, "");
	assert.deepEqual(desktop.favoriteModels, ["other/shared/name"]);
	const vision = JSON.parse(readFileSync(join(configDir, "pi-deck-vision.json"), "utf8"));
	assert.equal(vision.provider, "");
	assert.equal(vision.model, "");
	assert.equal(vision.api, undefined);
	assert.equal(vision.baseUrl, undefined);
	assert.equal(vision.apiKey, undefined, "a replacement model must not inherit the removed provider's credentials");
	const records = (await invoke("sessions:catalog-list", ["project", { scan: false }])).payload.result;
	assert.deepEqual(records.find((record) => record.id === id).model, { provider: "", modelId: "" });
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: id, requestId: "deleted-model", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false);
	assert.equal(sent.i18nKey, "app.modelSelectionRequired");
	const subagents = (await invoke("subagents:get-settings", ["project"])).payload.result;
	assert.equal(subagents.global.useOwnModel, true);
	assert.equal(subagents.global.model, undefined);
});

test("adding an unrelated model leaves the current agent sendable", { skip: !executable }, async (t) => {
	const { invoke, sse } = await start(t);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	const changed = structuredClone(config);
	changed.providers.custom.models.push({ id: "another-model", name: "Another", contextWindow: 10000, maxTokens: 1000 });
	assert.equal((await invoke("config:save-models", [changed])).payload.result.valid, true);
	await sse.waitFor("models:changed", 15000);
	const result = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-add", message: "hello" }])).payload.result;
	assert.equal(result.accepted, true, JSON.stringify(result));
});

test("editing the active definition blocks stale use and selecting the same id offers an agent restart", { skip: !executable }, async (t) => {
	const { invoke, sse } = await start(t);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	const activation = (await invoke("sessions:runtime-activate", [record.id])).payload.result;
	assert.equal(activation.ok, true, JSON.stringify(activation));
	const changed = structuredClone(config);
	changed.providers.custom.baseUrl = "https://replacement.invalid/v1";
	assert.equal((await invoke("config:save-models", [changed])).payload.result.valid, true);
	await sse.waitFor("models:changed", 15000);
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-edit", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false);
	assert.equal(sent.i18nKey, "app.modelConfigurationReloadRequired");
	const target = { sessionId: record.id, agentId: activation.value.agentId, runtimeGeneration: activation.value.runtimeGeneration };
	const picked = (await invoke("sessions:runtime-set-model", [target, model.provider, model.modelId])).payload.result;
	assert.equal(picked.ok, false, JSON.stringify(picked));
	assert.equal(picked.error.needsRestart, true);
});

test("an unrelated malformed project preference cannot suppress a saved model deletion", { skip: !executable }, async (t) => {
	const { invoke, sse, projectDir, configDir } = await start(t);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	const preferencePath = join(projectDir, ".pi", "settings.json");
	const malformed = "{\"unrelatedPreference\":";
	writeFileSync(preferencePath, malformed);
	const result = await invoke("config:save-models", [{ providers: {} }]);
	assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
	assert.equal(result.payload.result.valid, true);
	assert.deepEqual(JSON.parse(readFileSync(join(configDir, "models.json"), "utf8")), { providers: {} });
	const event = await sse.waitFor("models:changed", 15000);
	assert.deepEqual(event.payload.args[0].removedModels, [model]);
	assert.equal(readFileSync(preferencePath, "utf8"), malformed, "unreadable preferences must remain untouched");
	const desktop = (await invoke("settings:get")).payload.result;
	assert.equal(desktop.gitCommitMessageModel, "", "independent valid preferences still clear");
	const records = (await invoke("sessions:catalog-list", ["project", { scan: false }])).payload.result;
	assert.deepEqual(records.find((value) => value.id === record.id).model, { provider: "", modelId: "" });
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-corrupt-preference", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false);
	assert.equal(sent.i18nKey, "app.modelSelectionRequired");
});

test("a delayed model selection reply cannot restore a model deleted while it was pending", { skip: !executable }, async (t) => {
	const { invoke, sse, fake } = await start(t, { responses: { set_model: [{}, { replyGate: "model-selected" }] } });
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	const activation = (await invoke("sessions:runtime-activate", [record.id])).payload.result;
	assert.equal(activation.ok, true, JSON.stringify(activation));
	const target = { sessionId: record.id, agentId: activation.value.agentId, runtimeGeneration: activation.value.runtimeGeneration };
	const selection = invoke("sessions:runtime-set-model", [target, model.provider, model.modelId]);
	await waitFor(() => fake.commands().filter((entry) => entry.command === "set_model").length >= 2, 5000, "held model selection");
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	await sse.waitFor("models:changed", 15000);
	writeFileSync(`${fake.scenarioPath}.model-selected`, "released");
	const result = (await selection).payload.result;
	assert.equal(result.ok, false, "obsolete model selections must not acknowledge success");
	const records = (await invoke("sessions:catalog-list", ["project", { scan: false }])).payload.result;
	assert.deepEqual(records.find((value) => value.id === record.id).model, { provider: "", modelId: "" });
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-stale-selection", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false);
	assert.equal(sent.i18nKey, "app.modelSelectionRequired");
});

test("a pending catalog choice cannot permit sends through a deleted live model", { skip: !executable }, async (t) => {
	const replacement = { provider: "other", modelId: "replacement" };
	const { invoke, sse } = await start(t, { models: [
		{ provider: model.provider, id: model.modelId, name: "Old name" },
		{ provider: replacement.provider, id: replacement.modelId, name: "Replacement" },
	] });
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	// Busy model switching stores the next choice before pi accepts set_model.
	assert.equal((await invoke("sessions:catalog-update", [record.id, { model: replacement }])).payload.ok, true);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	await sse.waitFor("models:changed", 15000);
	const records = (await invoke("sessions:catalog-list", ["project", { scan: false }])).payload.result;
	assert.deepEqual(records.find((value) => value.id === record.id).model, replacement);
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "before-pending-model-applies", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false, "the actual pi model must be valid before a prompt is sent");
});

test("provider endpoint edits invalidate runtime models outside the explicit model array", { skip: !executable }, async (t) => {
	const { invoke } = await start(t);
	// Pi can expose built-in models even when a provider only configures connection fields.
	const providerOnly = { providers: { custom: { models: [], baseUrl: "https://original.invalid/v1" } } };
	assert.equal((await invoke("config:save-models", [providerOnly])).payload.result.valid, true);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	providerOnly.providers.custom.baseUrl = "https://replacement.invalid/v1";
	assert.equal((await invoke("config:save-models", [providerOnly])).payload.result.valid, true);
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-provider-only-edit", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false);
	assert.equal(sent.i18nKey, "app.modelConfigurationReloadRequired");
});

test("a re-added model can request an agent reload after its earlier deletion", { skip: !executable }, async (t) => {
	const { invoke } = await start(t);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	const activation = (await invoke("sessions:runtime-activate", [record.id])).payload.result;
	assert.equal(activation.ok, true);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	assert.equal((await invoke("config:save-models", [config])).payload.result.valid, true);
	const target = { sessionId: record.id, agentId: activation.value.agentId, runtimeGeneration: activation.value.runtimeGeneration };
	const picked = (await invoke("sessions:runtime-set-model", [target, model.provider, model.modelId])).payload.result;
	assert.equal(picked.ok, false, "the old process must reload before using the restored definition");
	assert.equal(picked.error.needsRestart, true, "a restored available model must offer the reload flow");
});
