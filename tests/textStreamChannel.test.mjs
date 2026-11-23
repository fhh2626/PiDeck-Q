import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("renderer: streamingTextByIdAtom updates from agents:text-stream without runtime bump", () => {
  const atoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
  assert.match(atoms, /export const streamingTextByIdAtom = atom/);
  assert.match(atoms, /Record<string, StreamingTextState>/);
  assert.match(atoms, /event\.sourceChannel === "agents:text-stream"/);
  assert.match(atoms, /const streaming = !done && text\.length > 0/);
  assert.match(atoms, /delete nextMap\[event\.sessionId\]/);

  // text-stream 分支必须 early return，避免无条件写 sessionRuntimeByIdAtom
  const textStreamIdx = atoms.indexOf('event.sourceChannel === "agents:text-stream"');
  const messagesIdx = atoms.indexOf('event.sourceChannel === "agents:message"');
  assert.ok(textStreamIdx >= 0 && messagesIdx > textStreamIdx);
  const textStreamBlock = atoms.slice(textStreamIdx, messagesIdx);
  assert.match(textStreamBlock, /\breturn;/);
});

test("UI: AnswerOutput live path; TurnRow does not subscribe streaming atom", () => {
  const turnRow = readFileSync(
    "src/renderer/src/components/session/turn/TurnRow.tsx",
    "utf8",
  );
  assert.match(turnRow, /sessionId\?: string/);
  assert.match(turnRow, /lastInterimId/);
  assert.match(turnRow, /liveInterimId/);
  assert.match(turnRow, /mode="live"/);
  assert.doesNotMatch(turnRow, /StreamingAnswerBubble/);
  assert.doesNotMatch(turnRow, /streamingTextByIdAtom/);
  assert.match(turnRow, /if \(prev\.isStreaming !== next\.isStreaming\) return false;/);
  assert.doesNotMatch(turnRow, /if \(prev\.isStreaming \|\| next\.isStreaming\) return false;/);

  const answer = readFileSync(
    "src/renderer/src/components/session/AnswerOutput.tsx",
    "utf8",
  );
  assert.match(answer, /streamingTextByIdAtom/);
  // live 走 MarkdownStream（与思考同构）：打字机收进 MarkdownStream，
  // 不得自持 useSmoothStream 造成双重打字机
  assert.match(answer, /<MarkdownStream/);
  assert.doesNotMatch(answer, /from "\.\.\/\.\.\/utils\/useSmoothStream"/);
  assert.match(answer, /mode: "live" \| "settled"/);
  assert.match(answer, /execution-interim markdown-body/);

  const interim = readFileSync(
    "src/renderer/src/components/session/turn/InterimAnswer.tsx",
    "utf8",
  );
  assert.match(interim, /AnswerOutput/);

  const timeline = readFileSync(
    "src/renderer/src/components/session/SessionMessageTimeline.tsx",
    "utf8",
  );
  assert.match(timeline, /sessionId=\{sessionId\}/);
  assert.match(timeline, /isLatestTimelineRunBusy/);
  assert.doesNotMatch(timeline, /streamingTextByIdAtom/);
  assert.doesNotMatch(timeline, /streamingMessageId/);
});

test("UI: settled AnswerOutput can play assistant-answer-settle fade", () => {
  const answer = readFileSync(
    "src/renderer/src/components/session/AnswerOutput.tsx",
    "utf8",
  );
  const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
  const turnRow = readFileSync(
    "src/renderer/src/components/session/turn/TurnRow.tsx",
    "utf8",
  );
  assert.match(answer, /settle\?: boolean/);
  assert.match(answer, /data-settle=\{props\.settle \? "1" : undefined\}/);
  assert.match(css, /\.execution-interim\[data-settle="1"\]/);
  assert.match(css, /assistant-answer-settle/);
  assert.match(turnRow, /settleId === item\.id/);
  assert.match(turnRow, /prevLiveIdRef/);
});
