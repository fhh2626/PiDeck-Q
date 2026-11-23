import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const runtimeInjector = readFileSync(
  "src/renderer/src/components/session/SessionRuntimeInjector.tsx",
  "utf8",
);
const runtimeUi = readFileSync(
  "src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx",
  "utf8",
);
const composer = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);
const toolCards = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const askResultCard = readFileSync(
  "src/renderer/src/components/session/AskQuestionResultCard.tsx",
  "utf8",
);
const webTimeline = readFileSync(
  "src/renderer/src/web/WebTimeline.tsx",
  "utf8",
);
const webChatApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
const turnRow = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const surfaceComponents = readFileSync(
  "src/renderer/src/components/session/SurfaceComponents.tsx",
  "utf8",
);

test("session UI requests remain generation-bound and render in the timeline footer", () => {
  assert.match(runtimeInjector, /createSessionRuntimeUiResponder\(/);
  assert.match(runtimeInjector, /sessionId: currentSessionId/);
  assert.match(runtimeInjector, /runtimeGeneration: latest\.runtimeGeneration/);
  assert.match(runtimeInjector, /<SessionRuntimeUiOverlay/);
  assert.match(runtimeUi, /ask-inline-bar(?:\s+ask-inline-bar--active)?/);  // Ask 继续使用稳定的布局锚点类
  assert.match(runtimeUi, /ApprovalCard/);
  assert.doesNotMatch(runtimeUi, /className="modal-backdrop ask-dialog-backdrop"/);
  assert.doesNotMatch(composer, /runtimeUi/);
  assert.match(timeline, /className="session-runtime-ui mx-auto w-full/);
  assert.doesNotMatch(timeline, /session-runtime-ui sticky bottom-0/);
  // 已完成 ask_question 渲染为常驻 AskQuestionResultCard（批量逐题展示）；
  // 普通 ToolCard 只保留 running / 损坏 ask 的图标与副标题（askCard.question）。
  assert.match(askResultCard, /result\.questions/);
  assert.match(askResultCard, /AskQuestionResultCard/);
  assert.match(toolCards, /isAskCard/);
  // Web 端复用 SessionRuntimeUiOverlay 作为 pending 卡，并通过 props 接线。
  assert.match(webTimeline, /<SessionRuntimeUiOverlay/);
  assert.match(webChatApp, /pendingUiRequest=/);
  assert.match(webChatApp, /onRespondUi=/);
  assert.doesNotMatch(webTimeline, /function WebAskCard\(/);
});

test("message mutation commands in SessionRuntimeInjector bind the pane's live or saved-history target", () => {
  assert.match(runtimeInjector, /messageCommandTarget = runtime\.messageCommandTarget/);
  assert.match(runtimeInjector, /canDispatchMessageMutation/);
  assert.match(runtimeInjector, /latestMessageServicesRef\.current\.deleteMessage\?\.\(\s*messageCommandTarget,\s*messageId\s*\)/);
  assert.match(runtimeInjector, /latestMessageServicesRef\.current\.editMessage\?\.\(\s*messageCommandTarget,\s*messageId,\s*newText\s*\)/);
  assert.match(runtimeInjector, /latestMessageServicesRef\.current\.resendUserMessage\?\.\(\s*messageCommandTarget,\s*message\s*\)/);
  assert.match(runtimeInjector, /latestMessageServicesRef\.current\.forkFromUserMessage\?\.\(\s*messageCommandTarget,\s*message\s*\)/);
  // 以上 4 条改为 latest-ref 调用：App 每次渲染重建 services.* 回调，直接依赖引用会让
  // messageActions 每帧换新，TurnRow 按引用比较回调时在流式期间整列重渲染。
  assert.doesNotMatch(runtimeInjector, /onDeleteMessage=\{canMutateActiveMessages \? services\.deleteMessage : undefined\}/);
});

test("edit save dispatches captured callback and never gates on the current onEditMessage prop", () => {
  // 保存路径必须走 useTimelineMessageEdit 或 trackedEditSubmit，
  // 不得用当前 props.onEditMessage 拦截保存：runtime 消失时该 prop 为 undefined，
  // 会把已打开的编辑框保存变成静默无效（无 toast、编辑框永远开着）。
  for (const [name, source] of [["TurnRow", turnRow], ["SurfaceComponents", surfaceComponents]]) {
    assert.match(source, /(?:trackedEditSubmit\.current\.submit\(|timelineEdit\.saveEdit\(\))/, `${name} save must dispatch via trackedEditSubmit or timelineEdit`);
    assert.doesNotMatch(source, /if \(props\.onEditMessage &&[\s\S]{0,200}(?:trackedEditSubmit\.current\.submit\(|timelineEdit\.saveEdit\(\))/, `${name} save must not gate on current props.onEditMessage`);
  }
  // 进入编辑必须捕获当次回调（绑定当时 target）
  assert.match(turnRow, /(?:trackedEditSubmit\.current\.begin\(props\.onEditMessage\)|timelineEdit\.beginEdit\(\))/);
  assert.match(surfaceComponents, /(?:trackedEditSubmit\.current\.begin\(props\.onEditMessage\)|timelineEdit\.beginEdit\(\))/);
});
