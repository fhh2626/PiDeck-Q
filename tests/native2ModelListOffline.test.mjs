import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { writeNodeShim } from "./helpers/native2FakeProcess.mjs";

const executable = resolveBackendExecutable();
const table = "provider  model  context  max-out  thinking  images\nacme  acme-1  128K  4K  no  yes\n";

/** Use a real child process to exercise model discovery's auto-mode CLI arguments. */
async function startModels(t, text, models = []) {
	let logPath;
	const session = await startBackendSession(t, {
		settings: { piRuntimePreference: "auto", language: "en-US" },
		prepare(fixture) {
			const directory = join(fixture.root, "model-cli");
			mkdirSync(directory, { recursive: true });
			const script = join(directory, "pi-models.mjs");
			copyFileSync(resolve("tests/fixtures/native2-fake-pi-models.mjs"), script);
			const scenarioPath = join(directory, "scenario.json");
			writeFileSync(scenarioPath, JSON.stringify({ rpc: { models }, text }));
			logPath = join(directory, "pi.log");
			return {
				settings: { customPiPath: writeNodeShim(directory, "pi", script) },
				env: {
					FAKE_PI_MODELS_SCENARIO: scenarioPath,
					FAKE_PI_MODELS_LOG: logPath,
					FAKE_PI_MODELS_COUNTER: join(directory, "counter.txt"),
				},
			};
		},
	});
	return {
		...session,
		spawns: () => readFileSync(logPath, "utf8").trim().split("\n")
			.map((line) => JSON.parse(line)).filter((entry) => entry.kind === "spawn"),
	};
}

test("auto model discovery tries the offline text probe first", { skip: !executable }, async (t) => {
	const session = await startModels(t, [table]);
	const result = await session.invoke("projects:list-models");
	assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
	assert.deepEqual(result.payload.result.map((model) => model.id), ["acme-1"]);
	const textProbes = session.spawns().filter((entry) => entry.argv.includes("--list-models"));
	assert.equal(textProbes.length, 1);
	assert.equal(textProbes[0].argv.includes("--offline"), true);
});

test("auto model discovery retries a neutral text probe after an empty offline result", { skip: !executable }, async (t) => {
	const session = await startModels(t, ["", table]);
	const result = await session.invoke("projects:list-models");
	assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
	assert.deepEqual(result.payload.result.map((model) => model.id), ["acme-1"]);
	const textProbes = session.spawns().filter((entry) => entry.argv.includes("--list-models"));
	assert.equal(textProbes.length, 2);
	assert.equal(textProbes[0].argv.includes("--offline"), true);
	assert.equal(textProbes[1].argv.includes("--offline"), false);
	const rpcProbes = session.spawns().filter((entry) => entry.argv.includes("rpc"));
	assert.equal(rpcProbes.length, 1, "the fallback belongs to the same discovery attempt");
});

test("text model discovery preserves a provider named showing", { skip: !executable }, async (t) => {
	const session = await startModels(t, [
		"provider model context max-out thinking images\nshowing model-1 128K 4K no yes\nShowing 1 of 1 providers\n",
	]);
	const result = await session.invoke("projects:list-models");
	assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
	assert.deepEqual(result.payload.result.map((model) => `${model.provider}/${model.id}`), ["showing/model-1"]);
});


test("RPC model discovery retains stock Pi capabilities, defaults and duplicate handling", { skip: !executable }, async (t) => {
	const session = await startModels(t, [], [
		{ provider: "anthropic", id: "claude", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, reasoning: true },
		{ provider: "ANTHROPIC", id: "CLAUDE", images: false },
		{ provider: "legacy", id: "text-only", images: false },
		{ id: "missing-provider", input: ["image"] },
	]);
	const result = await session.invoke("projects:list-models");
	assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
	const models = result.payload.result;
	assert.equal(models.length, 2);
	assert.deepEqual(models.map(({ provider, id, name, images }) => ({ provider, id, name, images })), [
		{ provider: "anthropic", id: "claude", name: "anthropic/claude", images: true },
		{ provider: "legacy", id: "text-only", name: "legacy/text-only", images: false },
	]);
	assert.equal(models[0].contextWindow, 200000);
	assert.equal(models[0].maxTokens, 8192);
	assert.equal(models[0].reasoning, true);
	assert.equal(session.spawns().some((entry) => entry.argv.includes("--list-models")), false);
});
