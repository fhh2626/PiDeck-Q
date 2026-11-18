import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createFakePi, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();

const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

/** A real runtime can receive a queued image after the bridge configuration changes. */
async function runtimeWithBridge(t, nativeImages = false) {
	let fake;
	let configDir;
	const main = { provider: "text", id: "main", input: nativeImages ? ["text", "image"] : ["text"] };
	const models = { providers: {
		text: { models: [{ id: main.id, input: main.input }] },
		vision: { models: [{ id: "bridge", input: ["text", "image"] }] },
	} };
	const session = await startBackendSession(t, {
		prepare(fixture) {
			configDir = join(fixture.home, ".pi", "agent");
			const project = join(fixture.root, "project");
			mkdirSync(configDir, { recursive: true });
			mkdirSync(project, { recursive: true });
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "p", path: project }]));
			writeFileSync(join(configDir, "trust.json"), JSON.stringify({ [project]: true }));
			writeFileSync(join(configDir, "models.json"), JSON.stringify(models));
			writeFileSync(join(configDir, "pi-deck-vision.json"), JSON.stringify({ enabled: true, provider: "vision", model: "bridge" }));
			fake = createFakePi(fixture, { models: [main], state: { model: main } });
			return { settings: { customPiPath: fake.shim }, env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
		},
	});
	const record = (await session.invoke("sessions:catalog-create-draft", [{ projectId: "p", model: { provider: main.provider, modelId: main.id } }])).payload.result;
	assert.equal((await session.invoke("sessions:runtime-activate", [record.id])).payload.result.ok, true);
	const remove = async () => {
		const next = { providers: { text: models.providers.text } };
		assert.equal((await session.invoke("config:save-models", [next])).payload.result.valid, true);
	};
	return { ...session, configDir, fake, record, remove };
}

test("a cleared vision model stays visible after restart without retaining its endpoint or credentials", { skip: !executable }, async (t) => {
	const session = await startBackendSession(t, {
		prepare(fixture) {
			const dir = join(fixture.home, ".pi", "agent");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "pi-deck-vision.json"), JSON.stringify({
				enabled: true, provider: "", model: "", maxTokens: 1234, concurrency: 4,
				api: "openai-completions", baseUrl: "https://old-provider.example", apiKey: "old-key",
			}));
		},
	});
	const state = (await session.invoke("vision:get-config")).payload.result;
	assert.ok(state.config, "an enabled bridge with a removed model must still prompt for a replacement");
	assert.equal(state.config.enabled, true);
	assert.equal(state.config.provider, "");
	assert.equal(state.config.model, "");
	assert.equal(state.config.maxTokens, 1234);
	assert.equal(state.config.concurrency, 4);
	assert.equal(state.config.api, undefined);
	assert.equal(state.config.baseUrl, undefined);
	assert.equal(state.config.apiKey, undefined);
	const saved = (await session.invoke("vision:save-config", [state.config])).payload.result;
	assert.equal(saved.ok, false, "saving still requires a valid replacement model");
});

test("a cleared vision bridge can be explicitly disabled without selecting another model", { skip: !executable }, async (t) => {
	const session = await startBackendSession(t);
	const saved = (await session.invoke("vision:save-config", [{ enabled: false, provider: "", model: "", promptTemplate: "keep this prompt" }])).payload.result;
	assert.equal(saved.ok, true, JSON.stringify(saved));
	const config = (await session.invoke("vision:get-config")).payload.result.config;
	assert.equal(config.enabled, false);
	assert.equal(config.model, "");
	assert.equal(config.promptTemplate, "keep this prompt");
	assert.equal((await session.invoke("vision:save-config", [{ ...config, enabled: true }])).payload.result.ok, false);
});

test("images queued before a bridge model deletion are rejected at the real dispatch boundary", { skip: !executable }, async (t) => {
	const session = await runtimeWithBridge(t);
	await session.remove();
	const result = (await session.invoke("sessions:send-prompt", [{ sessionId: session.record.id, requestId: "queued-image", message: "Describe it", images: [image] }])).payload.result;
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "app.visionModelSelectionRequired");
	assert.equal(session.fake.commands().some((command) => command.command === "prompt"), false);
});

test("removing the bridge model does not block a main model with native image support", { skip: !executable }, async (t) => {
	const session = await runtimeWithBridge(t, true);
	await session.remove();
	const result = (await session.invoke("sessions:send-prompt", [{ sessionId: session.record.id, requestId: "native-image", message: "Describe it", images: [image] }])).payload.result;
	assert.equal(result.accepted, true, JSON.stringify(result));
});

test("removing the bridge model still allows text prompts", { skip: !executable }, async (t) => {
	const session = await runtimeWithBridge(t);
	await session.remove();
	const result = (await session.invoke("sessions:send-prompt", [{ sessionId: session.record.id, requestId: "text", message: "Continue" }])).payload.result;
	assert.equal(result.accepted, true, JSON.stringify(result));
});

test("a late vision save cannot persist a removed model and an explicit re-selection works after re-adding it", { skip: !executable }, async (t) => {
	const session = await runtimeWithBridge(t);
	await session.remove();
	const removedDraft = { enabled: true, provider: "vision", model: "bridge" };
	const rejected = (await session.invoke("vision:save-config", [removedDraft])).payload.result;
	assert.equal(rejected.ok, false, JSON.stringify(rejected));
	assert.equal(rejected.i18nKey, "app.visionModelSelectionRequired");
	assert.equal((await session.invoke("vision:get-config")).payload.result.config.model, "");
	assert.equal((await session.invoke("config:save-models", [{ providers: {
		text: { models: [{ id: "main", input: ["text"] }] },
		vision: { models: [{ id: "bridge", input: ["text", "image"] }] },
	} }])).payload.result.valid, true);
	assert.equal((await session.invoke("vision:save-config", [removedDraft])).payload.result.ok, true);
	assert.equal((await session.invoke("vision:get-config")).payload.result.config.model, "bridge");
});
