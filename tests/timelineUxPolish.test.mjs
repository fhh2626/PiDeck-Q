import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolCard = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const turnExecution = readFileSync(
  "src/renderer/src/components/session/turn/useTurnExecution.ts",
  "utf8",
);
const controller = readFileSync(
  "src/renderer/src/hooks/useSessionTimelineController.ts",
  "utf8",
);
const scroller = readFileSync(
  "src/renderer/src/components/agents/message-scroller.tsx",
  "utf8",
);
const turnRow = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);

test("tool card name uses medium weight like process summary, not bold 650", () => {
  assert.match(
    toolCard,
    /className="shrink-0 text-caption font-medium lowercase text-text-secondary"/,
  );
  assert.doesNotMatch(toolCard, /font-\[650\]/);
  // ToolActivityCard 也不再用 <strong> 加粗
  assert.doesNotMatch(toolCard, /tool-activity-copy>\s*<strong>/);
  assert.match(toolCard, /tool-activity-name/);
});

test("auto-collapse process waits 1.5s after agent stops (not merely endedAt)", () => {
  assert.match(turnExecution, /}, 1500\)/);
  assert.match(turnExecution, /1\.5s 后收起/);
  // 收起只改折叠态，不再回调滚动（对准最终回答会解锁跟底并点亮回底按钮）
  assert.doesNotMatch(turnExecution, /autoCollapseTick/);
  // 以 agentRunning 停转为准，避免流式中 endedAt>0 误触发收起
  assert.match(turnExecution, /if \(opts\.agentRunning \|\| atomState\.userOverride\) return;/);
  assert.match(turnExecution, /setStepsVisibleFromUser/);
});

test("scrollToBottom uses stick-to-bottom spring via scrollerScrollApiRef", () => {
  assert.match(controller, /scrollerScrollApiRef/);
  assert.match(controller, /api\.scrollToBottom\(\{ animation \}\)/);
  // 不再把回底按钮绑成裸 timeline.scrollTo 作为主路径（兜底除外）
  assert.match(scroller, /scrollApiRef/);
  assert.match(scroller, /MessageScrollerScrollApi/);
  assert.match(timeline, /scrollApiRef=\{controller\.scrollerScrollApiRef\}/);
});

test("auto-collapse does not steal follow or show the jump-to-bottom button", () => {
  // 最终回答标记仍在（折叠后阅读用），但不再接线滚动对准
  assert.match(turnRow, /data-final-answer=\{run\.id\}/);
  assert.doesNotMatch(controller, /scrollFinalAnswerIntoView/);
  assert.doesNotMatch(turnRow, /onProcessAutoCollapsed/);
  assert.doesNotMatch(timeline, /onProcessAutoCollapsed/);
  assert.doesNotMatch(controller, /clientHeight \* 0\.35/);
  // isLatestRun（自动收起）与 isLastAgentRun 在虚拟化行中计算
  const rowSource = readFileSync("src/renderer/src/components/session/timeline/TimelineMessageRow.tsx", "utf8");
  assert.match(rowSource, /isLatestRun = index === totalItems - 1/);
  assert.match(timeline, /isLastAgentRun=\{isLastAgentRun\}/);
  assert.match(timeline, /lastAgentRunIndex/);
});

test("followOutput re-lock uses spring when far from bottom", () => {
  // 避免回底按钮 setAutoScroll(true) 后被 layout instant 掐死弹簧
  assert.match(
    scroller,
    /reduce \|\| distance <= followThreshold \? "instant" : "smooth"/,
  );
});
