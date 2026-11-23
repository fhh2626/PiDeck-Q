import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * `agents:runtime-state` light patch on the local streaming flag.
 *
 * Oracle: `AgentManager.setStreamingAgent` is edge-triggered and publishes
 * `{agentId, state:{isStreaming, isExecutingTool, executingToolName?, toolStateSequence}}`
 * only when the flag flips (`emitStreamingStatePatch`). The C++ backend used to set the
 * flag silently, so the renderer's stop button/spinner could keep the previous value from
 * the last full poll; an unconditional per-delta emit would instead flood the stream with
 * patches that the delivery budget has to trim.
 *
 * The assertions are therefore both about *presence* (a true and a false edge) and about
 * *position*: the true patch precedes the first reply frame (so the live row and the
 * running state appear together) and the false patch follows the terminal message frame
 * (so the history row is mounted before the spinner settles). Payload shape is asserted to
 * be the partial `AgentRuntimeState`, never a full state that could clobber `status`.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-streaming-patch";

function writeSessionFile(sessionsDir, projectPath, name) {
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

/** Runtime envelopes for one session, in arrival order. */
function runtimeEvents(sse, sessionId) {
	return sse.frames
		.map((frame) => frame.payload)
		.filter((payload) => payload.channel === "sessions:runtime-event")
		.map((payload) => payload.args[0])
		.filter((event) => event && event.sessionId === sessionId);
}

async function waitFor(predicate, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = predicate();
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("expected condition did not become true");
}

if (executable) {
	describe("native2 streaming flag patch parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-stream-patch-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {} } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const filePath = writeSessionFile(
				session.fixture.sessions,
				projectPath,
				`s-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
			);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find(
				(entry) => String(entry.filePath).replaceAll("\\", "/") === filePath.replaceAll("\\", "/"),
			);
			assert.ok(record, "imported session must appear in the catalog");
			return { ...session, fake, record };
		};

		/**
		 * Run one scripted reply and return its runtime envelopes plus the live target.
		 *
		 * Both parity cases differ only in the terminal event path (top-level `message_end`
		 * vs the `message_update` done/error branch), so the harness, the wait condition and
		 * the shared assertions stay identical instead of drifting apart.
		 */
		const runReply = async (t, events) => {
			const { invoke, record, baseUrl, token } = await start(t, { scenario: { turns: [{ ack: true, events }] } });
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;
			const sent = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "stream-flag-1",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));

			await waitFor(() => {
				const all = runtimeEvents(sse, record.id);
				const settled = all.some((event) => event.sourceChannel === "agents:state"
					&& event.payload?.status === "idle");
				const doneText = all.some((event) => event.sourceChannel === "agents:text-stream"
					&& event.payload?.done === true);
				return settled && doneText;
			});
			return { all: runtimeEvents(sse, record.id), target };
		};

		/**
		 * Edge, payload and position parity with `AgentManager.setStreamingAgent` /
		 * `emitStreamingStatePatch`, including the live-channel order shared by both terminal
		 * paths: `setStreamingAgent(false)` → `textEmitter.flush` → `emitTextStreamNow(done)`.
		 */
		const assertPatchParity = (all, target) => {
			// Light patches only: full `AgentRuntimeState` projections (activation, tool edges,
			// settled polls) also carry `isStreaming`, so the discriminator is the key set the
			// oracle's `emitStreamingStatePatch` writes, not a missing `status`.
			const lightKeys = new Set(["isStreaming", "isExecutingTool", "executingToolName", "toolStateSequence"]);
			const patches = all
				.map((event, index) => ({ event, index }))
				.filter(({ event }) => event.sourceChannel === "agents:runtime-state"
					&& event.payload?.state
					&& "isStreaming" in event.payload.state
					&& Object.keys(event.payload.state).every((key) => lightKeys.has(key)));
			const truePatches = patches.filter(({ event }) => event.payload.state.isStreaming === true);
			const falsePatches = patches.filter(({ event }) => event.payload.state.isStreaming === false);
			assert.equal(
				truePatches.length,
				1,
				`exactly one true edge for one reply, saw ${JSON.stringify(patches.map(({ event }) => event.payload.state))}`,
			);
			assert.equal(falsePatches.length, 1, "exactly one false edge when the reply finishes");

			const truePatch = truePatches[0];
			const falsePatch = falsePatches[0];
			const state = truePatch.event.payload.state;
			assert.equal(truePatch.event.kind, "event");
			assert.equal(truePatch.event.agentId, target.agentId);
			assert.equal(truePatch.event.runtimeGeneration, target.runtimeGeneration);
			assert.equal(state.isExecutingTool, false);
			assert.equal(typeof state.toolStateSequence, "number");
			// Partial state only: a full projection here would overwrite `status`/`sessionFile`
			// with values the patch does not own.
			assert.equal("status" in state, false, JSON.stringify(state));
			assert.equal("sessionFile" in state, false, JSON.stringify(state));
			assert.equal("isCompacting" in state, false, JSON.stringify(state));
			assert.equal(falsePatch.event.payload.state.isStreaming, false);

			// The light false patch is the *first* false report after the true edge: it must not
			// lag behind the next full poll.
			const firstFalse = all.findIndex((event, index) => index > truePatch.index
				&& event.sourceChannel === "agents:runtime-state"
				&& event.payload?.state
				&& event.payload.state.isStreaming === false
				&& "isCompacting" in event.payload.state);
			assert.ok(
				firstFalse === -1 || falsePatch.index < firstFalse,
				`the light false edge must not trail the full projection (${falsePatch.index} vs ${firstFalse})`,
			);

			// Ordering: patch(true) is written before the first frame of the reply and patch(false)
			// after the terminal frames of it (oracle `setStreamingAgent` positions). Later
			// `agents:message`/`agents:state` frames belong to `agent_end`/`agent_settled` and are
			// outside this window.
			const replyFrames = all
				.map((event, index) => ({ event, index }))
				.filter(({ event }) => event.sourceChannel === "agents:text-stream"
					|| event.sourceChannel === "agents:thinking"
					|| (event.sourceChannel === "agents:message"
						&& event.payload?.messages?.some((row) => row.role === "assistant")));
			assert.ok(replyFrames.length > 0, "the reply must publish frames");
			const firstReplyIndex = replyFrames[0].index;
			assert.ok(
				truePatch.index < firstReplyIndex,
				`isStreaming:true must precede the first reply frame (${truePatch.index} vs ${firstReplyIndex})`,
			);
			const answerIndex = all.findIndex((event) => event.sourceChannel === "agents:message"
				&& event.payload?.messages?.some((row) => row.role === "assistant" && row.text === "answer!"));
			const lastThinkingDone = all.reduce((found, event, index) => (event.sourceChannel === "agents:thinking"
				&& event.payload?.done === true ? index : found), -1);
			// The live text channel's terminal frame: the oracle publishes the flag edge off
			// *before* `emitTextStreamNow(finalText, true)`, so the spinner/stop button must not
			// outlive the answer by a frame.
			const textDoneIndex = all.reduce((found, event, index) => (event.sourceChannel === "agents:text-stream"
				&& event.payload?.done === true ? index : found), -1);
			assert.ok(answerIndex > 0, "the final answer must reach the history projection");
			assert.ok(textDoneIndex > 0, "the live text channel must close with done=true");
			assert.ok(
				falsePatch.index > answerIndex && falsePatch.index > lastThinkingDone,
				`isStreaming:false must follow the history flush (patch ${falsePatch.index}, message ${answerIndex}, thinking ${lastThinkingDone})`,
			);
			assert.ok(
				falsePatch.index < textDoneIndex,
				`isStreaming:false must precede the live text done frame (patch ${falsePatch.index}, text done ${textDoneIndex})`,
			);

			// The terminal frame is the projected answer: the false edge did not truncate it.
			const finalMessage = all
				.filter((event) => event.sourceChannel === "agents:message")
				.at(-1);
			assert.equal(
				finalMessage.payload.messages.some((row) => row.role === "assistant" && row.text === "answer!"),
				true,
				JSON.stringify(finalMessage.payload.messages.map((row) => [row.role, row.text])),
			);
		};

		test("the flag flips are published once per edge, before the first and after the last reply frame", async (t) => {
			const events = [
				{ event: { type: "agent_start" } },
				{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
				{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", delta: "ponder" } } },
				{ delayMs: 10, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_end" } } },
				{ delayMs: 10, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "an" } } },
				{ delayMs: 10, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "swer" } } },
				{ delayMs: 10, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "!" } } },
				{ delayMs: 10, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer!" }], stopReason: "stop" } } },
				{ event: { type: "agent_end", messages: [] } },
				{ event: { type: "agent_settled" } },
			];
			const { all, target } = await runReply(t, events);
			assertPatchParity(all, target);
		});

		test("the flag edge off precedes the live text done frame on the message_update done path", async (t) => {
			// pi can also terminate a reply through `assistantMessageEvent.done` (the oracle's
			// `message_end | done | error` branch). That path used to close the live text channel
			// before publishing the flag edge, i.e. in the opposite order of `setStreamingAgent`.
			const events = [
				{ event: { type: "agent_start" } },
				{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
				{ delayMs: 10, event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "answer!" } } },
				{ delayMs: 10, event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "answer!" }] }, assistantMessageEvent: { type: "done" } } },
				{ delayMs: 10, event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer!" }], stopReason: "stop" } } },
				{ event: { type: "agent_end", messages: [] } },
				{ event: { type: "agent_settled" } },
			];
			const { all, target } = await runReply(t, events);
			assertPatchParity(all, target);
		});
	});
}
