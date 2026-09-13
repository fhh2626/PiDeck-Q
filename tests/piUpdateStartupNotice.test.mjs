import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("startup no longer auto-runs a Pi version update check", () => {
  const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");

  // 回归：0.2.1 移除了内置更新系统后，启动路径不再触发「Pi 版本检测 + 更新提示」。
  // 环境检测（checkPiInstall）仍保留，但那是「pi 装没装」，不是「pi 是不是最新版」。
  // 这里守住 usePiUpdate 不再暴露启动期版本检查入口，避免后人把它加回来。
  assert.doesNotMatch(hook, /checkPiCliUpdateOnStartup/);
  assert.doesNotMatch(hook, /startupUpdateCheckDoneRef/);
  assert.doesNotMatch(app, /checkPiCliUpdateOnStartup\(\), 1200\)/);
});

test("opening dev settings does not auto-detect pi; cached result is shown directly", () => {
  const hook = readFileSync("src/renderer/src/hooks/usePiUpdate.ts", "utf8");
  const devTab = readFileSync("src/renderer/src/components/app/settings/DevTab.tsx", "utf8");
  const settings = readFileSync("src/shared/types/settings.ts", "utf8");

  // 回归：打开开发设置 tab 曾自动触发一次 pi 路径检测（spawn 探测），
  // 现在只有手动点「检测环境」才检测；已检测成功的结果从 settings 缓存直接恢复显示。
  assert.doesNotMatch(devTab, /activeTab === "dev" && props\.piStatus === null/);
  assert.match(devTab, /不自动检测 pi/);
  // settings 持久化字段 + 恢复逻辑（piStatus 为 null 时从缓存回填）
  assert.match(settings, /piInstall\?: \{ command: string; version: string; runtimeKind\?:/);
  assert.match(hook, /settings\.piInstall && piStatus === null/);
  assert.match(hook, /persistPiInstall/);
  // 未检测到时清除旧缓存，避免残留旧路径
  assert.match(hook, /清除旧缓存，避免残留/);
});
