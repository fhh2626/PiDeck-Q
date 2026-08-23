import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Live 正文通道契约：History / Live / Controls 三层。
 * - text_delta 不增长 messages；message_start 建空骨架
 * - agents:text-stream → streamingTextByIdAtom；不 bump runtime
 * - UI 经 AnswerOutput(live) 消费，不再使用 StreamingAnswerBubble
 */

test("main process: textEmitter tracks and pushes streaming text", () => {
  const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

  assert.match(agentManager, /private readonly textEmitter = new LatestByKeyEmitter/);
  assert.match(agentManager, /private static readonly MESSAGE_FLUSH_INTERVAL_MS = 50/);
  assert.match(agentManager, /this\.streamingText\.set\(agentId, nextText\)/);
  assert.match(agentManager, /this\.textEmitter\.push\(agentId, stripAnsi\(nextText\)\)/);

  const cancelCount = agentManager.match(/this\.textEmitter\.cancel\(agentId\)/g)?.length ?? 0;
  assert.ok(cancelCount >= 4, "textEmitter must cancel on end/settled/abort paths");
  const deleteCount = agentManager.match(/this\.streamingText\.delete\(agentId\)/g)?.length ?? 0;
  assert.ok(deleteCount >= 4, "streamingText must clear on end/settled/abort paths");
});

test("main process: top-level message_start creates empty skeleton", () => {
  const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
  assert.match(agentManager, /allowEmpty:\s*true/);
  assert.match(agentManager, /options\?: \{ allowEmpty\?: boolean \}/);
  // 顶层 message_start（非 assistantMessageEvent）必须 allowEmpty + flush
  const topStart = agentManager.indexOf('typed.type === "message_start"');
  const autoRetry = agentManager.indexOf('typed.type === "auto_retry_start"');
  assert.ok(topStart >= 0 && autoRetry > topStart);
  const block = agentManager.slice(topStart, autoRetry);
  assert.match(block, /allowEmpty:\s*true/);
  assert.match(block, /flushMessageEmit/);
  assert.match(block, /this\.setStreamingAgent\(agentId, true\)/);

  // text_delta 分支内不得调用 upsertAssistantMessage
  const textDeltaIdx = agentManager.indexOf('if (eventType === "text_delta")');
  const thinkingDeltaIdx = agentManager.indexOf('if (eventType === "thinking_delta")');
  assert.ok(textDeltaIdx >= 0 && thinkingDeltaIdx > textDeltaIdx);
  const textDeltaBlock = agentManager.slice(textDeltaIdx, thinkingDeltaIdx);
  assert.doesNotMatch(textDeltaBlock, /this\.upsertAssistantMessage\(/);
  assert.match(textDeltaBlock, /this\.textEmitter\.push\(/);

  const thinkingEndIdx = agentManager.indexOf('if (eventType === "thinking_end")');
  const thinkingDeltaBlock = agentManager.slice(thinkingDeltaIdx, thinkingEndIdx);
  assert.doesNotMatch(thinkingDeltaBlock, /this\.upsertAssistantMessage\(/);
  assert.match(thinkingDeltaBlock, /this\.thinkingEmitter\.push\(/);
});

test("main process: message_end pushes final text with done flag", () => {
  const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
  assert.match(
    agentManager,
    /this\.emitTextStreamNow\(agentId, finalText, true\)/,
  );
  assert.match(agentManager, /emitTextStreamNow\(agentId: string, text: string, done = false\)/);
});

test("contract: agents:text-stream payload carries messageId (per-message binding)", () => {
  // 回归背景：live 正文按 assistantMessageId 精确绑定消息，不再用「最后一个
  // agent-run」猜测归属。若主进程移除 messageId 下发，渲染层拿不到 id，
  // liveInterimId 判定永远不匹配 → live 正文静默不显示（安全降级但功能失效）。
  // 此契约测试直接锁定下发链路，防止未来回归到 sessionId 级单槽。
  const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");

  // emitTextStreamNow 必须从 activeAssistantMessageIds 取当前 assistant id 并入帧
  const emitIdx = agentManager.indexOf("private emitTextStreamNow");
  assert.ok(emitIdx >= 0, "emitTextStreamNow must exist");
  const emitBlock = agentManager.slice(emitIdx, emitIdx + 1200);
  assert.match(emitBlock, /activeAssistantMessageIds\.get\(agentId\)/);
  assert.match(emitBlock, /messageId \? \{ messageId \}/);
  assert.match(emitBlock, /payload: TextStreamUpdate/);

  // 共享类型必须声明可选 messageId 字段
  const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
  const typeIdx = agentTypes.indexOf("export type TextStreamUpdate");
  assert.ok(typeIdx >= 0, "TextStreamUpdate type must exist");
  const typeBlock = agentTypes.slice(typeIdx, typeIdx + 300);
  assert.match(typeBlock, /messageId\?: string;/);

  // 渲染层事件分支必须解析 messageId 并写入 streamingTextByIdAtom 条目
  const atoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
  const streamIdx = atoms.indexOf('event.sourceChannel === "agents:text-stream"');
  assert.ok(streamIdx >= 0, "text-stream branch must exist");
  const messagesBranchIdx = atoms.indexOf('event.sourceChannel === "agents:message"');
  const branch = atoms.slice(streamIdx, messagesBranchIdx > streamIdx ? messagesBranchIdx : undefined);
  assert.match(branch, /typeof payload\.messageId === "string" \? payload\.messageId : \(prev\?\.messageId \?\? ""\)/);
  assert.match(branch, /messageId, content: text, streaming \}/);

  // TurnRow 挂载判定必须消费 streamingMessageId（id 不匹配不挂）
  const liveMount = readFileSync(
    "src/renderer/src/components/session/timeline/liveMount.ts",
    "utf8",
  );
  assert.match(liveMount, /input\.lastInterimId !== input\.streamingMessageId/);
});

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

test("IPC channel wiring for agents:text-stream", () => {
  const ipc = readFileSync("src/shared/ipc.ts", "utf8");
  assert.match(ipc, /agentsTextStream: "agents:text-stream"/);

  const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
  assert.match(agentManager, /ipcChannels\.agentsTextStream/);
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
