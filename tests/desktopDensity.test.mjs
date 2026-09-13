import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertConsumes, getRecipe } from "./_densityRecipe.mjs";

/**
 * 桌面密度契约测试：锁定 24/28/32 三档节奏，防止后续改动把行高/间距打散。
 *
 * 全局密度标尺：
 *   - 辅助/meta 行：~24px
 *   - 导航/列表行：~28px
 *   - 设置表单控件：~32px
 *   - 垂直节奏：4px 常规、0–2px 同组、8px 分区、12px 主内容 padding、4–8px 紧凑卡片 padding
 */

function read(rel) {
  return readFileSync(`src/renderer/src/${rel}`, "utf8");
}

// ── 时间线 Marker ────────────────────────────────────────────────────────────
test("TimelineMarker uses gap-2 and pb-0.5 (2px step gap)", () => {
  const src = read("components/session/TimelineMarker.tsx");
  assert.match(src, /timeline-marker-row/, "marker row class not found");
  assert.doesNotMatch(src, /gap-2\.5/, "marker row should not use gap-2.5");
  assert.match(src, /gap-2\b/, "marker row should use gap-2");
  assert.doesNotMatch(
    src,
    /timeline-marker-content[^"]*pb-2(?!\.)/,
    "marker content should not use pb-2",
  );
  assert.match(src, /timeline-marker-content[^"]*pb-0\.5\b/, "marker content should use pb-0.5 (2px)");
  assert.doesNotMatch(src, /timeline-marker-content[^"]*pb-1\b/, "marker content must not stay at pb-1");
});

// ── Thinking / Compaction 卡片 ──────────────────────────────────────────────
test("Thinking/Compaction consume the shared card recipes (body px-2 py-0.5)", () => {
  const src = read("components/session/TimelineEventCards.tsx");

  // 值住在共享 recipe（lib/density.ts），组件只消费常量。
  assert.equal(getRecipe("CARD_BODY_PADDING"), "px-2 py-0.5", "card body recipe changed");
  assert.equal(getRecipe("CARD_PREVIEW_PADDING"), "px-2 py-0.5 font-mono text-caption text-text-tertiary");

  assertConsumes(src, "CARD_BODY_PADDING");
  assertConsumes(src, "CARD_PREVIEW_PADDING");

  // 旧的大 padding 字面量不再散落在组件里。
  assert.doesNotMatch(src, /markdown-body px-3 pt-2 pb-1/, "expanded body must not revert to px-3 pt-2 pb-1");
  assert.doesNotMatch(src, /px-3 pt-2 pb-1 font-mono/, "collapsed preview must not revert to px-3 pt-2 pb-1");

  // 收起入口 footer
  assert.doesNotMatch(src, /flex px-2 pb-1\.5/, "collapse footer should not use px-2 pb-1.5");
  assert.match(src, /flex px-1\.5 pb-1/, "collapse footer should use px-1.5 pb-1");
});

test("Thinking trigger header consumes the shared THINKING_HEADER recipe (gap-1.5)", () => {
  const src = read("components/session/TimelineEventCards.tsx");
  const header = getRecipe("THINKING_HEADER");
  assert.match(header, /gap-1\.5/, "shared header recipe should use gap-1.5");
  assert.match(header, /min-h-6/, "shared header recipe should stay 24px");
  assert.match(header, /px-1 py-0\.5/, "shared header recipe should use 4px x 2px padding");
  assertConsumes(src, "THINKING_HEADER");
});

test("WebThinkingBlock stays in sync with desktop Thinking (shared recipes)", () => {
  const src = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
  const block = src.slice(
    src.indexOf("export const WebThinkingBlock"),
    src.indexOf("type WebToolPart"),
  );
  assert.ok(block.length > 0, "WebThinkingBlock source not found");
  // Web 与桌面消费同一份 recipe，值天然一致；只断言消费关系 + 旧大 padding 不回归。
  assertConsumes(src, "THINKING_HEADER");
  assertConsumes(src, "CARD_BODY_PADDING");
  assertConsumes(src, "CARD_PREVIEW_PADDING");
  assert.ok(block.includes("THINKING_HEADER"), "web thinking block renders the shared header");
  assert.doesNotMatch(block, /markdown-body px-3 pt-2 pb-1/, "Web expanded body must not revert");
  assert.doesNotMatch(block, /px-3 pt-2 pb-1 font-mono/, "Web collapsed preview must not revert");
  assert.match(block, /flex px-1\.5 pb-1/, "Web collapse footer should use px-1.5 pb-1");
});

// ── 文件修改列表 ─────────────────────────────────────────────────────────────
test("TurnRow keeps exactly two spacing layers (turn-gap + block-gap)", () => {
  const src = read("components/session/turn/TurnRow.tsx");
  const foundation = read("styles/foundation.css");
  // turn 间距只由列表层 --density-turn-gap 负责，不再叠 mb-3/mb-6。
  assert.match(src, /turn-row w-full min-w-0 max-w-full/, "turn should not own outer margin");
  assert.doesNotMatch(src, /turn-row mb-3 w-full/, "turn must not keep mb-3");
  assert.doesNotMatch(src, /turn-row mb-6 w-full/, "turn must not stay at mb-6");
  // turn 内部只有一层 block gap（gap-1.5 = 6px）：时间戳→过程→思考/工具→回答。
  assert.match(src, /flex min-w-0 flex-col gap-1\.5/, "turn inner should be a single gap-1.5");
  assert.doesNotMatch(src, /flex min-w-0 flex-col gap-3/, "turn inner should not be gap-3");
  // 时间戳行不再自带 mb-1（交给父级 gap 统一）。
  assert.doesNotMatch(src, /mb-1 inline-flex items-center gap-2 text-muted-foreground/, "timestamp row must not add its own mb");
  // 列表层 turn-gap 走 density token（12px），不是 16px。
  assert.match(foundation, /\.message-list\.message-list > \* \+ \*\s*\{\s*margin-top:\s*var\(--density-turn-gap/, "message-list gap should consume --density-turn-gap");
  assert.match(
    foundation,
    /\.message-timeline-host \.message-list\.message-list > \.responding-indicator \{\s*margin-top:\s*var\(--space-1\);/
    ,
    "desktop responding indicator should sit 4px below the previous turn",
  );
  assert.match(
    foundation,
    /\.message-timeline-host \.message-timeline \{\s*padding-block: 12px 8px;/
    ,
    "desktop timeline padding override should stay on the native host",
  );
});

test("execution process details sit 6px below the toggle (not 12px)", () => {
  const css = read("styles/timeline.css");
  assert.match(
    css,
    /\.execution-summary-details \{[\s\S]*?margin-top:\s*var\(--density-block-gap\)/,
    "process → thinking/tools should use --density-block-gap (6px)",
  );
  assert.doesNotMatch(
    css,
    /\.execution-summary-details \{[\s\S]*?margin-top:\s*var\(--space-3\)/,
    "process details must not stay at --space-3 (12px)",
  );
});

test("Tool expanded content uses 2px/4px/8px (not 4/8/12)", () => {
  const src = read("components/session/ToolCallComponents.tsx");
  assert.match(src, /ml-5 mt-0\.5 mb-1[^"]*pl-2/,
    "tool expanded should be mt-0.5 mb-1 pl-2");
  assert.doesNotMatch(src, /ml-5 mt-1 mb-2[^"]*pl-3/,
    "tool expanded must not stay at mt-1 mb-2 pl-3");
});

test("FileDiff trigger uses min-h-7 py-0.5 gap-1.5 (not min-h-9 py-1 gap-2)", () => {
  const src = read("components/agents/file-diff.tsx");
  const trigger = src.match(/group flex min-h-\d+ w-full[^"]*"/);
  assert.ok(trigger, "FileDiff trigger class not found");
  assert.match(trigger[0], /min-h-7/, "trigger should be min-h-7");
  assert.doesNotMatch(trigger[0], /min-h-9/, "trigger should not be min-h-9");
  assert.match(trigger[0], /py-0\.5/, "trigger should use py-0.5");
  assert.match(trigger[0], /gap-1\.5/, "trigger should use gap-1.5");

  // 展开态 diff 容器
  assert.match(src, /pl-5 pt-1/, "expanded diff should use pl-5 pt-1");
  assert.doesNotMatch(src, /pl-6 pt-1\.5/, "expanded diff should not use pl-6 pt-1.5");
  assert.match(src, /rounded-md bg-muted\/80/, "diff container should be rounded-md");
});

test("TurnFileChanges uses mb-1 gap-0 size-6 (not mb-1.5 gap-0.5 size-7)", () => {
  const src = read("components/session/turn/TurnFileChanges.tsx");
  assert.match(src, /mb-1 flex items-center/, "title should use mb-1");
  assert.doesNotMatch(src, /mb-1\.5 flex items-center/, "title should not use mb-1.5");
  assert.match(src, /flex flex-col gap-0[\s"]/, "file list should use gap-0");
  assert.doesNotMatch(src, /flex flex-col gap-0\.5/, "file list should not use gap-0.5");
  assert.match(src, /size-6 shrink-0/, "open diff button should be size-6");
  assert.doesNotMatch(src, /size-7 shrink-0/, "open diff button should not be size-7");
});

// ── 设置共享布局 ─────────────────────────────────────────────────────────────
test("SettingRow uses two-layer gap (normal gap-x-4 gap-y-0 / stacked gap-y-1)", () => {
  const src = read("components/app/settings/SettingRows.tsx");
  // display:grid 必须是独立 class：grid-cols / gap-x 不会自己带 display。
  assert.match(src, /"grid border-t border-border-subtle\/60 px-2 py-0\.5 first:border-t-0"/, "SettingRow must set display:grid and px-2");
  assert.match(src, /min-h-9 grid-cols/, "SettingRow normal should use min-h-9");
  assert.doesNotMatch(src, /min-h-\[54px\]/, "SettingRow should not use min-h-[54px]");
  // 两层 gap：normal 只走横向 16px（gap-x-4），纵向 0；stacked 单列走 4px 纵向。
  assert.match(src, /gap-x-4 gap-y-0 items-center/, "SettingRow normal should use gap-x-4 gap-y-0");
  assert.match(src, /grid-cols-1 gap-y-1 items-start/, "SettingRow stacked should use gap-y-1");
  assert.doesNotMatch(src, /gap-6 border-t/, "SettingRow should not use gap-6");
  assert.match(src, /py-0\.5 first:border-t-0/, "SettingRow should use py-0.5");
  assert.doesNotMatch(src, /py-1 first:border-t-0/, "SettingRow should not use py-1");
  assert.doesNotMatch(src, /py-1\.5 first:border-t-0/, "SettingRow should not use py-1.5");
  assert.match(src, /leading-normal/, "description should use leading-normal");
});

test("SettingBox is flat (border-y, transparent, no rounded card)", () => {
  const src = read("components/app/settings/SettingRows.tsx");
  // Density Contract 去 Card 化：上下分隔线 + 透明底，不再圆角卡片。
  assert.match(src, /border-y border-border-subtle\/60 bg-transparent px-0\.5/, "SettingBox should be flat with border-y");
  assert.doesNotMatch(src, /rounded-md border border-border-subtle\/70 bg-bg-muted\/30/, "SettingBox should not be a rounded muted card");
});

test("SettingsSection uses mt-2 pt-2 pb-1 (not mt-4 pt-4 pb-2)", () => {
  const src = read("components/app/settings/SettingsStorageTab.tsx");
  assert.match(src, /mt-2 border-t border-border-subtle pt-2/, "divided section should use mt-2 pt-2");
  assert.doesNotMatch(src, /pt-4/, "divided section should not use pt-4");
  assert.match(src, /mt-2 first:mt-0/, "normal section should use mt-2");
  assert.doesNotMatch(src, /mt-4 first:mt-0/, "normal section should not use mt-4");
  assert.match(src, /settings-section-header pb-1/, "section header should use pb-1");
  assert.doesNotMatch(src, /settings-section-header pb-2/, "section header should not use pb-2");
});

// ── 设置面板 CSS ─────────────────────────────────────────────────────────────
test(".settings-panel padding uses --space-3 (12px, not --space-4 / 16px)", () => {
  const css = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
  const panelBlock = css.match(/\.settings-panel\s*\{[^}]*\}/);
  assert.ok(panelBlock, ".settings-panel rule not found");
  assert.match(panelBlock[0], /padding:\s*var\(--space-3\)/, "should use --space-3");
  assert.doesNotMatch(panelBlock[0], /padding:\s*var\(--space-4\)/, "should not use --space-4");
});

// ── 设置左导航 ──────────────────────────────────────────────────────────────
test("SettingsModal nav uses h-7 gap-1 p-1.5 (not h-8 gap-2.5 p-2.5)", () => {
  const src = read("components/app/SettingsModal.tsx");
  const tabsList = src.match(/settings-tabs[^"]*"/);
  assert.ok(tabsList, "SettingsModal TabsList not found");
  assert.match(tabsList[0], /gap-1\b/, "TabsList should use gap-1");
  assert.doesNotMatch(tabsList[0], /gap-2\.5/, "TabsList should not use gap-2.5");
  assert.match(tabsList[0], /p-1\.5\b/, "TabsList should use p-1.5");
  assert.doesNotMatch(tabsList[0], /p-2\.5/, "TabsList should not use p-2.5");

  const tabsTrigger = src.match(/config-nav-btn h-7 justify-start gap-1\.5 px-2/);
  assert.ok(tabsTrigger, "SettingsModal TabsTrigger should be h-7 gap-1.5 px-2");
  assert.doesNotMatch(src, /config-nav-btn h-8/, "TabsTrigger should not be h-8");
});

test("ConfigModal sidebar uses h-7 gap-1 p-1.5 (not h-8 gap-2.5 p-2.5)", () => {
  const src = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
  const sidebar = src.match(/config-sidebar[^"]*"/);
  assert.ok(sidebar, "ConfigModal sidebar not found");
  assert.match(sidebar[0], /gap-1\b/, "sidebar should use gap-1");
  assert.doesNotMatch(sidebar[0], /gap-2\.5/, "sidebar should not use gap-2.5");
  assert.match(sidebar[0], /p-1\.5\b/, "sidebar should use p-1.5");
  assert.doesNotMatch(sidebar[0], /p-2\.5/, "sidebar should not use p-2.5");

  const triggers = src.match(/config-nav-btn h-7/g);
  assert.ok(triggers && triggers.length >= 3, "ConfigModal should have at least 3 h-7 nav triggers");
  assert.doesNotMatch(src, /config-nav-btn h-8/, "ConfigModal triggers should not be h-8");

  // Header density：主界面与错误兑底一致（px-3 py-2），错误态不回退到大 Dialog header。
  assert.doesNotMatch(src, /px-4 py-2\.5/, "ConfigModal header must not stay at px-4 py-2.5");
  assert.doesNotMatch(src, /px-4 py-3/, "ConfigModal error fallback header must not use px-4 py-3");
});

// ── 侧边栏资源行 ─────────────────────────────────────────────────────────────
test("sidebar body uses gap-1 (not gap-2)", () => {
  const src = read("components/sidebar/SidebarContent.tsx");
  assert.match(src, /sidebar-body[^"]*gap-1\b/, "sidebar-body should use gap-1");
  assert.doesNotMatch(src, /sidebar-body[^"]*gap-2\b/, "sidebar-body should not use gap-2");
});

test("project group spacing uses mb-0.5 space-y-px (2px between projects)", () => {
  const src = read("components/sidebar/ProjectTree.tsx");
  assert.match(src, /project-group mb-0\.5\b/, "project group should use mb-0.5");
  assert.doesNotMatch(src, /project-group mb-1\b/, "project group should not stay at mb-1");
  assert.match(src, /space-y-px/, "expanded content should use space-y-px");
});

test("Chat section uses mb-0.5 (2px to next project, not mb-2/mb-4)", () => {
  const src = read("components/sidebar/ProjectTree.tsx");
  assert.match(src, /section key=\{project\.id\} className="mb-0\.5"/, "Chat section should use mb-0.5");
  assert.doesNotMatch(src, /section[^>]*mb-4/, "Chat section should not use mb-4");
  assert.doesNotMatch(src, /section key=\{project\.id\} className="mb-2"/, "Chat section should not stay at mb-2");
});

test("Worktree row uses px-0.5 py-0 (not p-0.5, which would exceed 28px)", () => {
  const src = read("components/sidebar/WorktreeTree.tsx");
  const workspaceRow = src.match(/workspaceRowClass\s*=\s*\n\s*"([^"]*)"/);
  assert.ok(workspaceRow, "workspaceRowClass constant not found");
  assert.match(workspaceRow[1], /px-0\.5/, "worktree row should keep 2px horizontal padding");
  assert.match(workspaceRow[1], /py-0/, "worktree row should use py-0 so height stays 28px");
  assert.doesNotMatch(workspaceRow[1], /\bp-0\.5\b/, "worktree row should not use p-0.5");
});

// ── 设置 wrapper CSS：外围旧值不允许回潮 ────────────────────────────────────────
test("DevTab section boundaries never stack divider + SettingRow border", () => {
  const src = read("components/app/settings/DevTab.tsx");
  // 一个 section boundary = 一条 border：manual divider 后不允许再出现 SettingRow
  // 自带的 border-t（运行参数区已改为 wrapper border-t + first:border-t-0）。
  const dividerLines = src
    .split("\n")
    .map((line, i) => (line.includes("my-2 border-0 border-t") ? i : -1))
    .filter((i) => i >= 0);
  // 手写 divider 只允许出现在「下一行也是手写 divider 或注释/纯文本」的场景；
  // 简化约束：DevTab 禁止再出现 manual divider（现有 boundary 已全部迁到 wrapper border-t）。
  assert.equal(
    dividerLines.length,
    0,
    `DevTab must not use manual dividers (found at lines ${dividerLines.map((i) => i + 1).join(", ")}); use a wrapper border-t + first:border-t-0 instead`,
  );
  // 锁住运行参数 wrapper：自带 border + 8px spacing，首行命中 first:border-t-0。
  assert.match(
    src,
    /运行参数[\s\S]*?<div className="mt-2 border-t border-border-subtle pt-2">[\s\S]*?<SettingRow /,
    "runtime section should own the boundary border (no adjacent SettingRow border)",
  );
});

test("Pi settings wrapper CSS stays on the 2/4/6/8px rhythm", () => {
  const css = read("styles/surfaces.css");
  const pick = (sel) => {
    const m = css.match(new RegExp("\\." + sel + "\\s*\\{[^}]*\\}"));
    assert.ok(m, "." + sel + " rule not found");
    return m[0];
  };
  const sourceBlock = pick("setting-pi-source-block");
  assert.match(sourceBlock, /margin:\s*0;/, "setting-pi-source-block should have margin 0");
  assert.doesNotMatch(sourceBlock, /margin:\s*6px/, "setting-pi-source-block must not use 6px margin");

  const wsl = pick("setting-pi-wsl-config");
  assert.doesNotMatch(wsl, /padding:\s*10px 12px/, "setting-pi-wsl-config must not use 10px 12px padding");
  assert.match(wsl, /padding:\s*6px 8px;/, "setting-pi-wsl-config should use 6px 8px padding");
  assert.match(wsl, /border-radius:\s*var\(--radius-sm\);/, "setting-pi-wsl-config should use radius-sm");

  const fields = pick("setting-wsl-fields");
  assert.match(fields, /gap:\s*4px;/, "setting-wsl-fields should use 4px gap");
  assert.doesNotMatch(fields, /margin-top:\s*8px/, "setting-wsl-fields must not use margin-top 8px");

  const actions = pick("setting-pi-path-actions");
  assert.match(actions, /gap:\s*4px;/, "setting-pi-path-actions should use 4px gap");
  assert.doesNotMatch(actions, /margin-top:\s*8px/, "setting-pi-path-actions must not use margin-top 8px");

  const proxy = pick("setting-proxy-panel");
  assert.match(proxy, /margin:\s*2px 0 4px;/, "setting-proxy-panel should use 2px 0 4px");
});

// ── Pi Config 设置页：separator 列表 ────────────────────────────────────────
test("Pi Config SettingsTab is a separator list (no gap-2, no per-row card borders)", () => {
  const src = read("config/SettingsTab.tsx");
  assert.match(src, /flex flex-col gap-0/, "settings list container should use gap-0");
  assert.doesNotMatch(src, /flex flex-col gap-2/, "settings list container must not use gap-2");
  // ConfigSettingRow 是共享行组件：separator 风格 + 28px 行高 + 180px label 列。
  assert.match(src, /function ConfigSettingRow/, "ConfigSettingRow helper must exist");
  assert.match(
    src,
    /grid min-h-9 grid-cols-\[180px_minmax\(0,1fr\)\] items-center gap-x-4 border-t border-border-subtle\/60 px-2 py-0\.5 first:border-t-0/,
    "ConfigSettingRow should use the separator row class",
  );
  // 普通 row 不允许回到四边框卡片；Input 的边框不在此约束内。
  const rowCards = src.match(/flex items-center gap-3\.5 rounded-sm border border-border-subtle px-2 py-0\.5/g) || [];
  assert.equal(rowCards.length, 0, "config rows must not use rounded card borders: " + rowCards.length);
  // 专用 UI 已覆盖 compaction（开关 + 两个 token 数），不允许再进 generic entries 重复渲染。
  assert.match(src, /key !== "compaction"/, "dedicated compaction config must not also render as a generic row");
});

// ── 二级 UI：SkillHub / Outline / Codex import ────────────────────────────────
test("SkillHub panel and cards use the compact card rhythm", () => {
  const css = read("styles/surfaces.css");
  const pick = (sel) => {
    const m = css.match(new RegExp("\\." + sel + "\\s*\\{[^}]*\\}"));
    assert.ok(m, "." + sel + " rule not found");
    return m[0];
  };
  const panel = pick("skillhub-panel");
  assert.match(panel, /padding:\s*var\(--density-panel-padding\)/, "skillhub-panel should use --density-panel-padding");
  assert.doesNotMatch(panel, /padding:\s*var\(--space-4\)/, "skillhub-panel must not use --space-4 padding");
  assert.match(panel, /gap:\s*8px;/, "skillhub-panel should use 8px gap");

  const card = pick("skillhub-card");
  assert.doesNotMatch(card, /padding:\s*10px 12px/, "skillhub-card must not use 10px 12px padding");
  assert.match(card, /padding:\s*6px 8px;/, "skillhub-card should use 6px 8px padding");
  assert.match(card, /border-radius:\s*var\(--radius-sm\);/, "skillhub-card should use radius-sm");

  const results = pick("skillhub-results");
  assert.match(results, /gap:\s*4px;/, "skillhub-results should use 4px gap");

  const input = css.match(/\.skillhub-search-input-wrap input\s*\{[^}]*\}/);
  assert.ok(input, "skillhub input rule not found");
  assert.match(input[0], /height:\s*var\(--density-control-height\)/, "skillhub input should use 32px control height");
  assert.doesNotMatch(input[0], /height:\s*34px/, "skillhub input must not stay at 34px");
});

test("Conversation outline rows look like an IDE navigation list", () => {
  const css = read("styles/surfaces.css");
  const btn = css.match(/\.conversation-outline button\s*\{[^}]*\}/);
  assert.ok(btn, ".conversation-outline button rule not found");
  assert.match(btn[0], /min-height:\s*28px;/, "outline row should be 28px");
  assert.doesNotMatch(btn[0], /padding:\s*7px 8px/, "outline row must not use 7px 8px padding");
  assert.doesNotMatch(btn[0], /border-radius:\s*var\(--radius-lg\)/, "outline row must not use radius-lg");
  assert.match(btn[0], /padding:\s*2px 6px;/, "outline row should use 2px 6px padding");

  const expand = css.match(/\.outline-expand\s*\{[^}]*\}/);
  assert.ok(expand, ".outline-expand rule not found");
  assert.match(expand[0], /min-height:\s*28px;/, "outline expand should be 28px");
  assert.match(expand[0], /padding:\s*2px 6px;/, "outline expand should use 2px 6px padding");
});

test("Codex import list is compact (no 8px list gap, no radius-lg rows)", () => {
  const css = read("styles/surfaces.css");
  const list = css.match(/\.codex-session-list\s*\{[^}]*\}/);
  assert.ok(list, ".codex-session-list rule not found");
  assert.match(list[0], /gap:\s*4px;/, "codex-session-list should use 4px gap");
  assert.doesNotMatch(list[0], /gap:\s*8px/, "codex-session-list must not use 8px gap");

  const group = css.match(/\.codex-session-group\s*\{[^}]*\}/);
  assert.ok(group, ".codex-session-group rule not found");
  assert.match(group[0], /gap:\s*4px;/, "codex-session-group should use 4px gap");

  const row = css.match(/\.codex-session-row\s*\{[^}]*\}/);
  assert.ok(row, ".codex-session-row rule not found");
  assert.doesNotMatch(row[0], /padding:\s*8px 10px/, "codex-session-row must not use 8px 10px padding");
  assert.match(row[0], /padding:\s*6px 8px;/, "codex-session-row should use 6px 8px padding");
  assert.match(row[0], /border-radius:\s*var\(--radius-sm\);/, "codex-session-row should use radius-sm");
});
