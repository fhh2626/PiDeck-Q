import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

/**
 * 终端面板动画契约。
 * 合并自 terminalDockAnimation.test.mjs（初始化延后到开场动画结束）与
 * terminalDockCompositorAnimation.test.mjs（面板布局 + 合成层动效）。
 * 两者同一个主题：终端座的「出现/收起」时序与动效，放一处避免规则漂移。
 */
const terminalDock = readFileSync(
  "src/renderer/src/components/terminal/TerminalDock.tsx",
  "utf8",
);
const terminalHook = readFileSync("src/renderer/src/hooks/useTerminalDock.ts", "utf8");
const runtimeDock = readFileSync("src/renderer/src/components/session/SessionRuntimeDock.tsx", "utf8");
const styles = readRendererStyles();

function cssRule(selector) {
  return styles.match(new RegExp(`${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1];
}

test("defers terminal initialization until the dock opening animation completes", () => {
  assert.match(
    terminalDock,
    /const TERMINAL_OPEN_ANIMATION_MS = 300;/,
  );
  assert.match(
    terminalDock,
    /const \[contentReady, setContentReady\] = useState\(false\);/,
  );
  assert.match(
    terminalDock,
    /window\.setTimeout\(\s*\(\) => setContentReady\(true\),\s*TERMINAL_OPEN_ANIMATION_MS,\s*\)/,
  );
  assert.match(terminalDock, /if \(!open \|\| !contentReady\) return;/);
  assert.match(
    terminalDock,
    /if \(collapsed \|\| !contentReady \|\| !activeTab \|\| !containerRef\.current\) return;/,
  );
});

test("terminal dock combines panel layout with composited motion", () => {
  const chatPane = cssRule("\\.chat-pane");
  const terminalDockRule = cssRule("\\.terminal-dock");

  assert.ok(chatPane, "chat pane styles must exist");
  // #115 U5：纵向三段已交 react-resizable-panels，chat-pane 是纯 flex 列容器，
  // 不再有 grid-template-rows 过渡（回归锁：不得把旧 grid 动画加回来）
  assert.match(chatPane, /display:\s*flex;/);
  assert.match(chatPane, /flex-direction:\s*column;/);
  assert.doesNotMatch(chatPane, /grid-template-rows/);
  assert.ok(terminalDockRule, "terminal dock styles must exist");
  assert.match(terminalDockRule, /will-change:\s*transform;/);
  assert.match(terminalDockRule, /transition:\s*transform/);
  assert.match(styles, /\.terminal-dock\[data-motion-state="hidden"\][\s\S]*?translate3d\(0, 100%, 0\)/);
});

test("terminal dock remains mounted while its exit transform runs", () => {
  assert.match(terminalHook, /const TERMINAL_DOCK_MOTION_MS = 180;/);
  assert.match(terminalHook, /const \[terminalDockMounted, setTerminalDockMounted\] = useState\(false\);/);
  assert.match(terminalHook, /const \[terminalDockClosing, setTerminalDockClosing\] = useState\(false\);/);
  assert.match(terminalHook, /window\.setTimeout\(\s*\(\) => \{\s*setTerminalDockMounted\(false\);\s*setTerminalDockClosing\(false\);\s*\},\s*TERMINAL_DOCK_MOTION_MS,/);
  assert.match(runtimeDock, /mounted: boolean;/);
  assert.match(runtimeDock, /closing: boolean;/);
  assert.match(runtimeDock, /closing=\{props\.closing\}/);
});
