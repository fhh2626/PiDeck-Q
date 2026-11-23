import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const atoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const buildTurn = readFileSync(
  "src/renderer/src/components/session/timeline/buildTurnDisplay.ts",
  "utf8",
);
const turnRow = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const thinkingStep = readFileSync(
  "src/renderer/src/components/session/turn/ThinkingStep.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);
const appUtils = readFileSync(
  "src/renderer/src/components/app/AppUtils.ts",
  "utf8",
);

test("ThinkingUpdate payload carries stable id + lifecycle fields", () => {
  assert.match(agentTypes, /export type ThinkingUpdate = \{/);
  assert.match(agentTypes, /id: string;/);
  // 2026-08 增量协议：text 变可选（全量快照时携带），delta 为增量推送
  assert.match(agentTypes, /text\??: string;/);
  assert.match(agentTypes, /delta\??: string;/);
  assert.match(agentTypes, /startedAt: number;/);
  assert.match(agentTypes, /endedAt: number;/);
  assert.match(agentTypes, /done: boolean;/);
  assert.doesNotMatch(
    agentTypes.slice(agentTypes.indexOf("export type ThinkingUpdate"), agentTypes.indexOf("export type ComposerAgentMode")),
    /^\s*thinking:\s*string;/m,
  );
});

test("renderer: thinking atoms merge streamed deltas", () => {
  assert.match(atoms, /typeof payload\.delta === "string"/);
  assert.match(atoms, /\(prev\?\.text \?\? ""\) \+ delta/);
});

test("renderer: done keeps live identity until History thinking is visible", () => {
  assert.match(atoms, /tryReleaseLiveThinkingAfterHistory/);
  assert.match(atoms, /streamingThinkingEntryByIdAtomFamily/);
  assert.match(atoms, /liveThinkingIdBySessionIdAtomFamily/);
  assert.match(atoms, /disposeStreamingThinkingFamily/);
  assert.match(atoms, /streamingThinkingEntryByIdAtomFamily\.remove/);

  const thinkingIdx = atoms.indexOf('event.sourceChannel === "agents:thinking"');
  const textIdx = atoms.indexOf('event.sourceChannel === "agents:text-stream"');
  assert.ok(thinkingIdx >= 0 && textIdx > thinkingIdx);
  const thinkingBlock = atoms.slice(thinkingIdx, textIdx);
  // done 路径不得直接 delete live id；须标 streaming:false 后尝试 History 接管释放
  assert.match(thinkingBlock, /streaming:\s*false/);
  assert.match(thinkingBlock, /tryReleaseLiveThinkingAfterHistory/);
  assert.doesNotMatch(thinkingBlock, /delete nextMap\[event\.sessionId\]/);
  assert.doesNotMatch(atoms, /thinking:\s*string;/);
});

test("renderer: releasing live thinking also removes atomFamily instance", () => {
  const releaseIdx = atoms.indexOf("function tryReleaseLiveThinkingAfterHistory");
  const clearIdx = atoms.indexOf("function clearSessionLiveThinking");
  assert.ok(releaseIdx >= 0 && clearIdx >= 0);
  const releaseBlock = atoms.slice(releaseIdx, releaseIdx + 1200);
  const clearBlock = atoms.slice(clearIdx, clearIdx + 1200);
  assert.match(releaseBlock, /disposeStreamingThinkingFamily\(liveId\)/);
  assert.match(clearBlock, /disposeStreamingThinkingFamily\(id\)/);
});

test("renderer: message flush also tries live→History release", () => {
  const msgIdx = atoms.indexOf('event.sourceChannel === "agents:message"');
  assert.ok(msgIdx >= 0);
  // 切片窗口：windowStartFilePos（2026-11 数值游标）+ cardCount（2026-12 卡片偏移修正）
  // 解析均位于同一块内，窗口相应放大
  const msgBlock = atoms.slice(msgIdx, msgIdx + 3600);
  assert.match(msgBlock, /tryReleaseLiveThinkingAfterHistory/);
});

test("UI: timeline only subscribes liveThinkingId; ThinkingStep uses per-id family", () => {
  assert.match(timeline, /liveThinkingIdBySessionIdAtomFamily/);
  assert.doesNotMatch(timeline, /streamingThinkingByIdAtom/);
  assert.match(timeline, /thinking=\{liveThinkingId \? "\." : undefined\}/);
  assert.match(thinkingStep, /streamingThinkingEntryByIdAtomFamily/);
  assert.doesNotMatch(thinkingStep, /useAtomValue\(streamingThinkingByIdAtom\)/);
  assert.match(buildTurn, /liveThinkingId\?:/);
  assert.match(turnRow, /liveThinkingId: props\.liveThinkingId/);
  assert.doesNotMatch(turnRow, /liveThinkingGroup/);
});

test("AppUtils emits one thinking-group per thinking-only message", () => {
  const flushIdx = appUtils.indexOf("function flushThinking()");
  const flushBlock = appUtils.slice(flushIdx, flushIdx + 900);
  assert.match(flushBlock, /for \(const message of currentThinking\)/);
  assert.doesNotMatch(flushBlock, /\.join\("\\n\\n"\)/);
  assert.match(appUtils, /立即成组/);
});
