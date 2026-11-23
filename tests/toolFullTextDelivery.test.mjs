import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const toolCard = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);

test("ToolCard shows on-demand full-output entry with loading/error states", () => {
  // 截断标记驱动入口；加载成功替换显示文本，失败保留重试
  assert.match(toolCard, /isTruncated = props\.message\.meta\?\.truncated === true/);
  assert.match(toolCard, /desktopApi\.sessions\.readMessageFullText\(/);
  assert.match(toolCard, /setFullText\(result\.text\)/);
  assert.match(toolCard, /setFullError\(true\)/);
  assert.match(toolCard, /fullOutputLoadFailed/);
});
