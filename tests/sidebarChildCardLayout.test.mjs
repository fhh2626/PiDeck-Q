import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

/**
 * pure official P2-2：子行尺寸/hover 由组件 Tailwind 承担。
 * 仍保留 session-card 透明容器与状态徽标契约。
 */

const styles = readRendererStyles();
const sessionTree = readFileSync(
  "src/renderer/src/components/sidebar/SessionTree.tsx",
  "utf8",
);
const projectTree = readFileSync(
  "src/renderer/src/components/sidebar/ProjectTree.tsx",
  "utf8",
);
const agentListDisplay = readFileSync(
  "src/renderer/src/agentListDisplay.ts",
  "utf8",
);
const sourceBadge = readFileSync(
  "src/renderer/src/components/session/SessionSourceBadge.tsx",
  "utf8",
);

test("sidebar child rows use shared official hover/active classes", () => {
  // Density Contract: hover = bg only; active = bg + text（不要强边框 / shadow）
  assert.match(sessionTree, /hover:bg-muted\/60 hover:text-foreground/);
  assert.match(sessionTree, /active bg-accent\/20 text-foreground/);
  assert.match(sessionTree, /sessionRowClass/);
  assert.match(projectTree, /treeRowClass/);
  assert.match(projectTree, /flex min-h-7 w-full/);
  assert.match(projectTree, /project-fold grid size-6/);
  assert.match(projectTree, /hover:bg-muted\/60 hover:text-foreground/);
  assert.doesNotMatch(sessionTree, /shadow-sm/, "sidebar rows should not use shadow-sm");
  assert.doesNotMatch(projectTree, /shadow-sm/, "project rows should not use shadow-sm");
  assert.doesNotMatch(sessionTree, /active border-border-strong/, "active rows should not use a strong border");
  assert.doesNotMatch(projectTree, /active border-border-strong/, "active project rows should not use a strong border");
});

test("sidebar workspace wrapper stays transparent", () => {
  const workspaceCard = styles.match(
    /\.chat-list-pane\.v3-braun \.sidebar-body \.session-card \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(workspaceCard, "sidebar workspace card styles must exist");
  assert.match(workspaceCard, /background:\s*transparent;/);
  assert.match(workspaceCard, /border:\s*0;/);
  assert.match(workspaceCard, /overflow:\s*visible;/);
});

test("sidebar child titles truncate via component classes", () => {
  assert.match(sessionTree, /truncate font-medium/);
  assert.match(projectTree, /truncate font-medium/);
});

test("session status indicators stay on the concrete session row", () => {
  // 会话行显示蓝、黄、红状态点。
  assert.match(agentListDisplay, /export function sessionStatusDotClass/);
  assert.match(agentListDisplay, /case "idle"/);
  assert.match(agentListDisplay, /return "bg-info"/);
  assert.match(agentListDisplay, /case "error"/);
  assert.match(agentListDisplay, /return "bg-danger"/);
  assert.match(agentListDisplay, /case "running"/);
  assert.match(agentListDisplay, /return "bg-warning"/);
  // 未启动/无 runtime（含 detached）不渲染色点。
  assert.match(agentListDisplay, /if \(!status \|\| status === "detached"\) return undefined/);
  // SessionTree 不再渲染带文本的状态徽标；无 runtime 的历史记录不显示状态点。
  assert.doesNotMatch(sessionTree, /\/agent-status-indicator/);
  assert.match(sessionTree, /function renderRuntimeStatusDot/);
  assert.match(sessionTree, /sessionStatusDotClass\(status\)/);
  assert.match(sessionTree, /renderRuntimeStatusDot\(child\.agent\.status\)/);
  assert.match(sessionTree, /renderRuntimeStatusDot\(runtimeSnapshot\?\.status\)/);
});

test("project children use spacing without connector lines and chat uses the shared row", () => {
  assert.doesNotMatch(projectTree, /border-l/);
  assert.match(styles, /\.worktree-children \{[\s\S]*?border-left:\s*0;/);
  assert.doesNotMatch(projectTree, /chat-project-guide/);
  assert.doesNotMatch(styles, /\.project-group\.chat-project-group/);
});

test("sidebar uses compact project and session rows without a duplicate heading", () => {
  const sidebarContent = readFileSync(
    "src/renderer/src/components/sidebar/SidebarContent.tsx",
    "utf8",
  );

  assert.doesNotMatch(sidebarContent, /FolderTree/);
  assert.doesNotMatch(sidebarContent, /app\.sidebarProjects/);
  assert.match(sidebarContent, /sidebar-body flex min-h-0 flex-1 flex-col gap-1 px-2 pt-1 pb-1/);
  assert.match(sessionTree, /min-h-6 w-full/);
  assert.match(sessionTree, /history-session-row mx-0 min-h-6 pl-2 pr-2 py-0/);
  assert.match(sessionTree, /历史会话不是运行中的 Agent/);
  assert.match(sessionTree, /flex flex-col gap-0/);
  assert.match(styles, /\.chat-list-pane\.v3-braun \.sidebar-body \.session-row[\s\S]*?margin: 0;/);
  const conversationTitleSpan = styles.match(
    /\.conversation-title span \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(conversationTitleSpan, "conversation title span styles must exist");
  assert.doesNotMatch(conversationTitleSpan, /color:/);
  assert.match(styles, /\.conversation-title span\.running \{[\s\S]*color:/);
  assert.match(sourceBadge, /<Badge[\s\S]*variant="outline"/);
  assert.match(sourceBadge, /<SourceLogo source=\{props\.source\} \/>/);
  assert.match(sourceBadge, /aria-label=\{label\}/);
  assert.doesNotMatch(sourceBadge, />\{label\}<\//);
  assert.doesNotMatch(sessionTree, /session-source-badge/);
  assert.doesNotMatch(sourceBadge, /bg-(?:indigo|amber|emerald)-/);
});
