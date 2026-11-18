import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createFakePi, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const removed = { provider: "custom", modelId: "deleted-default" };
const replacement = { provider: "other", modelId: "available" };
const emptyDefault = { defaultProvider: "", defaultModel: "" };

/** Old catalog entries can predate explicit model preferences and still have no runtime. */
async function start(t, { global = emptyDefault, project = {} } = {}) {
	let fake;
	const session = await startBackendSession(t, {
		prepare(fixture) {
			const projectDir = join(fixture.root, "project");
			const agentDir = join(fixture.home, ".pi", "agent");
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "project", path: projectDir }]));
			writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [{
				id: "old", projectId: "project", title: "Old session without a model", environment: "native",
				status: "active", source: "pi", createdAt: 1, updatedAt: 1,
			}] }));
			writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [projectDir]: true }));
			writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: removed.modelId }] } } }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(project));
			fake = createFakePi(fixture, {
				models: [{ provider: replacement.provider, id: replacement.modelId }],
				state: { model: { provider: replacement.provider, id: replacement.modelId } },
			});
			return {
				settings: { customPiPath: fake.shim },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			};
		},
	});
	return { ...session, fake };
}

async function send(session, requestId) {
	return (await session.invoke("sessions:send-prompt", [{ sessionId: "old", requestId, message: "hello" }])).payload.result;
}

test("a cold legacy session requires a choice when its effective default was cleared", { skip: !executable }, async (t) => {
	const session = await start(t);
	const result = await send(session, "cleared-global");
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "app.modelSelectionRequired");
	assert.equal(session.fake.commands().some((command) => command.command === "prompt"), false);
});

test("manual activation cannot bypass a cleared model default for a legacy session", { skip: !executable }, async (t) => {
	const session = await start(t);
	const result = (await session.invoke("sessions:runtime-activate", ["old"])).payload.result;
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "SESSION_MODEL_REQUIRED");
});

test("a valid project model overrides an explicitly cleared global default", { skip: !executable }, async (t) => {
	const session = await start(t, { project: { defaultProvider: replacement.provider, defaultModel: replacement.modelId } });
	const result = await send(session, "valid-project");
	assert.equal(result.accepted, true, JSON.stringify(result));
});

test("an explicitly cleared project model overrides a valid global default", { skip: !executable }, async (t) => {
	const session = await start(t, { global: { defaultProvider: replacement.provider, defaultModel: replacement.modelId }, project: emptyDefault });
	const result = await send(session, "cleared-project");
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "app.modelSelectionRequired");
});

test("clearing an unrelated default leaves an already running valid model usable", { skip: !executable }, async (t) => {
	const session = await start(t, { global: { defaultProvider: removed.provider, defaultModel: removed.modelId } });
	assert.equal((await session.invoke("sessions:runtime-activate", ["old"])).payload.result.ok, true);
	assert.equal((await session.invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const result = await send(session, "unrelated-live-model");
	assert.equal(result.accepted, true, JSON.stringify(result));
});
