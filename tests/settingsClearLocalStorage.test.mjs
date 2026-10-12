// 缓存与日志设置页「清理界面本地缓存」：
// - 操作走 ConfirmDialog 确认（danger），确认后 localStorage.clear() + 整页刷新
// - 只清理渲染层 localStorage（纯 UI 偏好），不触碰主进程日志/设置
// - i18n 中英文案成对存在
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tab = readFileSync("src/renderer/src/components/app/settings/SettingsStorageTab.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const NEW_KEYS = [
  "settings.storage.clearLocalStorage",
  "settings.storage.clearLocalStorageDesc",
  "settings.storage.clearLocalStorageButton",
  "settings.storage.clearLocalStorageConfirm",
];

test("clearing UI cache goes through a danger ConfirmDialog, not a bare button", () => {
  assert.match(tab, /confirmClearLocalStorage/);
  assert.match(tab, /onClick=\{confirmClearLocalStorage\}/);
  assert.match(tab, /variant="destructive"/);
  assert.match(tab, /setConfirmDialog\(\{[\s\S]*?title: t\("app\.confirm"\)[\s\S]*?message: t\("settings\.storage\.clearLocalStorageConfirm"\)/);
});

test("clear executes localStorage.clear() and reloads the page", () => {
  // 清空后内存态（宽度/折叠/过滤器）仍是旧值，不刷新会把旧值写回，等于没清
  assert.match(tab, /localStorage\.clear\(\)/);
  // 刷新必须保留原生 token（裸 location.reload() 会让页面永久卡在启动画面），统一走 reloadDesktopRenderer。
  assert.match(tab, /reloadDesktopRenderer\(\)/);
  assert.doesNotMatch(tab, /window\.location\.reload\(\)/);
});

test("clear targets the renderer localStorage only, never main-process logs", () => {
  const clearBlock = tab.slice(tab.indexOf("const doClearLocalStorage"), tab.indexOf("const confirmClearLocalStorage"));
  assert.doesNotMatch(clearBlock, /logs\.clear|piDesktop\./);
});

test("storage tab keeps the new settings entries in both locales", () => {
  for (const key of NEW_KEYS) {
    assert.match(zh, new RegExp(`"${key}":`), `${key} must exist in zh-CN`);
    assert.match(en, new RegExp(`"${key}":`), `${key} must exist in en-US`);
  }
});
