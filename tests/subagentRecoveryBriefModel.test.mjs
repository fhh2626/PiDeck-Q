/**
 * Tests for the recovery-brief inference wrapper.
 *
 * The pi Agent transport is injected, so these tests prove the wrapper's own
 * contract without a provider:
 *   - the child's own model reference and thinking level are used,
 *   - a bare/unresolvable model never silently borrows another provider,
 *   - a timeout or abort settles as `{ ok: false }` instead of hanging,
 *   - output is bounded and empty output degrades.
 */
import assert from "node:assert/strict";
import test from "node:test";

// Stub external Pi packages through the executor test loader, keeping the real
// TypeScript inference wrapper and exact-only model resolution unmodified.
const { installSubagentGraphLoader } = await import("./helpers/subagentGraphLoader.mjs");
installSubagentGraphLoader();
const { createRecoveryBriefGenerator } = await import(
	"../resources/extensions/pideck-q-subagents/src/runs/shared/recovery-brief-model.ts"
);
const { applyRecoveryBrief, foldRecoveryBriefUsage } = await import(
	"../resources/extensions/pideck-q-subagents/src/runs/shared/recovery-brief.ts"
);
const { sumResultsUsage } = await import(
	"../resources/extensions/pideck-q-subagents/src/shared/utils.ts"
);

const MODELS = [
	{ provider: "anthropic", id: "claude-sonnet-4" },
	{ provider: "openai", id: "gpt-5" },
];

function registry(overrides = {}) {
	const found = [];
	return {
		found,
		modelRegistry: {
			find(provider, id) {
				found.push(`${provider}/${id}`);
				return MODELS.find((model) => model.provider === provider && model.id === id)
					? { ...MODELS.find((model) => model.provider === provider && model.id === id), api: "test-api" }
					: undefined;
			},
			getAvailable: () => MODELS,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			...overrides,
		},
	};
}

test("the child's own model and thinking level are used, with no model switching", async () => {
	const { modelRegistry, found } = registry();
	const calls = [];
	const generator = createRecoveryBriefGenerator(
		{ model: { provider: "openai", id: "gpt-5" }, modelRegistry },
		{
			inference: async (input) => {
				calls.push(input);
				return "BRIEF";
			},
		},
	);

	const outcome = await generator({
		model: "anthropic/claude-sonnet-4:high",
		thinking: "high",
		prompt: "PROMPT",
	});

	assert.equal(outcome.ok, true);
	assert.equal(outcome.text, "BRIEF");
	assert.equal(calls.length, 1, "exactly one attempt must run");
	assert.equal(calls[0].model.provider, "anthropic", "the child's model must win over the parent model");
	assert.equal(calls[0].model.id, "claude-sonnet-4");
	assert.equal(calls[0].thinkingLevel, "high", "the child's thinking level must be forwarded");
	assert.equal(calls[0].prompt, "PROMPT");
	assert.equal(typeof calls[0].streamFn, "function", "an auth-wrapped stream must be supplied");
	assert.deepEqual(found, ["anthropic/claude-sonnet-4"], "no fallback model may be probed");
});

test("an unknown bare model id never borrows the parent or an ambiguous provider", async () => {
	const { modelRegistry } = registry();
	let invoked = false;
	const generator = createRecoveryBriefGenerator(
		{ model: { provider: "openai", id: "gpt-5" }, modelRegistry },
		{ inference: async () => { invoked = true; return "SHOULD_NOT_RUN"; } },
	);

	const ambiguous = await generator({ model: "mystery-model", prompt: "P" });
	assert.equal(ambiguous.ok, false);
	assert.equal(ambiguous.reason, "model-unavailable");
	assert.equal(invoked, false, "the parent model must never be borrowed for an unresolved child model");
});

test("an unambiguous bare model id resolves to its actual provider", async () => {
	const { modelRegistry } = registry();
	const calls = [];
	const generator = createRecoveryBriefGenerator(
		{ model: { provider: "openai", id: "gpt-5" }, modelRegistry },
		{
			inference: async (input) => {
				calls.push(input);
				return "BRIEF";
			},
		},
	);

	const outcome = await generator({ model: "claude-sonnet-4", prompt: "P" });
	assert.equal(outcome.ok, true);
	assert.equal(calls[0].model.provider, "anthropic");
	assert.equal(calls[0].model.id, "claude-sonnet-4");
});

test("a missing dated model is not replaced with another version", async () => {
	const model = { provider: "test", id: "model-20260101", api: "test-api" };
	let calls = 0;
	const generator = createRecoveryBriefGenerator({
		modelRegistry: {
			getAvailable: () => [model],
			find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
	}, { inference: async () => { calls += 1; return "WRONG_MODEL_BRIEF"; } });
	const outcome = await generator({ model: "test/model-20250101", thinking: "high", prompt: "P" });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "model-unavailable");
	assert.equal(calls, 0);
});

