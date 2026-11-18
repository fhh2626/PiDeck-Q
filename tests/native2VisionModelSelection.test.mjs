import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();

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
