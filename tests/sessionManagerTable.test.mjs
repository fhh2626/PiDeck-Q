import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const components = readFileSync(
  "src/renderer/src/components/sidebar/SidebarComponents.tsx",
  "utf8",
);
const table = readFileSync(
  "src/renderer/src/components/ui-shadcn/table.tsx",
  "utf8",
);

test("session manager renders its list as a table with headers", () => {
  assert.match(components, /import \{[^}]*\bTable\b/);
  assert.match(components, /<TableHeader>/);
  assert.match(components, /t\("sessionManager\.session"\)/);
  assert.match(components, /t\("sessionManager\.actions"\)/);
  assert.match(components, /<TableRow[\s\S]*data-state=\{isChecked \? "selected" : undefined\}/);
  assert.match(components, /<TableCell className="w-full max-w-0">/);
});

test("session manager keeps its selection and action behavior", () => {
  assert.match(components, /const handleToggleAll = /);
  assert.match(components, /const handleToggle = /);
  assert.match(components, /const handleDeleteSelected = /);
  assert.match(components, /props\.onDelete\(\[session\]\)/);
  assert.match(components, /props\.onRename\(session\)/);
  assert.match(components, /props\.onExport\(session\)/);
});

test("session manager table primitives use project semantic tokens", () => {
  assert.match(table, /data-slot="table-row"/);
  assert.match(table, /hover:bg-bg-hover/);
  assert.match(table, /data-\[state=selected\]/);
  assert.match(table, /text-muted-foreground h-9 px-3/);
});

