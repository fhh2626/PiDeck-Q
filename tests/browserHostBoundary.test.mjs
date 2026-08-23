import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// BrowserPanel → BrowserHostApi 架构边界（重构回归门禁）：
// Electron <webview> 的方法/事件/类型知识只允许存在于
// src/renderer/src/browser/electron/**，防止开发者把 webviewRef 写回 BrowserPanel。

const browserPanel = readFileSync("src/renderer/src/components/app/BrowserPanel.tsx", "utf8");
const hostContract = readFileSync("src/renderer/src/browser/BrowserHostApi.ts", "utf8");
const electronHost = readFileSync("src/renderer/src/browser/electron/ElectronWebviewHost.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const browserSurface = readFileSync("src/renderer/src/components/workspace/BrowserSurface.tsx", "utf8");

// raw 宿主事件名只允许出现在 addEventListener/removeEventListener 调用里（adapter 职责）。
// neutral BrowserHostEvent 的 type 字面量属于共享契约，BrowserPanel 的 switch 分支
// 必然出现，不算违规。
const RAW_EVENT_NAMES = [
	"did-navigate",
	"did-navigate-in-page",
	"did-start-loading",
	"did-stop-loading",
	"did-fail-load",
	"page-title-updated",
];

// BrowserPanel 允许的 DOM listener 仅限自身 UI（如 device 菜单的 document mousedown）；
// 禁止的是对宿主元素的 webview 事件监听。
const FORBIDDEN_LISTENER_TARGETS = [	/\bwv\b/, /webview/i, /host(Ref|Element)/i, /guest/i];

test("BrowserPanel must not know the Electron webview", () => {
	const forbidden = [
		/<webview/,
		/WebviewTag/,
		/Electron\./,
		/from ["']electron["']/,
		/loadURL\(/,
		/getUserAgent\(/,
		/setUserAgent\(/,
		/canGoBack\(/,
		/canGoForward\(/,
		/webviewRef/,
	];
	for (const pattern of forbidden) {
		assert.doesNotMatch(browserPanel, pattern, `BrowserPanel.tsx must not contain ${pattern}`);
	}
	for (const eventName of RAW_EVENT_NAMES) {
		assert.ok(!browserPanel.includes(eventName), `BrowserPanel.tsx must not reference raw event ${eventName}`);
	}
});
test("BrowserHostApi contract stays host-neutral", () => {
	// 允许 neutral loadUrl(；禁止宿主专有 import / DOM 元素 / raw 事件名 / capital loadURL(
	const forbidden = [
		/from ["']electron["']/,
		/WebviewTag/,
		/HTMLElement/,
		/<webview/,
		/did-navigate/,
		/did-fail-load/,
		/loadURL\(/,
	];
	for (const pattern of forbidden) {
		assert.doesNotMatch(hostContract, pattern, `BrowserHostApi.ts must not contain ${pattern}`);
	}
});

test("Electron-specific browser ownership lives in the adapter", () => {
	assert.match(electronHost, /<webview/);
	assert.match(electronHost, /loadURL\(/);
	assert.match(electronHost, /did-navigate/);
	assert.match(electronHost, /did-fail-load/);
	assert.match(electronHost, /page-title-updated/);
	assert.match(electronHost, /getUserAgent\(/);
	assert.match(electronHost, /setUserAgent\(/);
});

test("App.tsx routes navigation through BrowserPanelSession instead of the component", () => {
	assert.doesNotMatch(app, /from ["'].*components\/app\/BrowserPanel["']/);
	assert.doesNotMatch(app, /\bnavigateTo\b/);
	assert.match(app, /requestBrowserNavigation/);
});

test("BrowserSurface injects the Electron host; BrowserPanel has no default host", () => {
	assert.match(browserSurface, /import \{ ElectronWebviewHost \} from "\.\.\/\.\.\/browser\/electron\/ElectronWebviewHost"/);
	assert.match(browserSurface, /hostSurface=\{ElectronWebviewHost\}/);
	assert.doesNotMatch(browserPanel, /hostSurface\s*=\s*ElectronWebviewHost/);
});
