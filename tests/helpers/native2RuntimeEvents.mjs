import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakePi, startBackendSession } from "./native2BackendHarness.mjs";

/**
 * Shared scaffolding for the native2 runtime-lifecycle suites.
 *
 * Everything here is public-boundary only: a real `PiDeckBackend.exe`, a scripted fake pi
 * speaking the real stdio JSON-RPC protocol, and the renderer's `sessions:runtime-event`
 * envelopes. No backend source is imported, so a passing test is evidence about behaviour
 * rather than about internal structure.
 */

export const slash = (value) => String(value).replaceAll("\\", "/");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` returns truthy (20 ms cadence, bounded). */
export async function waitFor(predicate, timeoutMs = 15_000, label = "condition") {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = predicate();
		if (found) return found;
		await sleep(20);
	}
	throw new Error(`${label} did not become true`);
}

/** Minimal pi session file so a real runtime can be activated inside the fixture. */
export function writeSessionFile(sessionsDir, projectPath, name) {
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
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

export const messageStart = (id) => ({
	type: "message_start",
	message: { id, role: "assistant", content: [] },
});

export const textUpdate = (assistantMessageEvent, content = []) => ({
	type: "message_update",
	message: { role: "assistant", content },
	assistantMessageEvent,
});

export const textDelta = (delta) => textUpdate({ type: "text_delta", delta });
export const thinkingDelta = (delta) => textUpdate({ type: "thinking_delta", delta });
export const thinkingEnd = () => textUpdate({ type: "thinking_end" });

export const messageEnd = (text) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
});

/** Every runtime envelope of one session, in arrival order (`sessions:runtime-event`). */
export function runtimeEnvelopes(sse, sessionId) {
	return sse.frames
		.map((frame) => frame.payload)
		.filter((payload) => payload && payload.channel === "sessions:runtime-event")
		.map((payload) => payload.args[0])
		.filter((event) => event && event.sessionId === sessionId);
}

/** Payloads of one `sourceChannel` for one session, in arrival order. */
export function channelEvents(sse, sessionId, channel) {
	return channelPayloads(runtimeEnvelopes(sse, sessionId), channel);
}

/** Same filter for an already collected envelope list (no SSE client at hand). */
export function channelPayloads(envelopes, channel) {
	return envelopes
		.filter((event) => event.sourceChannel === channel)
		.map((event) => event.payload);
}

export function statusFrames(sse, sessionId) {
	return channelEvents(sse, sessionId, "agents:state").map((tab) => tab.status);
}

/**
 * `meta.i18nKey` values `upsertRetryStatusMessage` writes (`src/main/pi/AgentManager.ts`).
 *
 * The retry row is a floating diagnostic card, so these keys plus `meta.status` are the
 * only oracle fields that identify it. A native-only `meta.type: "retryStatus"` marker was
 * used as the locator instead, which made the payload carry an extra field the Node path
 * never produces (and made these suites impossible to replay against the oracle).
 */
export const RETRY_STATUS_KEYS = new Set([
	"diagnostic.retryScheduled",
	"diagnostic.retryScheduledAfterDelay",
	"diagnostic.retrySucceeded",
	"diagnostic.retryFailed",
]);

/** True for the one retry-status row of a transcript, located by oracle fields only. */
export const isRetryStatusRow = (row) =>
	RETRY_STATUS_KEYS.has(row?.meta?.i18nKey) && typeof row?.meta?.status === "string";

/**
 * `agents:runtime-state` tool-edge patches of one session, in arrival order.
 *
 * Three shapes share the channel: the full `AgentRuntimeState` projection (has
 * `isCompacting`), the streaming-flag patch (has `isStreaming`) and the tool-batch edge
 * (only `isExecutingTool` / `executingToolName` / `toolStateSequence`). The tool edge is
 * the only one that both carries `isExecutingTool` and omits the other two flags.
 */
export function toolEdgePatches(sse, sessionId) {
	return channelEvents(sse, sessionId, "agents:runtime-state")
		.map((payload) => payload.state)
		.filter((state) => state && typeof state === "object"
			&& "isExecutingTool" in state
			&& !("isStreaming" in state)
			&& !("isCompacting" in state));
}

/**
 * Start a backend with a scripted fake pi for one suite.
 *
 * The project directory is owned by the *suite* (`before`/`after`), not by the test: the
 * backend and its pi children hold the project directory as their cwd, so a test-scoped
 * cleanup would delete a directory Windows still has open.
 *
 * Returns the fixture/session plus `activate(name)` (catalog import + runtime activation)
 * so each suite only scripts the pi events it is about.
 */
export async function startRuntimeBackend(
	t,
	{ projectPath, projectId, scenario = {}, settings = {}, env = {} },
) {
	let fake = null;
	const session = await startBackendSession(t, {
		projects: [{ id: projectId, path: projectPath }],
		settings: { language: "en-US", ...settings },
		prepare: (fixture) => {
			fake = createFakePi(fixture, scenario);
			return {
				settings: { customPiPath: fake.shim },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath, ...env },
			};
		},
	});
	const activate = async (name) => {
		const filePath = writeSessionFile(session.fixture.sessions, projectPath, name);
		const listed = await session.invoke("sessions:catalog-list", [projectId]);
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
		const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
		assert.ok(record, "the session file must be imported into the catalog");
		const activated = await session.invoke("sessions:runtime-activate", [record.id]);
		assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
		return { record, target: activated.payload.result.value };
	};
	const prompt = (record, message, requestId) => session.invoke("sessions:send-prompt", [{
		sessionId: record.id,
		requestId,
		message,
	}]);
	return { ...session, fake, activate, prompt };
}

/** Create the suite-owned project directory (call from `before`). */
export function createSuiteProject(prefix = "pideck-native2-runtime-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const projectPath = join(root, "project");
	mkdirSync(projectPath, { recursive: true });
	return { root, projectPath };
}

/** Remove a suite-owned project directory (call from `after`). */
export function removeSuiteProject(root) {
	if (!root) return;
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
