import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const buildSource = readFileSync(
  "src/renderer/src/components/session/timeline/buildTurnDisplay.ts",
  "utf8",
);
const summarySource = readFileSync(
  "src/renderer/src/components/session/timeline/segmentSummary.ts",
  "utf8",
);
const typesSource = readFileSync(
  "src/renderer/src/components/session/timeline/types.ts",
  "utf8",
);
const turnRowSource = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const summaryToggleSource = readFileSync(
  "src/renderer/src/components/session/turn/ProcessSummaryToggle.tsx",
  "utf8",
);

// 单折叠汇总：整轮只出现一个「执行过程」汇总按钮，思考/工具/中间回答共用一个
// run 级折叠开关（stepsVisible），最终回答常驻、永不折叠。
test("TurnRow renders a single process summary toggle plus order-preserving flat display", () => {
  assert.match(turnRowSource, /buildTurnDisplay\(run/);
  // 唯一汇总按钮：只渲染一次（run 开头），不按 process 段循环
  assert.match(turnRowSource, /ProcessSummaryToggle\s*\n\s*summary=\{processSummary\}/);
  assert.match(turnRowSource, /showProcessToggle && \(/);
  // 中间回答/最终回答区分渲染；最终回答走 FinalAnswer（常驻）
  assert.match(turnRowSource, /item\.kind === "interim-answer"/);
  // 中间内容收进执行过程折叠容器（foldableItems），最终回答常驻容器外（finalItems）
  assert.match(turnRowSource, /foldableItems\.map/);
  assert.match(turnRowSource, /persistentItems\.map/);
  // ask-result 渲染为常驻 AskQuestionResultCard（折叠容器外）
  assert.match(turnRowSource, /<AskQuestionResultCard/);
  assert.match(turnRowSource, /item\.kind === "ask-result"/);
  assert.match(turnRowSource, /<FinalAnswer/);
  // 折叠容器用 Radix CollapsibleContent（高度过渡动画），不再 display:none 突变
  assert.match(turnRowSource, /<Collapsible/);
  assert.match(turnRowSource, /<CollapsibleContent/);
  assert.doesNotMatch(turnRowSource, /stepsVisible \? undefined : "none"/);
  // 收起按钮：固定在折叠容器末尾
  assert.match(turnRowSource, /execution-summary-collapse/);
  assert.match(summaryToggleSource, /execution-summary-toggle/);
  assert.match(summaryToggleSource, /activity\.executionToolCount/);
  assert.match(summaryToggleSource, /activity\.executionThinkingCount/);
  assert.match(summaryToggleSource, /activity\.executionInterimCount/);
});

// 扁平展示序列：严格按 run.items 时序，不重排；中间回答 = 非最后一条 assistant 文本。
test("buildTurnDisplay keeps strict order and splits interim/final answers", () => {
  // 最终回答判定：run 收尾条目 + stopReason 协议信号/回退启发式（2026-08 升级，
  // 取代旧的 lastAssistantIndex 锚点——判定矩阵行为由 tests/turnSegments.test.mjs 覆盖）
  assert.match(buildSource, /isRunTail/);
  assert.match(buildSource, /isFinal/);
  assert.match(buildSource, /interim-answer/);
  assert.match(buildSource, /final-answer/);
  // 消息自带 thinking 作为思考步骤插到该回答之前
  assert.match(buildSource, /msg-thinking-/);
  // 空文本消息仍产出 interim 挂载点（Live 通道骨架）
  assert.match(buildSource, /interim-answer/);
  assert.match(buildSource, /if \(!text\) \{/);
  // 工具步骤始终进序列（不依赖 showThinking）
  assert.match(buildSource, /tool-entry/);
  // 思考步骤：已有 thinking-group 始终保留；消息自带 thinking 受 showThinking 控制
  assert.match(buildSource, /pushThinking\(item, false\)/);
  assert.match(buildSource, /respectShowThinking && !showThinking/);
});

test("ask lead-in stays pinned via hasPendingAsk or a following ask_question tool", () => {
  assert.match(buildSource, /hasPendingAsk/);
  assert.match(buildSource, /shouldPinAskLeadIn/);
  assert.match(buildSource, /isAskQuestionToolGroup/);
  assert.match(turnRowSource, /pickActiveAskRequest/);
  // 会话级 pending ask 只能作用于最后一个 agent-run，避免旧轮普通 toolUse 说明被提出来。
  assert.match(turnRowSource, /props\.isLastAgentRun && pickActiveAskRequest/);
  assert.match(buildSource, /resolveAskLeadInPin/);
  assert.match(turnRowSource, /resolveAskLeadInPin/);
  assert.match(turnRowSource, /askLeadInPinnedRef/);
});

// 汇总统计：纯数字（工具/思考/中间回复），折叠态不显示内容预览。
test("segmentSummary counts tools, thinking steps and interim replies without preview text", () => {
  assert.match(summarySource, /toolCount/);
  assert.match(summarySource, /thinkingCount/);
  assert.match(summarySource, /interimCount/);
  assert.match(summarySource, /isEmptySummary/);
  // 折叠按钮纯数字：不引用消息正文
  assert.doesNotMatch(summaryToggleSource, /message\.text/);
  assert.doesNotMatch(summaryToggleSource, /preview/);
});
