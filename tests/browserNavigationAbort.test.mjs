import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserHost = readFileSync("src/renderer/src/browser/electron/ElectronWebviewHost.tsx", "utf8");
const navigationAbort = readFileSync("src/renderer/src/browser/electron/ElectronWebviewNavigation.ts", "utf8");

// ERR_ABORTED / -3 属于 Electron webview 边界：BrowserPanel 重构后该知识只允许存在
// 于 ElectronWebviewHost adapter（renderer 中唯一知道 <webview> 的模块）。
// 判断 helper 按 plan §60 抽到 ElectronWebviewNavigation.ts 以便 node:test 直接导入。
test("browser consumes expected Chromium navigation aborts at the electron host boundary", () => {
  assert.match(navigationAbort, /export function isExpectedNavigationAbort/);
  assert.match(navigationAbort, /ERR_ABORTED/);
  assert.match(browserHost, /await webview\.loadURL\(url\)/);
  assert.match(browserHost, /did-fail-load/);
  assert.match(browserHost, /evt\.errorCode === -3/);
});
