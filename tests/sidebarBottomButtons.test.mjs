import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pure official：底栏改为 shadcn ghost icon Button，不再依赖 v3-braun 的
 * `.icon-button { border:0 }` CSS 契约。
 */

const sidebar = readFileSync(
  "src/renderer/src/components/sidebar/SidebarContent.tsx",
  "utf8",
);

test("v3 sidebar bottom buttons are shadcn ghost icons without CSS border rules", () => {
  assert.match(sidebar, /sidebar-bottom-actions/);
  assert.match(sidebar, /variant="ghost"/);
  assert.match(sidebar, /settings-icon/);
  assert.match(sidebar, /config-icon/);
  // 两个保留的底栏动作都走 size-8 icon button。
  assert.equal((sidebar.match(/className="icon-button [a-z-]+ size-8[^"]*"/g) || []).length, 2);
});
