import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createFakePi, resolveBackendExecutable, SseClient, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { channelEvents, waitFor } from "./helpers/native2RuntimeEvents.mjs";

const executable = resolveBackendExecutable();
const model = { provider: "custom", modelId: "shared/name" };
const config = { providers: { custom: { models: [{ id: model.modelId, name: "Old name", contextWindow: 10000, maxTokens: 1000 }] } } };

async function start(t, scenario = {}, legacySessions = []) {
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
			if (legacySessions.length) writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1,
				sessions: legacySessions.map((id) => ({ id, projectId: "project", title: id, environment: "native", status: "active", source: "pi", createdAt: 1, updatedAt: 1 })),
			}));
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
	const builtin = { provider: "custom", modelId: "built-in-model" };
	const { invoke } = await start(t, { state: { model: { provider: builtin.provider, id: builtin.modelId } } });
	// Pi can expose built-in models even when a provider only configures connection fields.
	const providerOnly = { providers: { custom: { models: [], baseUrl: "https://original.invalid/v1" } } };
	assert.equal((await invoke("config:save-models", [providerOnly])).payload.result.valid, true);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model: builtin }])).payload.result;
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

test("model edits during activation invalidate the already spawned unbound process", { skip: !executable }, async (t) => {
	const { invoke, fake } = await start(t, { responses: { get_state: [{ replyGate: "activation-state" }] } });
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	const activating = invoke("sessions:runtime-activate", [record.id]);
	await waitFor(() => fake.commands().some((entry) => entry.command === "get_state"), 5000, "startup state request");
	const changed = structuredClone(config);
	changed.providers.custom.baseUrl = "https://changed-during-startup.invalid/v1";
	assert.equal((await invoke("config:save-models", [changed])).payload.result.valid, true);
	writeFileSync(`${fake.scenarioPath}.activation-state`, "released");
	assert.equal((await activating).payload.result.ok, true);
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-startup-edit", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false, "startup handshakes must not escape model invalidation");
	assert.equal(sent.i18nKey, "app.modelConfigurationReloadRequired");
});

test("a partially failed import still invalidates a model file that was written", { skip: !executable }, async (t) => {
	const { invoke, configDir } = await start(t);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	// Import writes models before settings. A directory at the second destination makes only that write fail.
	rmSync(join(configDir, "settings.json"));
	mkdirSync(join(configDir, "settings.json"));
	const changed = structuredClone(config);
	changed.providers.custom.baseUrl = "https://written-before-import-failure.invalid/v1";
	const imported = (await invoke("config:import", [JSON.stringify({ files: { "models.json": changed, "settings.json": {} } })])).payload;
	assert.equal(imported.ok, true, JSON.stringify(imported));
	assert.equal(imported.result.valid, false);
	assert.equal(JSON.parse(readFileSync(join(configDir, "models.json"), "utf8")).providers.custom.baseUrl, changed.providers.custom.baseUrl);
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-partial-import", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false, "an import error cannot leave a successfully written definition hidden from live agents");
	assert.equal(sent.i18nKey, "app.modelConfigurationReloadRequired");
});

test("a late model rejection cannot publish an unsent optimistic user message", { skip: !executable }, async (t) => {
	const { invoke, sse, fake } = await start(t, { responses: { get_commands: { replyGate: "prompt-commands", data: { commands: [] } } } });
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	const requestId = "rejected-after-command-lookup";
	const pending = invoke("sessions:send-prompt", [{ sessionId: record.id, requestId, message: "/held-message" }]);
	await waitFor(() => fake.commands().some((entry) => entry.command === "get_commands"), 5000, "held command lookup");
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	writeFileSync(`${fake.scenarioPath}.prompt-commands`, "released");
	const result = (await pending).payload.result;
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "app.modelSelectionRequired");
	assert.equal(fake.commands().some((entry) => entry.command === "prompt"), false);
	assert.equal(channelEvents(sse, record.id, "agents:message").flatMap((payload) => payload.messages ?? [])
		.some((row) => row.meta?.optimisticRequestId === requestId), false, "the rejected message never crossed the pi boundary");
});

