import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-state-fields";

/**
 * pi session with two assistant usages:
 *  - latest hit rate = 50 / (50 + 50) = 50 %
 *  - average of 90 % and 50 % = 70 %, sampleCount 2
 */
function writeSessionFile(sessionsDir, projectPath, name) {
	const assistant = (id, parentId, at, usage) => ({
		type: "message",
		id,
		parentId,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: `reply ${id}` }],
			timestamp: at,
			usage,
		},
	});
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
		},
		assistant("a1", "u1", 1_767_225_602_000, { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105 }),
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: { role: "user", content: [{ type: "text", text: "again" }], timestamp: 1_767_225_603_000 },
		},
		assistant("a2", "u2", 1_767_225_604_000, { input: 50, output: 7, cacheRead: 50, cacheWrite: 0, totalTokens: 107 }),
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

/** A reply with a measurable TTFT and generation window (delays make the numbers real). */
const timedReply = (text, usage) => [
	{ delayMs: 0, event: { type: "agent_start" } },
	{ delayMs: 5, event: { type: "message_start", message: { role: "assistant", content: [] } } },
	{ delayMs: 10, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: text } } },
	{ delayMs: 60, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage } } },
	{ delayMs: 5, event: { type: "agent_end", messages: [] } },
	{ delayMs: 5, event: { type: "agent_settled" } },
];

async function waitFor(predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = await predicate();
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("expected condition did not become true");
}

if (executable) {
	describe("native2 runtime-state cache-hit and reply-perf parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-state-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {} } = {}) => {
			let fake = null;
			const name = `s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
			let plannedPath = "";
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					plannedPath = join(fixture.sessions, `${name}.jsonl`);
					fake = createFakePi(fixture, {
						...scenario,
						state: { ...(scenario.state ?? {}), sessionFile: plannedPath },
					});
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, name);
			assert.equal(filePath, plannedPath);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find(
				(entry) => String(entry.filePath).replaceAll("\\", "/") === filePath.replaceAll("\\", "/"),
			);
			assert.ok(record, "imported session must appear in the catalog");
			return { ...session, fake, record, filePath };
		};

		test("getRuntimeState reports cache-hit statistics from the session file", async (t) => {
			const { invoke, record } = await start(t);
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;

			const state = await invoke("sessions:runtime-state", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(state.payload.ok, true, JSON.stringify(state.payload));
			assert.equal(state.payload.result.ok, true, JSON.stringify(state.payload));
			const value = state.payload.result.value.value;
			assert.equal(value.cacheHitPercent, 50, JSON.stringify(value));
			assert.equal(value.cacheHitAveragePercent, 70, JSON.stringify(value));
			assert.equal(value.cacheHitSampleCount, 2, JSON.stringify(value));
		});

		test("set-model resolves with the projected AgentRuntimeState, not pi's raw reply", async (t) => {
			// Oracle `setRuntimeModel` → `AgentManager.setModel` → `getRuntimeState`, so the
			// channel returns `SessionTargetedValue<AgentRuntimeState>`. The renderer merges the
			// whole object into its runtime state atom (ComposerPickerHost
			// `applyRuntimeModelState`), which is why pi's `set_model` data (`{model}`) cannot be
			// forwarded: it has no modelId/provider/cache-hit/perf fields.
			const { invoke, record } = await start(t, {
				scenario: {
					state: {
						model: { provider: "anthropic", id: "claude-sonnet-4", name: "Sonnet 4" },
						thinkingLevel: "low",
					},
				},
			});
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;

			const switched = await invoke("sessions:runtime-set-model", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}, "anthropic", "claude-sonnet-4"]);
			assert.equal(switched.payload.ok, true, JSON.stringify(switched.payload));
			assert.equal(switched.payload.result.ok, true, JSON.stringify(switched.payload));

			// The wrapper is the targeted value, not pi's `{model: {...}}` payload.
			assert.equal(switched.payload.result.value.target.agentId, target.agentId);
			const value = switched.payload.result.value.value;
			assert.equal(value.model, undefined, JSON.stringify(value));
			assert.equal(value.modelId, "claude-sonnet-4", JSON.stringify(value));
			assert.equal(value.provider, "anthropic", JSON.stringify(value));
			assert.equal(value.modelName, "Sonnet 4", JSON.stringify(value));
			assert.equal(value.thinkingLevel, "low", JSON.stringify(value));
			// Local session-file statistics ride along, exactly like `sessions:runtime-state`.
			assert.equal(value.cacheHitPercent, 50, JSON.stringify(value));
			assert.equal(value.cacheHitSampleCount, 2, JSON.stringify(value));
		});

		test("a settled reply publishes TTFT/total/TPS and keeps them on later polls", async (t) => {
			const { invoke, record } = await start(t, {
				scenario: { turns: [{ ack: true, events: timedReply("answer", { output: 20 }) }] },
			});
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "perf-1",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			const state = await waitFor(async () => {
				const response = await invoke("sessions:runtime-state", [{
					sessionId: record.id,
					agentId: target.agentId,
					runtimeGeneration: target.runtimeGeneration,
				}]);
				const value = response.payload.result?.value?.value;
				return value && typeof value.ttftMs === "number" && typeof value.tps === "number" ? value : null;
			});
			assert.equal(typeof state.ttftMs, "number", JSON.stringify(state));
			assert.ok(state.ttftMs >= 0, JSON.stringify(state));
			assert.equal(typeof state.totalMs, "number");
			assert.ok(state.totalMs >= state.ttftMs, JSON.stringify(state));
			assert.equal(typeof state.tps, "number");
			assert.ok(state.tps > 0, JSON.stringify(state));
			assert.equal(typeof state.perfAt, "number");
			assert.equal(state.cacheHitPercent, 50);
		});
	});
}
