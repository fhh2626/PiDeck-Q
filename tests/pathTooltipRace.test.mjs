import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pathTooltip = readFileSync("src/renderer/src/components/ui-shadcn/PathTooltip.tsx", "utf8");

test("PathTooltip closes immediately so rapid row hover cannot stack path portals", () => {
  const handler = pathTooltip.match(/const onOpenChange = \(next: boolean\) => \{[\s\S]*?\n\t\};/)?.[0] ?? "";
  assert.match(handler, /setOpen\(next\);/);
  assert.doesNotMatch(pathTooltip, /hideTimerRef|hideDelay|setTimeout/);
});
