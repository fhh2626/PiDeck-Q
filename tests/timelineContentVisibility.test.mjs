import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertConsumes } from "./_densityRecipe.mjs";

// 长会话渲染治理契约（2026-08 调整）：
// 移除 content-visibility 估算高度（旧方案对屏外行用 240px 估算，展开/折叠工具卡
// 或思考卡时浏览器按估算修正滚动位置，产生屏幕抖动）。
// 替代方案（学 Proma）：靠「总折叠 + 各自折叠」压缩单行 DOM 体积，
// 分页（useMessagePagination / disk 轮次页）继续做窗口治理。

const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");

test("message-list no longer estimates offscreen row height via content-visibility", () => {
  // 旧估算高度是展开/折叠抖动的根源：不再对 message-list 行应用 content-visibility 工具类
  assert.doesNotMatch(timeline, /message-list[^\n]*\[content-visibility:auto\]/);
  assert.doesNotMatch(timeline, /message-list[^\n]*contain-intrinsic-size:auto_\d+px/);
});

test("long-session window governance stays via turn-based history loading", () => {
  // 2026-11 轮次模型：100 条分页器已删除，长会话治理改由
  // 「贴底挂载窗口 + 按轮补历史（主进程缓存优先/文件兜底）」承担。
  const controller = readFileSync(
    "src/renderer/src/hooks/useSessionTimelineController.ts",
    "utf8",
  );
  assert.doesNotMatch(controller, /useMessagePagination/);
  assert.match(controller, /RUNTIME_HISTORY_TURN_PAGE_SIZE/);
  assert.match(controller, /beforeEntryId: anchorEntryId/);
});

test("single-turn DOM stays light via default-collapsed process group", () => {
  // 学 Proma：执行过程总折叠默认收起（历史 run 不弹开），单 turn DOM 体积小
  const turnExecution = readFileSync(
    "src/renderer/src/components/session/turn/useTurnExecution.ts",
    "utf8",
  );
  // 历史已完成且有最终回答的轮始终折叠；进行中/中断轮默认折叠（仅设置①开启时展开）
  assert.match(turnExecution, /历史已完成且有最终回答的轮：始终折叠/);
  assert.match(
    turnExecution,
    /if \(opts\.isComplete && !opts\.agentRunning && opts\.hasFinalAnswer\) return false;/,
  );
  // 手动 override 最高优先：上升沿不清 override、不撑开手动折叠过的轮次
  assert.match(turnExecution, /!userOverrideRef\.current/);
  // 完成后 1.5s 自动收起（落在 1~2s 体验区间）
  assert.match(turnExecution, /}, 1500\)/);
});

test("process group uses CollapsibleContent height transition", () => {
  // 总折叠用 Radix CollapsibleContent（自带 height 过渡动画），替代 display:none 突变
  assert.match(turnRow, /<Collapsible/);
  assert.match(turnRow, /<CollapsibleContent/);
});

test("user messages fold long text beyond 8 lines with an expand toggle", () => {
  // 长发送消息默认折叠（line-clamp-8），右下角「展开全文/收起」切换；
  // 溢出检测用 ResizeObserver 对比 scrollHeight/clientHeight（折叠态下测量）。
  const surface = readFileSync(
    "src/renderer/src/components/session/SurfaceComponents.tsx",
    "utf8",
  );
  assert.match(surface, /line-clamp-8/);
  assert.match(surface, /messageExpanded/);
  assert.match(surface, /ResizeObserver/);
  assert.match(surface, /scrollHeight > el\.clientHeight \+ 1/);
  assert.match(surface, /t\("app\.messageExpand"\)/);
  assert.match(surface, /t\("app\.messageCollapse"\)/);
});

test("compaction card matches the thinking-card visual language", () => {
  // 压缩卡片与思考卡片对齐：lucide 图标标签行 + 虚线内容框 + 左下角展开按钮；
  // 不再用 emoji 充当功能图标（AGENTS.md 图标规范）。
  const cards = readFileSync(
    "src/renderer/src/components/session/TimelineEventCards.tsx",
    "utf8",
  );
  assert.doesNotMatch(cards, /📁|📂/);
  assert.match(cards, /Minimize size=\{15\}/);
  // 虚线框 surface 住在共享 recipe（DASHED_SURFACE），组件消费它。
  assertConsumes(cards, "DASHED_SURFACE");
  assert.match(cards, /max-h-\[calc\(var\(--font-size-chat\)\*7\.56\)\]/);
  assert.match(cards, /t\("app\.compactionExpand"\)/);
  // 展开/收起走左下角按钮，不再整卡可点（与思考卡一致）
  assert.doesNotMatch(cards, /className="flex w-full cursor-pointer/);
});

test("content enter animation mounts before paint (no flash-then-fade)", () => {
  // 闪屏根因：useEffect 在 paint 后补挂淡入类，内容先以正常透明度绘制一帧，
  // 再被动画重置到 opacity 0 重新淡入 = 「闪一下再淡入」。
  // 触发必须同步（useLayoutEffect），让内容挂载的第一帧就带动画类。
  const surface = readFileSync(
    "src/renderer/src/components/session/SessionMessageTimeline.tsx",
    "utf8",
  );
  const enterBlock = surface.slice(
    surface.indexOf("会话内容就绪淡入"),
    surface.indexOf("// ── 失败/重试 toast"),
  );
  assert.match(enterBlock, /useLayoutEffect\(\(\) => \{\n\s*if \(prevConversationLoadingRef\.current && !isConversationLoading\) \{\n\s*setContentEntering\(true\);/);
  // 类清理（非视觉关键）留在 useEffect，不在 layout 阶段多一次重渲染
  assert.match(enterBlock, /const timer = window\.setTimeout\(\(\) => setContentEntering\(false\), 180\);/);
});
