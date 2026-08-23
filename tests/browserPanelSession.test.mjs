import assert from "node:assert/strict";
import test from "node:test";

// BrowserPanelSession 行为测试：模块级会话状态（host 无关）。
// 渲染层纯函数模块（无 DOM/无 React 依赖），node:test 可直接 import（同 chatTypography.test.mjs 策略）。
import {
	createBrowserTabInSession,
	DEFAULT_HOME,
	ensureInitialBrowserTab,
	getBrowserPanelSessionSnapshot,
	requestBrowserNavigation,
	resetBrowserPanelSession,
	subscribeBrowserNavigation,
	updateBrowserPanelSession,
} from "../src/renderer/src/browser/BrowserPanelSession.ts";
import { isExpectedNavigationAbort } from "../src/renderer/src/browser/electron/ElectronWebviewNavigation.ts";
import {
	deviceUserAgent,
	MOBILE_UA,
	TABLET_UA,
} from "../src/renderer/src/browser/electron/ElectronWebviewDeviceUA.ts";

function resetForTest() {
	resetBrowserPanelSession();
}

test("initial state: ensure creates exactly one Home tab and activates it", () => {
	resetForTest();
	const tab = ensureInitialBrowserTab();
	const snapshot = getBrowserPanelSessionSnapshot();
	assert.equal(snapshot.tabs.length, 1);
	assert.equal(snapshot.activeTabId, tab.id);
	assert.equal(tab.url, DEFAULT_HOME);
});

test("external request: each request creates a new active tab and notifies subscribers", () => {
	resetForTest();
	ensureInitialBrowserTab();
	const received = [];
	const unsubscribe = subscribeBrowserNavigation((tab) => received.push(tab));

	const tab = requestBrowserNavigation("https://example.test/a");
	const snapshot = getBrowserPanelSessionSnapshot();
	assert.equal(snapshot.tabs.length, 2);
	const newTab = snapshot.tabs.find((item) => item.url === "https://example.test/a");
	assert.ok(newTab);
	// 初始 title 为空，渲染层 fallback 显示 URL，等 page title 到达再替换
	assert.equal(newTab.title, "");
	assert.equal(snapshot.activeTabId, newTab.id);
	assert.deepEqual(received, [tab]);

	unsubscribe();
});

test("multiple external requests keep every tab; all notify subscribers", () => {
	resetForTest();
	ensureInitialBrowserTab();
	const received = [];
	const unsubscribe = subscribeBrowserNavigation((tab) => received.push(tab));

	const tabA = requestBrowserNavigation("https://example.test/a");
	const tabB = requestBrowserNavigation("https://example.test/b");
	const snapshot = getBrowserPanelSessionSnapshot();
	assert.equal(snapshot.tabs.length, 3);
	assert.ok(snapshot.tabs.some((tab) => tab.url === "https://example.test/a"), "tab A must survive");
	assert.equal(snapshot.activeTabId, tabB.id);
	assert.deepEqual(received, [tabA, tabB]);

	unsubscribe();
});

test("subscription: unsubscribe stops receiving notifications", () => {
	resetForTest();
	const received = [];
	const unsubscribe = subscribeBrowserNavigation((tab) => received.push(tab));
	requestBrowserNavigation("https://example.test/sub-1");
	assert.equal(received.length, 1);

	unsubscribe();
	requestBrowserNavigation("https://example.test/sub-2");
	assert.equal(received.length, 1, "unsubscribed listener must not be notified");
});

test("mount before subscription: ensureInitialBrowserTab returns the externally requested tab directly without double loading", () => {
	resetForTest();
	// 模拟面板未挂载时外部请求打开链接（此时无 subscriber）
	const requestedTab = requestBrowserNavigation("https://example.test/target");
	assert.equal(requestedTab.url, "https://example.test/target");

	// 模拟 BrowserPanel 挂载时的 ensureInitialBrowserTab 读取
	const initialTab = ensureInitialBrowserTab();
	assert.equal(initialTab.id, requestedTab.id);
	assert.equal(initialTab.url, "https://example.test/target");
});

test("reset clears stale tabs; next ensure recreates the Home tab", () => {
	resetForTest();
	ensureInitialBrowserTab();
	requestBrowserNavigation("https://example.test/stale");
	updateBrowserPanelSession({ device: "mobile" });
	resetForTest();
	// reset 后不主动 ensure：stale tabs 已清空
	assert.equal(getBrowserPanelSessionSnapshot().tabs.length, 0);
	// reset 不重置 device（与重构前一致）：设备模式是用户偏好，关闭最后 tab 不丢失
	assert.equal(getBrowserPanelSessionSnapshot().device, "mobile");
	// 下一次打开浏览器时 ensure 才重建默认 Home tab
	const tab = ensureInitialBrowserTab();
	assert.equal(tab.url, DEFAULT_HOME);
});

// ERR_ABORTED / -3 归属 Electron adapter；此处锁定迁移后的判断行为不回归。
test("expected navigation abort detection keeps original semantics", () => {
	assert.equal(isExpectedNavigationAbort(new Error("Failed to load URL... ERR_ABORTED")), true);
	assert.equal(isExpectedNavigationAbort(new Error("error code: -3")), true);
	assert.equal(isExpectedNavigationAbort(new Error("net::ERR_CONNECTION_REFUSED (-105)")), false);
	assert.equal(isExpectedNavigationAbort(new Error("ECONNREFUSED")), false);
	assert.equal(isExpectedNavigationAbort(new Error("random failure")), false);
});

// 设备 UA 回归（plan §61）：精确断言迁移后的 UA 值，防止后续被"顺手更新"。
// pc 返回 null 表示由 host 恢复该 guest 捕获的真实默认 UA，不是硬编码 UA。
test("device user-agent mapping matches the pre-refactor values exactly", () => {
	assert.equal(deviceUserAgent("mobile"), MOBILE_UA);
	assert.equal(
		deviceUserAgent("mobile"),
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	);
	assert.equal(deviceUserAgent("tablet"), TABLET_UA);
	assert.equal(
		deviceUserAgent("tablet"),
		"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	);
	assert.equal(deviceUserAgent("pc"), null);
});


