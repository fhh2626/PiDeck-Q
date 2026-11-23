import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("renderer: the live text stream updates and clears without waking runtime or history", () => {
  const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
  const store = createStore();
  const sessionId = "text-stream-session";
  const agentId = "agent";
  const emit = (sourceChannel, payload) => store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId, agentId, runtimeGeneration: 1, sourceChannel, payload,
  });
  emit("agents:message", { messages: [] });
  const runtime = store.get(atoms.sessionRuntimeByIdAtom);
  const history = store.get(atoms.sessionMessagesCacheAtom);
  emit("agents:text-stream", { messageId: "reply", text: "First" });
  emit("agents:text-stream", { messageId: "reply", delta: " part" });
  const live = () => store.get(atoms.streamingTextByIdAtom)[sessionId];
  assert.equal(live().content, "First part");
  assert.equal(live().streaming, true);
  emit("agents:text-stream", { messageId: "reply", text: "fresh full snapshot" });
  assert.equal(live().content, "fresh full snapshot");
  emit("agents:text-stream", { messageId: "reply", done: true });
  assert.equal(live(), undefined);
  assert.equal(store.get(atoms.sessionRuntimeByIdAtom), runtime);
  assert.equal(store.get(atoms.sessionMessagesCacheAtom), history);
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
