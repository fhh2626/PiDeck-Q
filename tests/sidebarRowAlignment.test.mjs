import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation = readFileSync(
  "src/renderer/src/styles/foundation.css",
  "utf8",
);

/**
 * 侧边栏卡片右侧对齐契约：会话/agent 行是 <button>，Chromium 中 button 的
 * width:auto 是 shrink-to-fit（宽度跟随内容），导致短名行过短、长名行超宽被裁。
 * 项目行是 <div>（width:100% 撑满）。修复：行类用 fill-available/stretch
 * 扣除 margin 后撑满，使会话卡片右边缘与项目卡片对齐。
 * 不能用 w-full(100%)：100% 不扣 margin-left，会向右溢出被 overflow-x:hidden 裁掉。
 */
test("session/agent sidebar rows use fill-available width, not content-sized auto", () => {
  // 每个目标类规则块：选择器到对应 {} 内容（支持组合选择器与注释）
  const ruleBlocks = foundation.match(/[^{}]*\{[^{}]*\}/g) ?? [];
  const targets = [".agent-row", ".session-row", ".agent-more-row", ".session-more-row"];
  for (const target of targets) {
    // 找「选择器恰为该 target（或组合选择器中含它）且非伪类/子代」的块
    const blocks = ruleBlocks.filter((block) => {
      const selectorPart = block.slice(0, block.indexOf("{"));
      return selectorPart
        .split(",")
        .map((s) => s.trim())
        .some((s) => s === target);
    });
    assert.ok(blocks.length > 0, `rule for ${target} not found`);
    for (const block of blocks) {
      // 剥离注释，避免注释里提到 width:auto 字样误触发；
      // 只断言包含 width 声明的块（另有仅调整 margin 的微调块不设 width）。
      const declarations = block.replace(/\/\*[\s\S]*?\*\//g, "");
      if (!/width\s*:/.test(declarations)) continue;
      assert.match(declarations, /width:\s*-webkit-fill-available/, `${target} should use fill-available`);
      assert.match(declarations, /width:\s*stretch/, `${target} should use stretch`);
      assert.doesNotMatch(declarations, /width:\s*auto/, `${target} must not use width:auto (button shrink-to-fit)`);
    }
  }
});

/**
 * 侧边栏资源行统一 28px（min-h-7）：Project / Session / Agent / Worktree
 * 全部用同一行高，层级差异靠缩进/图标/字号/状态点表达，而不是靠行高差。
 * 28px 是桌面工作台的导航行基线——比 32px 更紧凑，又不至于 24px 那样拥挤。
 */
test("sidebar project/session/agent/worktree rows all use min-h-7 (28px)", () => {
  const projectTree = readFileSync(
    "src/renderer/src/components/sidebar/ProjectTree.tsx",
    "utf8",
  );
  const sessionTree = readFileSync(
    "src/renderer/src/components/sidebar/SessionTree.tsx",
    "utf8",
  );
  const worktreeTree = readFileSync(
    "src/renderer/src/components/sidebar/WorktreeTree.tsx",
    "utf8",
  );

  // 项目行：treeRowClass 常量（跨行字符串）
  const treeRow = projectTree.match(/treeRowClass\s*=\s*\n\s*"([^"]*)"/);
  assert.ok(treeRow, "treeRowClass constant not found");
  assert.match(treeRow[1], /min-h-7/, "project row should be min-h-7");
  assert.doesNotMatch(treeRow[1], /min-h-8/, "project row should not be min-h-8");

  // 会话/agent 行：sessionRowClass 常量
  const sessionRow = sessionTree.match(/sessionRowClass\s*=\s*\n\s*"([^"]*)"/);
  assert.ok(sessionRow, "sessionRowClass constant not found");
  assert.match(sessionRow[1], /min-h-7/, "session/agent row should be min-h-7");
  assert.doesNotMatch(sessionRow[1], /min-h-8/, "session/agent row should not be min-h-8");

  // 行容器（rowContainerClass）也统一到 28px
  const rowContainer = sessionTree.match(/rowContainerClass\s*=\s*"([^"]*)"/);
  assert.ok(rowContainer, "rowContainerClass constant not found");
  assert.match(rowContainer[1], /min-h-7/, "row container should be min-h-7");

  // worktree 外层行
  const workspaceRow = worktreeTree.match(/workspaceRowClass\s*=\s*\n\s*"([^"]*)"/);
  assert.ok(workspaceRow, "workspaceRowClass constant not found");
  assert.match(workspaceRow[1], /min-h-7/, "worktree row should be min-h-7");
  assert.doesNotMatch(workspaceRow[1], /min-h-8/, "worktree row should not be min-h-8");
  // p-0.5 会把 28px 行再加上下各 2px，实际约 30px；纵向必须 py-0。
  assert.match(workspaceRow[1], /px-0\.5/, "worktree row should keep 2px horizontal padding");
  assert.match(workspaceRow[1], /py-0/, "worktree row should use py-0");
  assert.doesNotMatch(workspaceRow[1], /\bp-0\.5\b/, "worktree row should not use p-0.5");
});
