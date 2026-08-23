import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserHost = readFileSync("src/renderer/src/browser/electron/ElectronWebviewHost.tsx", "utf8");
const rendererTypes = readFileSync("src/renderer/src/types.d.ts", "utf8");
const main = readFileSync("src/main/index.ts", "utf8");
const webviewHost = readFileSync("src/main/browser/browserPanelWebviewHost.ts", "utf8");
// #115 U4：partition/白名单已收敛到共享模块，webview 管线主进程加固与浏览器安全模块都从它导入
const browserSecurity = readFileSync("src/main/browser/browserSecurity.ts", "utf8");
const sessionModule = readFileSync("src/renderer/src/browser/BrowserPanelSession.ts", "utf8");
const filesIpc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");
// Electron 43：webview new-window 事件已移除（Electron 22 起），弹窗只能由主进程接管
const externalLinks = readFileSync("src/main/browser/externalLinks.ts", "utf8");

function functionBlock(source, signature, nextSignature) {
	const start = source.indexOf(signature);
	assert.ok(start >= 0, `missing ${signature}`);
	const end = source.indexOf(nextSignature, start + signature.length);
	return source.slice(start, end >= 0 ? end : undefined);
}

test("Browser host adapter uses a fixed persistent partition without popup or file access attributes", () => {
	// The partition constant lives in main (configureBrowserPanelWebviewHost) and is
	// no longer duplicated anywhere in the renderer.
	assert.doesNotMatch(browserHost, /persist:pideck-browser-panel/);
	// 常量唯一定义在共享模块；index.ts 经别名引用同一值
	assert.match(browserSecurity, /export const BROWSER_PANEL_PARTITION = "persist:pideck-browser-panel"/);
	assert.match(browserSecurity, /export function isAllowedBrowserPanelUrl/);
	assert.match(webviewHost, /from "\.\/browserSecurity"/);
	assert.match(webviewHost, /session\.fromPartition\(BROWSER_PANEL_PARTITION\)/);
	// The renderer-driven webview sets allowfileaccess via attributes.
	// Ownership moved to the ElectronWebviewHost adapter (renderer's only <webview> module).
	assert.match(browserHost, /setAttribute\("allowfileaccess", "true"\)/);
	assert.match(rendererTypes, /partition\?: string/);
	assert.doesNotMatch(rendererTypes, /allowpopups/i);
});