test("a qualified missing model is not borrowed from another provider's bare id", async () => {
	const model = { provider: "other", id: "test/missing", api: "test-api" };
	let calls = 0;
	const generator = createRecoveryBriefGenerator({ modelRegistry: {
		getAvailable: () => [model],
		find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
	} }, { inference: async () => { calls += 1; return "WRONG_PROVIDER"; } });
	const outcome = await generator({ model: "test/missing", thinking: "high", prompt: "P" });
	assert.equal(outcome.ok, false);
	assert.equal(calls, 0);
});

test("an errored terminal assistant with partial text remains a failed inference", async () => {
	const { modelRegistry } = registry();
	const generator = createRecoveryBriefGenerator({ modelRegistry }, {
		agentFactory: () => ({
			state: { messages: [{
				role: "assistant", stopReason: "error", errorMessage: "socket reset",
				content: [{ type: "text", text: "UNFINISHED_BRIEF" }],
				usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } },
			}] },
			async prompt() {},
			abort() {},
		}),
	});
	const outcome = await generator({ model: "anthropic/claude-sonnet-4", thinking: "high", prompt: "P" });
	assert.equal(outcome.ok, false);
	assert.match(outcome.reason, /socket reset/);
	assert.deepEqual(outcome.usage, { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.05 });
});

test("a model the registry cannot resolve reports model-unavailable", async () => {
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry: { find: () => undefined, getAvailable: () => [] } },
		{ inference: async () => "SHOULD_NOT_RUN" },
	);
	const outcome = await generator({ model: "anthropic/claude-sonnet-4", prompt: "P" });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "model-unavailable");
});

test("missing credentials report model-auth-unavailable instead of calling out", async () => {
	const { modelRegistry } = registry({ getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) });
	let invoked = false;
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry },
		{ inference: async () => { invoked = true; return "X"; } },
	);
	const outcome = await generator({ model: "anthropic/claude-sonnet-4", prompt: "P" });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "model-auth-unavailable");
	assert.equal(invoked, false, "no transport call without credentials");
});

test("a throwing or timing-out inference settles as a failure instead of hanging", async () => {
	const { modelRegistry } = registry();
	const throwing = createRecoveryBriefGenerator(
		{ modelRegistry },
		{ inference: async () => { throw new Error("recovery-brief inference timed out after 45000ms"); } },
	);
	const failed = await throwing({ model: "anthropic/claude-sonnet-4", prompt: "P" });
	assert.equal(failed.ok, false);
	assert.match(failed.reason, /timed out/);
});

test("an already-aborted signal never starts an inference", async () => {
	const { modelRegistry } = registry();
	let invoked = false;
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry },
		{ inference: async () => { invoked = true; return "X"; } },
	);
	const controller = new AbortController();
	controller.abort();
	const outcome = await generator({ model: "anthropic/claude-sonnet-4", prompt: "P", signal: controller.signal });
	assert.equal(outcome.ok, false);
	assert.equal(invoked, false);
});

test("an already-aborted signal never constructs the default Agent", async () => {
	const { modelRegistry } = registry();
	let factoryCalls = 0;
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry },
		{
			agentFactory: () => {
				factoryCalls += 1;
				return { state: { messages: [] }, prompt: async () => {}, abort() {} };
			},
		},
	);
	const controller = new AbortController();
	controller.abort();
	const outcome = await generator({ model: "anthropic/claude-sonnet-4", prompt: "P", signal: controller.signal });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "aborted");
	assert.equal(factoryCalls, 0);
});

test("cancellation during Agent setup prevents the default transport from prompting", async () => {
	const { modelRegistry } = registry();
	const controller = new AbortController();
	let prompts = 0;
	const generator = createRecoveryBriefGenerator({ modelRegistry }, {
		agentFactory: () => {
			controller.abort();
			return {
				state: { messages: [] },
				async prompt() { prompts += 1; },
				abort() {},
			};
		},
	});
	const outcome = await generator({ model: "anthropic/claude-sonnet-4", prompt: "P", signal: controller.signal });
	assert.equal(outcome.ok, false);
	assert.equal(prompts, 0, "a cancelled setup must not initiate a model request");
});

test("empty output and oversized output are handled", async () => {
	const { modelRegistry } = registry();
	const empty = createRecoveryBriefGenerator({ modelRegistry }, { inference: async () => "   " });
	assert.deepEqual(await empty({ model: "anthropic/claude-sonnet-4", prompt: "P" }), {
		ok: false,
		reason: "empty-model-output",
	});

	const huge = createRecoveryBriefGenerator({ modelRegistry }, { inference: async () => "x".repeat(20_000) });
	const bounded = await huge({ model: "anthropic/claude-sonnet-4", prompt: "P" });
	assert.equal(bounded.ok, true);
	assert.ok(bounded.text.length < 9_000, "the brief must stay bounded");
	assert.match(bounded.text, /brief truncated/);
});

