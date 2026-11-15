import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, SseClient } from "./helpers/native2BackendHarness.mjs";
import {
	channelEvents,
	createSuiteProject,
	messageEnd,
	messageStart,
	removeSuiteProject,
	runtimeEnvelopes,
	startRuntimeBackend,
	textDelta,
	thinkingDelta,
	thinkingEnd,
	waitFor,
} from "./helpers/native2RuntimeEvents.mjs";

/**
 * Live thinking-segment parity (`AgentManager.markThinkingSegmentEnded`).
 *
 * Two rules the renderer depends on:
 *  1. `endedAt` stays 0 while the reasoning phase streams — the live bubble/auto-collapse
 *     logic reads `endedAt <= 0` as "still reasoning". Stamping the timestamp on every
 *     `thinking_delta` (the previous behaviour) made every live frame look finished.
 *  2. The phase is closed by the first body `text_delta` as well as by `thinking_end`:
 *     several providers switch straight from reasoning to text without an end event. The
 *     close is idempotent and publishes exactly one `endedAt > 0` frame with `done=false`;
 *     `done=true` stays owned by `message_end`.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "thinking-segment";

/**
 * Replay the coalesced frame stream into the text every frame leaves the renderer with.
 *
 * The channel sends a full `text` on the first push (and every 50th), otherwise a `delta`
 * against the previously sent value — which can legitimately be an empty delta when the
 * phase closes on a value that was already sent. Asserting on the *replayed* value is the
 * only stable way to check content without re-implementing the emitter.
 */
function replayText(frames) {
	const values = [];
	let current = "";
	for (const payload of frames) {
		if (typeof payload.text === "string") current = payload.text;
		else if (typeof payload.delta === "string") current += payload.delta;
		values.push(current);
	}
	return values;
}

if (executable) {
	describe("native2 thinking segment parity", () => {
		let root;
		let projectPath;

		before(() => {
			({ root, projectPath } = createSuiteProject("pideck-native2-thinking-"));
		});

		after(() => {
			removeSuiteProject(root);
		});

		const run = async (t, events) => {
			const session = await startRuntimeBackend(t, {
				scenario: { turns: [{ ack: true, events }] },
				projectId: PROJECT_ID,
				projectPath,
			});
			const { record } = await session.activate(`thinking-${Date.now()}`);
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			await session.prompt(record, "think then answer", `thinking-${Date.now()}`);
			await waitFor(
				() => channelEvents(sse, record.id, "agents:thinking").some((payload) => payload.done === true),
				15_000,
				"terminal thinking frame",
			);
			return runtimeEnvelopes(sse, record.id);
		};

		test("a text_delta closes an open thinking segment that never got thinking_end", async (t) => {
			const events = [
				{ event: { type: "agent_start" } },
				{ event: messageStart("msg_think") },
				{ delayMs: 10, event: thinkingDelta("plan ") },
				{ delayMs: 120, event: thinkingDelta("carefully") },
				// No thinking_end at all: the provider switches straight to the body.
				{ delayMs: 120, event: textDelta("answer") },
				{ delayMs: 80, event: messageEnd("answer") },
				{ delayMs: 10, event: { type: "agent_end", messages: [] } },
				{ delayMs: 10, event: { type: "agent_settled" } },
			];
			const envelopes = await run(t, events);
			const thinking = envelopes
				.filter((event) => event.sourceChannel === "agents:thinking")
				.map((event) => event.payload);

			const closed = thinking.filter((payload) => payload.endedAt > 0 && payload.done === false);
			assert.equal(
				closed.length,
				1,
				`exactly one phase-close frame, saw ${JSON.stringify(thinking)}`,
			);
			// Every other streaming frame kept `endedAt: 0` — no per-delta stamping.
			for (const payload of thinking.filter((entry) => entry !== closed[0])) {
				if (payload.done === true) continue;
				assert.equal(
					payload.endedAt,
					0,
					`endedAt must stay 0 while the phase streams: ${JSON.stringify(payload)}`,
				);
				assert.equal(payload.done, false);
			}
			// The close is the last streaming frame: nothing re-opens the phase after it.
			const lastStreaming = thinking.filter((payload) => payload.done === false).at(-1);
			assert.equal(lastStreaming, closed[0], `the close must end the phase: ${JSON.stringify(thinking)}`);
			assert.equal(replayText(thinking)[thinking.indexOf(closed[0])], "plan carefully");
			assert.ok(typeof closed[0].startedAt === "number" && closed[0].startedAt > 0, JSON.stringify(closed[0]));
			assert.equal(closed[0].id, thinking[0].id, "the phase keeps one identity");

			// The terminal frame is the single `done=true` one and carries the full text plus
			// the same (already stamped) endedAt.
			const done = thinking.filter((payload) => payload.done === true);
			assert.equal(done.length, 1, "only message_end may close the live thinking bubble");
			assert.equal(done[0].text, "plan carefully");
			assert.equal(done[0].endedAt, closed[0].endedAt);
		});

		test("thinking_end closes the phase once and later body deltas do not re-close it", async (t) => {
			const events = [
				{ event: { type: "agent_start" } },
				{ event: messageStart("msg_think_end") },
				{ delayMs: 10, event: thinkingDelta("weigh ") },
				{ delayMs: 120, event: thinkingDelta("options") },
				{ delayMs: 120, event: thinkingEnd() },
				{ delayMs: 60, event: textDelta("first ") },
				{ delayMs: 60, event: textDelta("second") },
				{ delayMs: 60, event: messageEnd("first second") },
				{ delayMs: 10, event: { type: "agent_end", messages: [] } },
				{ delayMs: 10, event: { type: "agent_settled" } },
			];
			const envelopes = await run(t, events);
			const thinking = envelopes
				.filter((event) => event.sourceChannel === "agents:thinking")
				.map((event) => event.payload);
			const closed = thinking.filter((payload) => payload.endedAt > 0 && payload.done === false);
			assert.equal(
				closed.length,
				1,
				`thinking_end must publish the close exactly once, saw ${JSON.stringify(thinking)}`,
			);
			const replayed = replayText(thinking);
			const closedIndex = thinking.indexOf(closed[0]);
			assert.equal(replayed[closedIndex], "weigh options", JSON.stringify(thinking));
			// Every frame before the close kept endedAt 0 (no per-delta stamping).
			for (const payload of thinking.slice(0, closedIndex)) {
				assert.equal(payload.endedAt, 0, JSON.stringify(payload));
			}
			const done = thinking.filter((payload) => payload.done === true);
			assert.equal(done.length, 1);
			assert.equal(done[0].text, "weigh options");
		});
	});
}