test("guest popups are force-enabled and dispatched only by the main-process window-open policy", () => {
	// Electron 22 起 webview new-window 事件已移除：渲染层不得再监听它，弹窗流必须
	// 到达主进程 guest setWindowOpenHandler 统一分发。
	// 时机关键：guest-view-manager 的 makeWebPreferences() 先于 will-attach-webview 执行
	// （disablePopups = !params.allowpopups 已算完），改 params 无效；webPreferences 对象
	// 会在事件后直通展开给 WebContents.create()，必须改它。
	assert.match(webviewHost, /Object\.assign\(webPreferences, \{ disablePopups: false \}\)/);
	assert.doesNotMatch(webviewHost, /delete params\.allowpopups/);
	// 渲染层 adapter 不再监听 new-window（该事件在当前 Electron 不存在）
	assert.doesNotMatch(browserHost, /["']new-window["']/);
	// 主进程窗口打开策略：所有 guest popup（web + 系统协议）一律进受控确认，
	// 不直接 openExternalUrl（程序化 window.open 不代表用户意图）；真实窗口一律 deny。
	const openHandler = functionBlock(webviewHost, "guest.setWindowOpenHandler", "guest.on(");
	assert.match(openHandler, /return \{ action: "deny" \}/);
	assert.match(openHandler, /requestPopupConfirmation\(url\)/);
	assert.doesNotMatch(openHandler, /deps\.openExternalUrl/);
	assert.doesNotMatch(openHandler, /isHttpLikeExternalUrl\(url\)[^\n]*\n[^\n]*requestPopup/);
	// mailto/tel/sms 是网页可触发的系统协议；vscode 系列只留给受信应用内 UI
	assert.match(externalLinks, /GUEST_SYSTEM_SCHEMES[^\n]*= \["mailto:", "tel:", "sms:"\]/);
});

test("guest system-protocol requests require main frame and trusted-renderer confirmation", () => {
	// will-frame-navigate 对所有 iframe 触发且无 userGesture 信息：任意远程脚本/隐藏
	// iframe 不应能无交互唤起系统处理器，只有主 frame 请求才进确认流。
	const navHandler = functionBlock(webviewHost, "const blockUnsafeNavigation", "guest.on(\"will-frame-navigate\"");
	assert.match(navHandler, /event\.preventDefault\(\)/);
	assert.match(navHandler, /if \(!event\.isMainFrame\) \{/);
	assert.match(navHandler, /requestPopupConfirmation\(event\.url\)/);
	assert.doesNotMatch(navHandler, /openExternalUrl\(/);
	// 确认链路：主进程推送 {id,url} → 渲染层订阅 → 用户应答只回传 id →
	// 主进程按自己保存的 targetUrl 经网关执行。
	assert.match(main, /appConfirmExternalProtocol/);
	assert.match(main, /appRespondExternalProtocol/);
	assert.match(main, /externalProtocolGateway\.confirm\(request\.id\)/);
	// 确认后的路由语义与重构前一致：http(s) 遵守 linkOpenMode（不强制 forceSystem），
	// 系统协议无论设置如何都交系统。回归点：曾误写 openExternalUrl(targetUrl, true)
	// 导致 internal 模式下确认后仍被强拉系统浏览器。
	const respondHandler = functionBlock(main, "appRespondExternalProtocol", "// 内存分析模式");
	assert.match(respondHandler, /openExternalUrl\(targetUrl, isHttpLikeExternalUrl\(targetUrl\) \? undefined : true\)/);
	assert.doesNotMatch(respondHandler, /openExternalUrl\(targetUrl, true\)/);
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(preload, /onConfirmExternalProtocol: \(callback: \(payload: \{ id: string; url: string \}\) => void\) =>/);
	assert.match(preload, /respondExternalProtocol: \(id: string, action: "confirm" \| "cancel"\) =>/);
	assert.doesNotMatch(navHandler, /deps\.openExternalUrl/);
});

test("guest destroy clears its pending external protocol request", () => {
	// 注册表泄漏防线：guest 销毁必须 forgetGuest（pending + cooldown 一并清）。
	assert.match(webviewHost, /guest\.once\("destroyed", \(\) => gateway\.forgetGuest\(guest\.id\)\)/);
});

test("Browser navigation routes through BrowserPanelSession module subscription", () => {
	// navigateTo ownership moved from BrowserPanel to browser/BrowserPanelSession.ts;
	// requestBrowserNavigation keeps the same semantics: new tab per request + listener notification.
	assert.match(sessionModule, /export function requestBrowserNavigation\(url: string\)/);
	assert.match(sessionModule, /export function subscribeBrowserNavigation/);
	assert.match(sessionModule, /moduleState\.tabs\.push\(/);
	assert.doesNotMatch(sessionModule, /isAllowedBrowserUrl/);
});

test("main process hardens webPreferences before attaching BrowserPanel guests", () => {
	const attach = webviewHost;
	assert.match(attach, /session\.fromPartition\(BROWSER_PANEL_PARTITION\)/);
	assert.match(attach, /"will-attach-webview"/);
	assert.match(attach, /params\.partition = BROWSER_PANEL_PARTITION/);
	assert.match(attach, /webPreferences\.partition = BROWSER_PANEL_PARTITION/);
	assert.match(attach, /webPreferences\.sandbox = true/);
	assert.match(attach, /webPreferences\.nodeIntegration = false/);
	assert.match(attach, /webPreferences\.contextIsolation = true/);
	assert.match(attach, /webPreferences\.webSecurity = true/);
	assert.match(attach, /delete webPreferences\.preload/);
	assert.match(attach, /delete params\.preload/);
	assert.match(attach, /event\.preventDefault\(\)/);
});

test("BrowserPanel guest navigation, redirects, windows, and permissions default to deny", () => {
	const attach = webviewHost;
	assert.match(attach, /setPermissionCheckHandler\(\(\) => false\)/);
	assert.match(attach, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/);
	assert.match(attach, /setDevicePermissionHandler\(\(\) => false\)/);
	assert.match(attach, /webRequest\.onBeforeRequest/);
	assert.match(attach, /details\.resourceType === "mainFrame" \|\| details\.resourceType === "subFrame"/);
	assert.match(attach, /callback\(\{ cancel: true \}\)/);
	assert.match(attach, /guest\.session !== browserPanelSession/);
	assert.match(attach, /guest\.close\(\)/);
	assert.match(attach, /guest\.on\("will-frame-navigate"/);
	assert.match(attach, /guest\.on\("will-redirect"/);
	assert.match(attach, /guest\.setWindowOpenHandler/);
	assert.match(attach, /return \{ action: "deny" \}/);
	assert.match(attach, /if \(isAllowedBrowserPanelUrl\(event\.url\)\) return;/);
});

test("webview hardening is installed before the main window loads renderer content", () => {
	const createWindow = functionBlock(main, "async function createWindow()", "\n\nfunction shouldUseDevRendererUrl");
	const configureIndex = createWindow.indexOf("configureBrowserPanelWebviewHost(createdWindow");
	const loadIndex = createWindow.indexOf("mainWindow.loadURL");
	assert.ok(configureIndex >= 0, "expected webview hardening setup");
	assert.ok(loadIndex >= 0, "expected renderer load");
	assert.ok(configureIndex < loadIndex, "hardening must be installed before renderer load");
});

test("external browser IPC shares the HTTP(S) protocol gate and Chromium sandbox stays enabled", () => {
	const browserOpenExternal = functionBlock(filesIpc, 'router.handle(ipcChannels.browserOpenExternal', "\n\n\trouter.handle(");
	assert.match(browserOpenExternal, /await openExternalUrl\(url, true\)/);
	assert.doesNotMatch(browserOpenExternal, /shell\.openExternal\(url\)/);
	// Chromium 沙箱默认关闭是刻意的（Windows 安全软件/旧 GPU 驱动会在沙箱初始化触发原生断点），
	// 但只能在用户未显式开启 electronChromiumSandbox 时才附带 no-sandbox；
	// 用户开启沙箱后必须保持 Chromium 默认沙箱，不能无条件追加 no-sandbox。
	assert.match(main, /if \(!electronChromiumSandboxEnabled\) \{\s*\/\/[^\n]*\n\s*app\.commandLine\.appendSwitch\("no-sandbox"\);/);
});
