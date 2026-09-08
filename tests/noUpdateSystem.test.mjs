import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";

/**
 * 回归契约：0.2.1 移除了 PiDeck-Q 的整套内置更新系统
 * （版本检查 / 更新下载 / 自动更新 / 手动更新），但保留 Pi 环境检测
 * （pi --version、路径探测、runtime kind、WSL、自定义路径）与 Pi 扩展管理。
 *
 * 这份测试用「源码不再出现某符号 / 某文件不再存在」的方式，把
 * 「更新系统真的删干净了」这条契约钉死——后人若想偷偷把更新塞回来，
 * 这条测试会先红。它测的是边界（文件、通道、导出），不是实现细节。
 */

const read = (p) => readFileSync(p, "utf8");

test("app update service and its overlay/hook files are gone", () => {
  // 主进程更新服务整目录删除
  assert.equal(existsSync("src/main/update/AppUpdateService.ts"), false);
  // 渲染层更新控制器 + 旧 overlay + 死代码
  assert.equal(existsSync("src/renderer/src/hooks/useAppUpdateController.ts"), false);
  assert.equal(existsSync("src/renderer/src/hooks/usePiUpdate.ts"), true); // Pi 环境检测 hook 保留
  assert.equal(existsSync("src/renderer/src/components/overlays/AppUpdateOverlay.tsx"), false);
  assert.equal(existsSync("src/renderer/src/components/app/UpdateModals.tsx"), false);
});

test("update-specific IPC channels are removed from the shared contract", () => {
  const ipc = read("src/shared/ipc.ts");
  for (const channel of [
    "piUpdateCheck",
    "piUpdate",
    "appCheckUpdate",
    "appDownloadUpdate",
    "appOpenUpdatePackage",
    "appUpdateProgress",
  ]) {
    assert.doesNotMatch(ipc, new RegExp(`\\b${channel}\\b`), `channel ${channel} should be gone`);
  }
});

test("AppInfo no longer carries releasesUrl / homeDir", () => {
  const appTypes = read("src/shared/types/app.ts");
  // AppInfo 接口内不应再有 releasesUrl / homeDir（外链改由渲染层直接引 APP_RELEASES_URL）
  const appInfoBlock = appTypes.slice(
    appTypes.indexOf("export type AppInfo = {"),
    appTypes.indexOf("}", appTypes.indexOf("export type AppInfo = {")),
  );
  assert.ok(appInfoBlock, "AppInfo interface must exist");
  assert.doesNotMatch(appInfoBlock, /releasesUrl/);
  assert.doesNotMatch(appInfoBlock, /homeDir/);
});

test("AppSettings no longer has disableUpdateCheck", () => {
  const settings = read("src/shared/types/settings.ts");
  assert.doesNotMatch(settings, /disableUpdateCheck/);
});

test("ExtensionManager dropped pi update methods but kept extension updates", () => {
  const ext = read("src/main/extensions/ExtensionManager.ts");
  // 移除：pi 自身的版本更新
  assert.doesNotMatch(ext, /checkPiUpdate\(/);
  assert.doesNotMatch(ext, /\bupdatePi\(/);
  // 保留：扩展自身的更新（updateExtensions / updateExtension / npmViewVersion）
  assert.match(ext, /updateExtensions\(/);
  assert.match(ext, /updateExtension\(/);
  assert.match(ext, /npmViewVersion/);
});

test("usePiUpdate no longer runs a startup version-update check", () => {
  const hook = read("src/renderer/src/hooks/usePiUpdate.ts");
  // 启动期「pi 是不是最新版」的检测入口消失
  assert.doesNotMatch(hook, /checkPiCliUpdateOnStartup/);
  assert.doesNotMatch(hook, /startupUpdateCheckDoneRef/);
  assert.doesNotMatch(hook, /\bupdatePiCli\b/);
  // 但环境检测（装没装）仍在
  assert.match(hook, /checkPiInstall/);
  assert.match(hook, /refreshPiStatus/);
});

test("shared app identity keeps Releases as a plain external link", () => {
  const identity = read("src/shared/appIdentity.ts");
  // 内置更新 API 端点移除，但 Releases 页面作为普通外链保留
  assert.doesNotMatch(identity, /APP_LATEST_RELEASE_API/);
  assert.match(identity, /APP_RELEASES_URL/);
  assert.match(identity, /\/releases/);
});

test("settings store strips the legacy disableUpdateCheck from disk", () => {
  const store = read("src/main/settings/SettingsStore.ts");
  // 旧 settings.json 里的 disableUpdateCheck 走「加载时剥离后不再写回」的兼容路径
  assert.match(store, /disableUpdateCheck:\s*_ignoredDisableUpdateCheck/);
});

test("renderer no longer renders the update overlay in App", () => {
  const app = read("src/renderer/src/App.tsx");
  assert.doesNotMatch(app, /AppUpdateOverlay/);
  assert.doesNotMatch(app, /useAppUpdateController/);
  assert.doesNotMatch(app, /upToDateVersion/);
});