test("the default Agent transport returns the provider-reported usage once", async () => {
	const { modelRegistry } = registry();
	let prompts = 0;
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry },
		{
			agentFactory: () => ({
				state: { messages: [] },
				async prompt() {
					prompts += 1;
					this.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "BRIEF_FROM_AGENT" }],
						usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } },
					});
				},
				abort() {},
			}),
		},
	);

	const outcome = await generator({ model: "anthropic/claude-sonnet-4", thinking: "high", prompt: "P" });
	assert.equal(outcome.ok, true);
	assert.equal(outcome.text, "BRIEF_FROM_AGENT");
	assert.equal(outcome.model, "anthropic/claude-sonnet-4");
	assert.equal(outcome.thinking, "high");
	assert.deepEqual(outcome.usage, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25 });
	assert.equal(prompts, 1, "exactly one inference attempt, no retries");
});

test("a timed-out default transport keeps the usage it already reported", async () => {
	const { modelRegistry } = registry();
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry },
		{
			timeoutMs: 40,
			agentFactory: () => {
				const agent = {
					state: { messages: [] },
					prompt() {
						return new Promise((resolve) => { agent.resolvePrompt = resolve; });
					},
					abort() {
						if (!agent.resolvePrompt) return;
						agent.state.messages.push({
							role: "assistant",
							content: [{ type: "text", text: "partial" }],
							usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.05 },
						});
						agent.resolvePrompt();
						agent.resolvePrompt = undefined;
					},
				};
				return agent;
			},
		},
	);

	const outcome = await generator({ model: "anthropic/claude-sonnet-4", prompt: "P" });
	assert.equal(outcome.ok, false);
	assert.match(outcome.reason, /timed out/);
	assert.deepEqual(outcome.usage, { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.05 });
});

test("aborting the default transport preserves reported usage but returns no brief", async () => {
	const { modelRegistry } = registry();
	const controller = new AbortController();
	let signalStarted;
	const started = new Promise((resolve) => { signalStarted = resolve; });
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry },
		{
			timeoutMs: 1_000,
			agentFactory: () => {
				const agent = {
					state: { messages: [] },
					prompt() {
						signalStarted();
						return new Promise((resolve) => { agent.resolvePrompt = resolve; });
					},
					abort() {
						if (!agent.resolvePrompt) return;
						agent.state.messages.push({
							role: "assistant",
							content: [{ type: "text", text: "partial" }],
							usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
						});
						agent.resolvePrompt();
						agent.resolvePrompt = undefined;
					},
				};
				return agent;
			},
		},
	);

	const pending = generator({ model: "anthropic/claude-sonnet-4", prompt: "P", signal: controller.signal });
	await started;
	controller.abort();
	const outcome = await pending;
	assert.equal(outcome.ok, false);
	assert.equal(outcome.reason, "aborted");
	assert.deepEqual(outcome.usage, { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
});

test("a hanging auth lookup is bounded by the whole-lifecycle deadline", async () => {
	const { modelRegistry } = registry({
		getApiKeyAndHeaders: () => new Promise(() => {}),
	});
	let invoked = false;
	const generator = createRecoveryBriefGenerator(
		{ modelRegistry },
		{ timeoutMs: 30, inference: async () => { invoked = true; return "X"; } },
	);

	const startedAt = Date.now();
	const outcome = await generator({ model: "anthropic/claude-sonnet-4", prompt: "P" });
	assert.equal(outcome.ok, false);
	assert.match(outcome.reason, /auth timed out/);
	assert.equal(invoked, false, "no transport call after auth timed out");
	assert.ok(Date.now() - startedAt < 2_000, "the auth wait must be bounded");
});

test("inference usage reaches result usage and the parent aggregate exactly once", async () => {
	const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25 };
	const result = {
		exitCode: 1,
		error: "boom",
		model: "anthropic/claude-sonnet-4",
		thinking: "high",
		messages: [{ role: "assistant", content: [{ type: "text", text: "did work" }] }],
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5, turns: 6 },
		progressSummary: { toolCount: 1 },
	};
	const applied = await applyRecoveryBrief({
		result,
		evidenceInput: { task: "TASK", exitCode: 1, error: "boom", messages: result.messages },
		generator: async () => ({ ok: true, text: "BRIEF", usage }),
	});

	assert.deepEqual(applied.usage, usage);
	assert.equal(foldRecoveryBriefUsage(result.usage, applied.usage), true);
	const aggregate = sumResultsUsage([result]);
	assert.deepEqual(aggregate, { input: 11, output: 7, cacheRead: 5, cacheWrite: 5, cost: 5.25, turns: 6 });
});