test("a late cold catalog model write cannot restore a deleted selection", { skip: !executable }, async (t) => {
	const { invoke } = await start(t, {
		state: { model: { provider: "other", id: "fallback" } },
		responses: { set_model: { error: `Model not found: ${model.provider}/${model.modelId}` } },
	});
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	// A renderer selection request can cross the deletion event while waiting for another IPC read.
	const updated = (await invoke("sessions:catalog-update", [record.id, { model, title: "Keep this edit" }])).payload.result;
	assert.deepEqual(updated.model, { provider: "", modelId: "" });
	assert.equal(updated.title, "Keep this edit", "the stale model must not discard unrelated preference edits");
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-cold-stale-write", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false, "a stale persisted choice must never silently run the fallback model");
	assert.equal(sent.i18nKey, "app.modelSelectionRequired");
});

test("model edits during restart invalidate the replacement before it is bound", { skip: !executable }, async (t) => {
	const { invoke, fake } = await start(t);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	const activated = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
	writeFileSync(fake.scenarioPath, JSON.stringify({
		state: { model: { provider: model.provider, id: model.modelId } },
		responses: { get_state: { replyGate: "restart-state" } },
	}));
	const statesBefore = fake.commands().filter((entry) => entry.command === "get_state").length;
	const restarting = invoke("sessions:runtime-restart", [{ sessionId: record.id, agentId: activated.agentId, runtimeGeneration: activated.runtimeGeneration }]);
	await waitFor(() => fake.commands().filter((entry) => entry.command === "get_state").length > statesBefore, 5000, "replacement state request");
	const changed = structuredClone(config);
	changed.providers.custom.baseUrl = "https://changed-during-restart.invalid/v1";
	assert.equal((await invoke("config:save-models", [changed])).payload.result.valid, true);
	writeFileSync(`${fake.scenarioPath}.restart-state`, "released");
	assert.equal((await restarting).payload.result.ok, true);
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "after-restart-edit", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, false);
	assert.equal(sent.i18nKey, "app.modelConfigurationReloadRequired");
});

test("draft and anonymous creation cannot preserve a stale deleted model", { skip: !executable }, async (t) => {
	const { invoke } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const draft = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	const anonymous = (await invoke("sessions:create-anonymous", [{ projectId: "project", model }])).payload.result.session;
	for (const record of [draft, anonymous]) {
		assert.deepEqual(record.model, { provider: "", modelId: "" });
		const updated = (await invoke("sessions:catalog-update", [record.id, { model }])).payload.result;
		assert.deepEqual(updated.model, { provider: "", modelId: "" });
	}
});

test("re-adding a deleted model permits fresh catalog selections again", { skip: !executable }, async (t) => {
	const { invoke } = await start(t);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	assert.equal((await invoke("config:save-models", [config])).payload.result.valid, true);
	const updated = (await invoke("sessions:catalog-update", [record.id, { model }])).payload.result;
	assert.deepEqual(updated.model, model);
	const sent = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "restored-cold-model", message: "hello" }])).payload.result;
	assert.equal(sent.accepted, true, JSON.stringify(sent));
});

