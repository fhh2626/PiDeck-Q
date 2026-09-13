import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Shared Density Contract —— Native 与 Web 共用表面的契约测试。
 *
 * 原则：相同语义，共用密度。本文件只断言「两端是否消费同一份 recipe」，
 * 不重复断言各端专属的布局（那些在 desktopDensity / webDensity 里）。
 * 分层：
 *   A. 本文件：shared 表面（UserBubble / Thinking / Tool / TimelineMarker / Code / Table）
 *   B. tests/desktopDensity.test.mjs：Native 专属（Sidebar / TurnRow / Settings / Config）
 *   C. tests/webDensity.test.mjs：Web 专属（移动端触控 / Web 外围空间）
 */

const density = readFileSync("src/renderer/src/lib/density.ts", "utf8");
const surfaceComponents = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");
const eventCards = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
const timelineMarker = readFileSync("src/renderer/src/components/session/TimelineMarker.tsx", "utf8");
const toolCall = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
const askResult = readFileSync("src/renderer/src/components/session/AskQuestionResultCard.tsx", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");

// ── A. Density token 真源 ───────────────────────────────────────────────────
test("foundation.css defines the density token set (single source of truth)", () => {
  for (const token of [
    "--density-list-gap: 2px",
    "--density-block-gap: 6px",
    "--density-turn-gap: 12px",
    "--density-row-compact: 28px",
    "--density-control-height: 32px",
    "--density-panel-padding: 12px",
    "--density-surface-px: 8px",
    "--density-surface-py: 4px",
    "--density-code-header-height: 28px",
    "--density-code-padding-x: 10px",
    "--density-code-padding-y: 8px",
    "--density-radius-small: 4px",
    "--density-radius-surface: 6px",
  ]) {
    assert.ok(foundation.includes(token), `missing density token: ${token}`);
  }
});

// ── B. User Bubble 共享 surface ─────────────────────────────────────────────
test("user bubble recipe is the single visual recipe", () => {
  // recipe 本体：28px 半径体系（rounded-lg=8px，不再是 14px）、px-2.5 py-1.5（10×6）。
  const recipe = density.match(/USER_TURN_BUBBLE\s*=\s*\n\t"([^"]*)"/);
  assert.ok(recipe, "USER_TURN_BUBBLE constant not found");
  assert.match(recipe[1], /rounded-lg/);
  assert.match(recipe[1], /px-2\.5/, "bubble px should be 10px");
  assert.match(recipe[1], /py-1\.5/, "bubble py should be 6px");
  assert.doesNotMatch(recipe[1], /rounded-\[14px\]/, "bubble must not stay at 14px radius");
  assert.doesNotMatch(recipe[1], /px-3 py-2/, "bubble must not stay at 12×8 padding");
});

test("native and web user bubbles both consume USER_TURN_BUBBLE", () => {
  assert.match(surfaceComponents, /import \{[^}]*\bUSER_TURN_BUBBLE\b[^}]*\} from "@\/lib\/density"/);
  assert.match(surfaceComponents, /className=\{`\$\{USER_TURN_BUBBLE\}`\}/, "native bubble should render the recipe");
  assert.match(webTimeline, /import \{[^}]*\bUSER_TURN_BUBBLE\b[^}]*\} from "@\/lib\/density"/);
  assert.match(webTimeline, /className=\{USER_TURN_BUBBLE\}/, "web bubble should render the recipe");
  // 两端都不再各自写死 rounded-[14px] 气泡。
  assert.doesNotMatch(surfaceComponents, /rounded-\[14px\] border border-border bg-muted\/60/, "native bubble must not duplicate the recipe");
  assert.doesNotMatch(webTimeline, /rounded-\[14px\] border border-border bg-muted\/60/, "web bubble must not duplicate the recipe");
});

// ── C. TimelineMarker = step spacing 唯一真源 ───────────────────────────────
test("TimelineMarker is the single step-spacing source (default bottom gap)", () => {
  // 内容区默认底距是 pb-0.5（2px）；marker 行内 gap-2。
  assert.match(timelineMarker, /timeline-marker-content min-w-0 flex-1 pb-0\.5/);
  assert.doesNotMatch(timelineMarker, /flex-1 pb-1\b/, "default step gap must not stay at 4px");
  // 卡片端不再各自发明底距。扫描范围覆盖 Native Tool/Ask 与 Web 时间线。
  const pbOverrides = [eventCards, webTimeline, surfaceComponents, toolCall, askResult].flatMap((src) =>
    [...src.matchAll(/contentClassName="pb-[\d.]+"/g)],
  );
  assert.equal(
    pbOverrides.length,
    0,
    `cards must not override marker bottom gap: ${pbOverrides.map((m) => m[0]).join(", ")}`,
  );
});

// ── D. Code / Table 共享 chrome（streamdownChrome 是唯一文件，两端都加载）─────
test("code block chrome uses the density contract values", () => {
  // chrome 只来自 streamdownChrome.css 一份文件（Native + Web 都加载）。
  assert.match(streamdownChrome, /\[data-streamdown="code-block"\]\s*\{/, "code block rule must live in streamdownChrome.css");
  assert.match(streamdownChrome, /\[data-streamdown="table-wrapper"\]/, "table rule must live in streamdownChrome.css");
  // Phase 5：容器 radius 12px → --density-radius-surface (6px)；header 34px → 28px。
  assert.match(streamdownChrome, /\[data-streamdown="code-block"\][^}]*border-radius:\s*var\(--density-radius-surface\)/, "code container must use the 6px surface radius token");
  assert.doesNotMatch(streamdownChrome, /border-radius:\s*12px/, "code/table container must not stay at 12px radius");
  assert.match(streamdownChrome, /height:\s*var\(--density-code-header-height\)/, "code header must use the 28px token");
  assert.doesNotMatch(streamdownChrome, /height:\s*34px/, "code/table header must not stay at 34px");
  // Action 25.6px → 24px（1.5rem）。
  assert.match(streamdownChrome, /\[data-streamdown="code-block-actions"\] button \{[\s\S]*?width:\s*1\.5rem;[\s\S]*?height:\s*1\.5rem;/);
  assert.doesNotMatch(streamdownChrome, /width:\s*1\.6rem/,
    "code/table action buttons must not stay at 1.6rem");
});
