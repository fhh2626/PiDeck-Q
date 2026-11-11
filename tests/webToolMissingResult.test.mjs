/**
 * Web 端「结果未记录」契约：历史投影 → part 标记 → 分组/整轮展示。
 *
 * 关键回归：ask_question 没有 toolResult 时不能变成活提问表单；有真实结果的
 * part 即使残留标记也不能被降级成 unknown。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { chatMessagesToUiMessages } = loadTsCommonJs("src/renderer/src/web/webApi.ts", {
  globals: { fetch: () => Promise.reject(new Error("network disabled")) },
});
const {
  isWebToolPart,
  isPureToolMessage,
  isWebToolResultMissing,
  isWebLiveAskQuestionToolPart,
  groupWebAssistantParts,
} = loadTsCommonJs("src/renderer/src/web/webToolGroups.ts");
const { buildWebTurnDisplay } = loadTsCommonJs("src/renderer/src/web/webTurnDisplay.ts");

function toolMessage(overrides = {}) {
  return {
    id: "m-tool",
    agentId: "a1",
    role: "tool",
    text: "? subagent",
    timestamp: 10,
    meta: {
      status: "unknown",
      toolName: "subagent",
      toolCallId: "call-1",
      args: "{\"task\":\"inspect\"}",
      detailText: "Tool: subagent",
    },
    ...overrides,
  };
}

function toolPart(overrides = {}) {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: "call-1",
    state: "input-available",
    input: { command: "ls" },
    ...overrides,
  };
}

test("history projection marks a missing result with toolMetadata instead of a running state", () => {
  const [uiMessage] = chatMessagesToUiMessages([toolMessage()]);
  const [part] = uiMessage.parts;
  assert.equal(part.type, "dynamic-tool");
  assert.equal(part.state, "input-available");
  assert.equal(part.toolCallId, "call-1");
  // 沙箱里产出对象原型不同，逐字段比较而不是 deepEqual。
  assert.equal(part.input.task, "inspect");
  assert.equal(part.toolMetadata.resultMissing, true);
  assert.equal(part.output, undefined);
  assert.equal(part.errorText, undefined);
  assert.equal(isWebToolResultMissing(part), true);
});

test("a real result wins over a stale missing-result marker", () => {
  const settled = toolPart({ state: "output-available", output: "ok", toolMetadata: { resultMissing: true } });
  assert.equal(isWebToolResultMissing(settled), false);
  const failed = toolPart({ state: "output-error", errorText: "boom", toolMetadata: { resultMissing: true } });
  assert.equal(isWebToolResultMissing(failed), false);
  // 真正运行中的 part 没有标记，不能被误判成 unknown。
  assert.equal(isWebToolResultMissing(toolPart()), false);
});

test("ask_question without a result is not a live question form", () => {
  const missingAsk = toolPart({
    toolName: "ask_question",
    toolMetadata: { resultMissing: true },
  });
  assert.equal(isWebLiveAskQuestionToolPart(missingAsk), false);
  assert.equal(isWebLiveAskQuestionToolPart(toolPart({ toolName: "ask_question" })), true);

  // 纯工具消息：结果缺失的 ask_question 只是一条工具记录，可以并入历史工具组。
  const message = { id: "msg-ask", role: "assistant", parts: [missingAsk] };
  assert.equal(isPureToolMessage(message), true);
  const grouped = groupWebAssistantParts(message.parts, message);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "tool-single");
  assert.equal(grouped[0].part.toolName, "ask_question");

  // 活提问仍然是边界：独立渲染、不并入工具组。
  const livePart = toolPart({ toolName: "ask_question" });
  const liveMessage = { id: "msg-live", role: "assistant", parts: [livePart] };
  assert.equal(isPureToolMessage(liveMessage), false);
});

test("turn display folds an unknown ask_question instead of pinning it as a live ask", () => {
  const missingAsk = toolPart({ toolName: "ask_question", toolMetadata: { resultMissing: true } });
  const unknownDisplay = buildWebTurnDisplay(
    [{ id: "msg-1", role: "assistant", parts: [missingAsk] }],
    { streaming: false },
  );
  assert.deepEqual(
    Array.from(unknownDisplay.persistentSteps, (step) => step.kind),
    [],
    "an unknown ask_question must not become a persistent live ask card",
  );
  assert.deepEqual(Array.from(unknownDisplay.foldSteps, (step) => step.kind), ["tools"]);

  const liveAsk = toolPart({ toolName: "ask_question" });
  const liveDisplay = buildWebTurnDisplay(
    [{ id: "msg-2", role: "assistant", parts: [liveAsk] }],
    { streaming: true },
  );
  assert.deepEqual(Array.from(liveDisplay.persistentSteps, (step) => step.kind), ["ask-tool"]);
});

test("unknown tool parts still group with adjacent tools", () => {
  const parts = [
    toolPart({ toolCallId: "call-a", toolMetadata: { resultMissing: true } }),
    toolPart({ toolCallId: "call-b", state: "output-available", output: "ok" }),
  ];
  assert.equal(isWebToolPart(parts[0]), true);
  const grouped = groupWebAssistantParts(parts, { id: "msg-3", role: "assistant", parts });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "tool-group");
  assert.equal(grouped[0].parts.length, 2);
});