test("a stale subagent settings save cannot restore a deleted model", { skip: !executable }, async (t) => {
	const { invoke, configDir } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const draft = { useOwnModel: true, preferDelegation: true, model };
	const rejected = (await invoke("subagents:save-settings", ["global", "project", draft])).payload;
	assert.equal(rejected.ok, false, "the pending old draft must not restore a confirmed deleted identity");
	assert.equal(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")).subagents.defaultModel, "");
	assert.equal((await invoke("config:save-models", [config])).payload.result.valid, true);
	const restored = (await invoke("subagents:save-settings", ["global", "project", draft])).payload;
	assert.equal(restored.ok, true, JSON.stringify(restored));
	assert.equal((await invoke("subagents:get-settings", ["project"])).payload.result.global.model.modelId, model.modelId);
});

for (const format of ["structured", "raw", "import"]) {
	test(`a stale ${format} settings save cannot restore a deleted default`, { skip: !executable }, async (t) => {
		const { invoke, configDir } = await start(t);
		assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
		const stale = { defaultProvider: model.provider, defaultModel: model.modelId, unrelated: "keep" };
		const saved = format === "structured" ? await invoke("config:save-settings", [stale])
			: format === "raw" ? await invoke("config:save-raw", ["settings.json", JSON.stringify(stale)])
				: await invoke("config:import", [JSON.stringify({ files: { "settings.json": stale } })]);
		assert.equal(saved.payload.result.valid, false, JSON.stringify(saved.payload));
		assert.equal(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")).defaultModel, "");
	});
	test(`a stale ${format} settings save cannot restore a qualified default without a provider field`, { skip: !executable }, async (t) => {
		const { invoke, configDir } = await start(t);
		assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
		const stale = { defaultModel: `${model.provider}/${model.modelId}`, unrelated: "keep" };
		const saved = format === "structured" ? await invoke("config:save-settings", [stale])
			: format === "raw" ? await invoke("config:save-raw", ["settings.json", JSON.stringify(stale)])
				: await invoke("config:import", [JSON.stringify({ files: { "settings.json": stale } })]);
		assert.equal(saved.payload.result.valid, false, JSON.stringify(saved.payload));
		assert.equal(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")).defaultModel, "");
	});
}

test("independent bare and unrelated qualified defaults remain valid after a deletion", { skip: !executable }, async (t) => {
	const { invoke, configDir } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	for (const defaultModel of ["builtin-independent", model.modelId, "other/shared/name", "custom/custom/shared/name"]) {
		const settings = { defaultModel, unrelated: "keep" };
		const result = (await invoke("config:save-settings", [settings])).payload.result;
		assert.equal(result.valid, true, JSON.stringify(result));
		assert.deepEqual(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")), settings);
	}
});

test("a stale desktop settings patch cannot restore a removed Git model or favorite", { skip: !executable }, async (t) => {
	const { invoke, fixture } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const patch = { gitCommitMessageProvider: model.provider, gitCommitMessageModel: model.modelId,
		favoriteModels: [`${model.provider}/${model.modelId}`, "other/shared/name", "builtin-independent"],
		gitCommitMessagePrompt: "Keep this newer prompt", zoomFactor: 1.25 };
	const saved = (await invoke("settings:update", [patch])).payload;
	assert.equal(saved.ok, true, JSON.stringify(saved));
	for (const settings of [saved.result, (await invoke("settings:get")).payload.result,
		JSON.parse(readFileSync(join(fixture.userData, "settings.json"), "utf8"))]) {
		assert.equal(settings.gitCommitMessageProvider, "");
		assert.equal(settings.gitCommitMessageModel, "");
		assert.deepEqual(settings.favoriteModels, ["other/shared/name", "builtin-independent"]);
		assert.equal(settings.gitCommitMessagePrompt, patch.gitCommitMessagePrompt);
		assert.equal(settings.zoomFactor, 1.25);
	}
});

test("a partial desktop Git model patch is checked with the saved provider", { skip: !executable }, async (t) => {
	const { invoke } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	assert.equal((await invoke("settings:update", [{ gitCommitMessageProvider: model.provider, gitCommitMessageModel: "unrelated" }])).payload.ok, true);
	const saved = (await invoke("settings:update", [{ gitCommitMessageModel: model.modelId, zoomFactor: 1.15 }])).payload;
	assert.equal(saved.ok, true, JSON.stringify(saved));
	assert.equal(saved.result.gitCommitMessageProvider, "");
	assert.equal(saved.result.gitCommitMessageModel, "");
	assert.equal(saved.result.zoomFactor, 1.15);
});

test("a re-added model can be selected as the desktop Git default and favorite", { skip: !executable }, async (t) => {
	const { invoke } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	assert.equal((await invoke("config:save-models", [config])).payload.result.valid, true);
	const patch = { gitCommitMessageProvider: model.provider, gitCommitMessageModel: model.modelId,
		favoriteModels: [`${model.provider}/${model.modelId}`] };
	const saved = (await invoke("settings:update", [patch])).payload;
	assert.equal(saved.ok, true, JSON.stringify(saved));
	assert.equal(saved.result.gitCommitMessageProvider, model.provider);
	assert.equal(saved.result.gitCommitMessageModel, model.modelId);
	assert.deepEqual(saved.result.favoriteModels, patch.favoriteModels);
});

test("an import can restore a qualified default without a provider field when it re-adds that model", { skip: !executable }, async (t) => {
	const { invoke, configDir } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const settings = { defaultModel: `${model.provider}/${model.modelId}`, unrelated: "keep" };
	const result = (await invoke("config:import", [JSON.stringify({ files: { "models.json": config, "settings.json": settings } })])).payload.result;
	assert.equal(result.valid, true, JSON.stringify(result));
	assert.deepEqual(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")), settings);
});

test("an import can explicitly re-add a model and select it as default in one package", { skip: !executable }, async (t) => {
	const { invoke, configDir } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const selected = { defaultProvider: model.provider, defaultModel: model.modelId };
	const restored = (await invoke("config:import", [JSON.stringify({ files: { "models.json": config, "settings.json": selected } })])).payload;
	assert.equal(restored.result.valid, true, JSON.stringify(restored));
	assert.deepEqual(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")), selected);
});

test("a catalog write failure cannot leave later live agents using a deleted model", { skip: !executable }, async (t) => {
	const ids = ["legacy-a", "legacy-b"];
	const { invoke, fixture, sse } = await start(t, {}, ids);
	for (const id of ids) assert.equal((await invoke("sessions:runtime-activate", [id])).payload.result.ok, true);
	const catalogPath = join(fixture.userData, "session-catalog.json");
	rmSync(catalogPath);
	mkdirSync(catalogPath);
	const saved = (await invoke("config:save-models", [{ providers: {} }])).payload;
	assert.equal(saved.ok, false, "a failed durable preference cleanup still reports the I/O failure");
	for (const id of ids) {
		const sent = (await invoke("sessions:send-prompt", [{ sessionId: id, requestId: `failed-catalog-${id}`, message: "hello" }])).payload.result;
		assert.equal(sent.accepted, false, `${id} must be invalidated despite another catalog write failing`);
	}
	const changed = await sse.waitFor((frame) => frame.payload.channel === "models:changed" && frame.payload.args?.[0]?.removedModels?.length, 15000);
	assert.deepEqual(changed.payload.args[0].removedModels, [model], "a partial failure must still refresh model discovery");
});

test("a newly activated runtime cannot accept a stale choice deleted before it started", { skip: !executable }, async (t) => {
	const { invoke } = await start(t);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project" }])).payload.result;
	const activated = (await invoke("sessions:runtime-activate", [record.id])).payload.result;
	assert.equal(activated.ok, true, JSON.stringify(activated));
	const target = { sessionId: record.id, agentId: activated.value.agentId, runtimeGeneration: activated.value.runtimeGeneration };
	const selected = (await invoke("sessions:runtime-set-model", [target, model.provider, model.modelId])).payload.result;
	assert.equal(selected.ok, false, "the current process did not exist when the confirmed deletion was broadcast");
	assert.equal(selected.error.needsRestart, undefined, "a removed identity needs a new choice, not another restart");
});

test("rejecting an older command lookup cannot clear a newer active turn", { skip: !executable }, async (t) => {
	const { invoke, fake } = await start(t, { responses: { get_commands: { replyGate: "older-command", data: { commands: [] } } } });
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	const older = invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "older-held-command", message: "/held" }]);
	await waitFor(() => fake.commands().some((entry) => entry.command === "get_commands"), 5000, "older command lookup");
	const newer = (await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "newer-active-turn", message: "hello" }])).payload.result;
	assert.equal(newer.accepted, true);
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	writeFileSync(`${fake.scenarioPath}.older-command`, "released");
	assert.equal((await older).payload.result.accepted, false);
	const runtimes = (await invoke("sessions:runtime-list")).payload.result;
	assert.equal(runtimes.find((entry) => entry.sessionId === record.id).status, "running", "the later accepted prompt still owns the running state");
});

test("rejecting a queued command lookup cannot make a settled turn run again", { skip: !executable }, async (t) => {
	const { invoke, fake } = await start(t, { responses: { get_commands: {
		replyGate: "settled-command", data: { commands: [] }, eventsBeforeReply: [{ type: "agent_settled" }],
	} } });
	const record = (await invoke("sessions:catalog-create-draft", [{ projectId: "project", model }])).payload.result;
	assert.equal((await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "running-turn", message: "hello" }])).payload.result.accepted, true);
	const pending = invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "queued-command", message: "/held" }]);
	await waitFor(() => fake.commands().some((entry) => entry.command === "get_commands"), 5000, "queued command lookup");
	assert.equal((await invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	writeFileSync(`${fake.scenarioPath}.settled-command`, "released");
	assert.equal((await pending).payload.result.accepted, false);
	const runtimes = (await invoke("sessions:runtime-list")).payload.result;
	assert.equal(runtimes.find((entry) => entry.sessionId === record.id).status, "idle", "pi settled the prior turn while this lookup was pending");
});
