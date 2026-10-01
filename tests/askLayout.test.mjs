import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerArea = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const overlay = readFileSync(
  "src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx",
  "utf8",
);
const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const sessionTimeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);

/**
 * 这些是布局回归契约：runtime UI 属于会话时间线的可见交互，不再占用 composer 的
 * flex 高度；输入框仍由 composer 自己完整承载，Ask 也不再创建第二个纵向滚动 owner。
 */
test("composer keeps the editor inside the resizable panel", () => {
  assert.match(composerArea, /className="composer[^\"]*min-h-0[^\"]*overflow-hidden/);
  assert.match(composerArea, /composer-box relative flex min-h-0[^\"]*flex-1/);
  assert.doesNotMatch(composerArea, /runtimeUi/);
  assert.doesNotMatch(composerArea, /AskRegionResizer/);
});

test("ask inline bar uses the reusable BEUI-style ApprovalCard shell", () => {
  assert.match(overlay, /from "\.\.\/ui-shadcn\/approval-card"/);
  assert.match(overlay, /<ApprovalCard[\s\S]*open=/);
  assert.match(overlay, /BatchAskInlineBar/);
});

// 单题提问的正文走 ApprovalCard 的 description：曾被 `truncate` 截成一行，
// Web/手机端长提问只剩半句且无法悬停查看。正文必须完整换行显示（保留换行符），
// 并显式覆盖 Button 基础样式里的 whitespace-nowrap。
test("approval card shows the full question text instead of a single truncated line", () => {
  const approvalCard = readFileSync("src/renderer/src/components/ui-shadcn/approval-card.tsx", "utf8");
  const descriptionLine = approvalCard.split("\n").find((line) => line.includes("{props.description}"));
  assert.ok(descriptionLine, "description must still be rendered");
  assert.doesNotMatch(descriptionLine, /\btruncate\b|line-clamp/);
  assert.match(descriptionLine, /whitespace-pre-wrap/);
  assert.match(descriptionLine, /break-words|overflow-wrap:anywhere/);
});

// 高度常量与 minSize 的具体取值由 composerAutoGrow.test.mjs 的
// 「auto growth does not relax the existing minimum-size constraints」守卫；
// 这里只验证「输入区仍是一个可纵向调整的面板」，即两个文件不重复。
test("composer stays a vertically resizable panel", () => {
  assert.match(sessionView, /COMPOSER_DEFAULT_HEIGHT/);
  // 标签与 prop 允许跨行（终端布局修复后 Group 多了 groupRef，JSX 折行）
  assert.match(sessionView, /<ResizablePanelGroup[\s\S]*?orientation="vertical"/);
  assert.match(sessionView, /id="composer"/);
});

test("ask overlay keeps fold, cancel, batch and resume interactions", () => {
  assert.match(overlay, /cancel = \(\) =>/);
  assert.match(overlay, /method === "batch_ask"/);
  assert.match(overlay, /BatchAskInlineBar/);
  assert.match(overlay, /ask-inline-bar/);
  assert.doesNotMatch(overlay, /ask\.cancelHint/);
});

test("ask is rendered at the bottom of the session timeline", () => {
  assert.match(sessionView, /<SessionSurfaceStage[\s\S]*runtimeUi,/);
  assert.match(sessionTimeline, /className="session-runtime-ui mx-auto w-full/);
  assert.doesNotMatch(sessionTimeline, /session-runtime-ui sticky bottom-0/);
  // 时间线是唯一滚动 owner，Ask 不再嵌套自己的 overflow-y-auto。
  assert.doesNotMatch(overlay, /overflow-y-auto/);
});
