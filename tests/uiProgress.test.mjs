import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const progress = readFileSync(
  "src/renderer/src/components/ui-shadcn/progress.tsx",
  "utf8",
);
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("shadcn Progress exposes value through aria semantics", () => {
  assert.match(progress, /ProgressPrimitive\.Root/);
  // value 必须传给 Radix Root，由 Radix 生成 aria-valuenow；同时驱动 Indicator 位移。
  assert.match(progress, /value=\{value\}/);
  assert.match(progress, /bg-primary h-full w-full flex-1 transition-all/);
  assert.match(progress, /`translateX\(-\$\{100 - \(value \|\| 0\)\}%\)`/);
});

test("legacy update progress track CSS is removed", () => {
  // AppUpdateOverlay 已随 0.2.1 移除，手写进度条 class 全部随之清掉；
  // 守门：新组件若要进度条，应引 shadcn Progress 而不是重新手写一套。
  assert.doesNotMatch(surfaces, /\.update-progress-track/);
  assert.doesNotMatch(surfaces, /\.update-progress-bar/);
  assert.doesNotMatch(surfaces, /\.update-progress-header/);
  assert.doesNotMatch(surfaces, /\.update-download-progress/);
});
