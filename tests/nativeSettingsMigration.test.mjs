import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("AppSettings type no longer declares the Electron sandbox option", () => {
  // “已删除功能不得再出现”的静态约束：类型声明里的字段无法靠运行时行为证明缺席。
  assert.doesNotMatch(readFileSync("src/shared/types/settings.ts", "utf8"), /electronChromiumSandbox\s*:/);
});
