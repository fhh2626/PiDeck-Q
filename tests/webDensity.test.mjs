import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Web 密度契约：Desktop Web 与桌面 App 使用同一套信息密度（24/28/32 节奏）；
 * Mobile Web 只在触控尺寸上放大（≥36px 行 / 搜索），不恢复整套网页大留白。
 *
 * Desktop 与 Mobile 规则不同，因此单独建文件，不并入 desktopDensity.test.mjs。
 */

const webSidebar = readFileSync("src/renderer/src/web/WebSidebar.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
const webCss = readFileSync("src/renderer/src/web/web.css", "utf8");

// ── Desktop：Web Sidebar ────────────────────────────────────────────────────
test("Web project row matches the 28px desktop resource-row shape", () => {
  const row = webSidebar.match(/projectRowClass\s*=\s*\n\t"([^"]*)"/);
  assert.ok(row, "projectRowClass constant not found");
  assert.match(row[1], /min-h-7/, "project row should be 28px (min-h-7)");
  assert.match(row[1], /rounded-md/, "project row should use rounded-md");
  assert.match(row[1], /px-2/, "project row should use px-2");
  assert.match(row[1], /py-0/, "project row should use py-0");
  // 旧的网页卡片密度：36px 高、大圆角、大内边距。
  assert.doesNotMatch(row[1], /min-h-9/, "project row must not be 36px");
  assert.doesNotMatch(row[1], /rounded-lg/, "project row must not use rounded-lg");
  assert.doesNotMatch(row[1], /px-3 py-1/, "project row must not use px-3 py-1");
});

test("Web project row usage no longer doubles the height with min-h-8", () => {
  assert.doesNotMatch(
    webSidebar,
    /cn\(projectRowClass,\s*"flex min-h-8/,
    "project row usage must not add min-h-8 on top of min-h-7",
  );
  assert.match(
    webSidebar,
    /cn\(projectRowClass,\s*"min-w-0 flex-1"\)/,
    "project row usage should only add width classes",
  );
});

test("Web project children use tree spacing (4px to list, 1px between rows)", () => {
  assert.match(
    webSidebar,
    /project-children mt-1 flex flex-col gap-px px-1 pb-1/,
    "children should use mt-1 gap-px",
  );
  assert.doesNotMatch(
    webSidebar,
    /project-children mt-2/,
    "children should not use the old 8px top gap",
  );
  assert.doesNotMatch(
    webSidebar,
    /project-children[^"]*gap-2/,
    "children rows must not be 8px apart (card spacing)",
  );
});

test("Web project group spacing distinguishes Chat section (8px) from projects (4px)", () => {
  assert.match(
    webSidebar,
    /cn\("project-group", project\.kind === "chat" \? "mb-2" : "mb-1"\)/,
    "Chat group should be mb-2, normal projects mb-1",
  );
  assert.doesNotMatch(
    webSidebar,
    /project-group mb-2(?!\s*")/,
    "no unconditional mb-2 on all project groups",
  );
});

test("Web sidebar body uses gap-1", () => {
  assert.match(
    webSidebar,
    /sidebar-body flex min-h-0 flex-1 flex-col gap-1 px-2 py-1/,
    "sidebar body should use gap-1",
  );
  assert.doesNotMatch(
    webSidebar,
    /sidebar-body[^"]*gap-2/,
    "sidebar body should not use gap-2",
  );
});

// ── Desktop：Web Search ─────────────────────────────────────────────────────
test("Web desktop search is 32px (input h-8, add button size-8)", () => {
  assert.match(webSidebar, /className="h-8 pl-7"/, "search input should be h-8");
  assert.doesNotMatch(webSidebar, /className="h-9 pl-8"/, "search input must not be 36px");
  assert.match(
    webSidebar,
    /size-8 shrink-0"\s*\n\s*onClick=\{\(\) => setAddingProject/,
    "add project button should be size-8",
  );
  assert.doesNotMatch(
    webSidebar,
    /size-9 shrink-0/,
    "add project button must not be 36px",
  );
  // 图标随 32px 输入框内移，保持视觉居中。
  assert.match(webSidebar, /top-1\/2 left-2 size-3\.5/, "search icon should sit at left-2");
  assert.doesNotMatch(webSidebar, /left-2\.5 size-3\.5/, "search icon must not stay at left-2.5");
});

// ── Desktop：Web Timeline ───────────────────────────────────────────────────
test("Web timeline uses 6px message gap and 12px/10px padding (desktop density)", () => {
  assert.match(
    webTimeline,
    /message-list flex flex-col gap-1\.5 px-3 py-2\.5/,
    "message list should use gap-1.5 px-3 py-2.5 (6px gap, 12px x / 10px y)",
  );
  assert.doesNotMatch(
    webTimeline,
    /message-list[^"]*gap-2/,
    "message list should not use 8px gaps",
  );
  assert.doesNotMatch(
    webTimeline,
    /message-list[^"]*p-4/,
    "message list should not use 16px outer padding",
  );
});

test("Web pending UI request keeps 8px top gap (not 12px)", () => {
  assert.match(webTimeline, /className="mt-2 w-full"/, "pending ask should use mt-2");
  assert.doesNotMatch(webTimeline, /className="mt-3 w-full"/, "pending ask should not use mt-3");
});

test("Web diagnostic error card uses 8px padding (not 12px)", () => {
  assert.match(
    webTimeline,
    /diagnostic-card tone-error p-2/,
    "diagnostic card should use p-2",
  );
  assert.doesNotMatch(
    webTimeline,
    /diagnostic-card tone-error p-3/,
    "diagnostic card should not use p-3",
  );
});

// ── Mobile：触控尺寸必须保留 ─────────────────────────────────────────────────
test("mobile web media query keeps 36px touch targets", () => {
  // 拿出 @media (max-width: 900px) 区块：桌面密度调整不允许顺手压掉手机触控尺寸。
  const media = webCss.match(/@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}\n/);
  assert.ok(media, "max-width 900px media query not found");
  const mobile = media[1];

  assert.match(
    mobile,
    /\.session-row\s*\{[^}]*min-height:\s*36px/,
    "mobile session rows must stay ≥36px",
  );
  assert.match(
    mobile,
    /\.project-row > button\s*\{[^}]*min-height:\s*36px/,
    "mobile project rows must stay ≥36px",
  );
  assert.match(
    mobile,
    /\.search-row input\s*\{[^}]*min-height:\s*36px/,
    "mobile search input must stay ≥36px",
  );
  assert.match(
    mobile,
    /\.search-row > button\s*\{[^}]*min-width:\s*36px;[^}]*min-height:\s*36px/,
    "mobile add-project button must stay ≥36px",
  );
  // 行内次级按钮 32px 是有意保留的（两按钮间已有空隙），不要被误删。
  assert.match(
    mobile,
    /\.project-row-actions \.project-action\s*\{[^}]*min-width:\s*32px;[^}]*min-height:\s*32px/,
    "mobile project action buttons keep 32px minimum",
  );
  // 视觉密度 = 桌面 Web（6px gap），但移动端左右留白多 4px 给手指边缘安全区。
  assert.match(
    mobile,
    /\.message-list\s*\{[^}]*padding-left:\s*16px;[^}]*padding-right:\s*16px/,
    "mobile message list should widen left/right to 16px",
  );
  // 思考卡 trigger（桌面 24px 可点）移动端抬到 44px 真实点击区。
  assert.match(
    mobile,
    /\.message-list button\.min-h-6\s*\{[^}]*min-height:\s*44px/,
    "mobile thinking trigger should expand to 44px touch target",
  );
});
