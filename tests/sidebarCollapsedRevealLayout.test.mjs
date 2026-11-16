import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const css = readRendererStyles();
const toolbar = readFileSync("src/renderer/src/components/workspace/WorkspaceToolbar.tsx", "utf8");
const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

test("collapsed sidebar reveal does not override the v3 conversation list layout", () => {
  assert.doesNotMatch(
    css,
    /\.conversation-list \{\n  display: block;/,
  );
  assert.match(
    css,
    /\.chat-list-pane\.v3-braun \.sidebar-body \.conversation-list \{[\s\S]*?display: flex;/,
  );
});

test("collapsed sidebar is hidden and the workspace toolbar offers restoration", () => {
  assert.match(shell, /LIST_COLLAPSED_SIZE = 0/);
  assert.match(css, /\.list-collapsed \.chat-list-pane \{\s*display:\s*none;/);
  assert.doesNotMatch(css, /list-toggle-native\.floating/);
  assert.doesNotMatch(css, /padding-left: 56px;/);
  assert.match(toolbar, /props\.listCollapsed &&/);
  assert.match(toolbar, /onClick=\{props\.onToggleListCollapsed\}/);
});
