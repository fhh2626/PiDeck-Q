import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("renderer uses Controls isStreaming for live run marking", () => {
	const timeline = readFileSync(
		"src/renderer/src/components/session/SessionMessageTimeline.tsx",
		"utf8",
	);
  assert.match(timeline, /isLatestTimelineRunBusy/);
  assert.match(timeline, /liveThinkingId=\{liveThinkingId\}/);
  assert.match(timeline, /liveThinkingIdBySessionIdAtomFamily/);
  assert.doesNotMatch(timeline, /streamingThinking=\{isRunStreaming \? activeThinking : undefined\}/);
  assert.doesNotMatch(timeline, /streamingMessageId/);
});
