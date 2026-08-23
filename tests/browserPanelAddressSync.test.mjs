import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归门禁（loadUrl 中心化不变量）：loadUrl() 必须在 host.loadUrl 之前同步
// url/inputValue。重构前所有导航入口天然拥有该保证；若缺失，「加载中」窗口期内
// selectDevice 会读到旧 url，把刚发起的导航打回旧页面 —— 地址栏 Enter / 新建 Tab /
// Home / 切 tab / 关 tab 全部受影响。所有导航入口（含外部导航订阅回调）统一经
// loadUrl() 自动安全。
const panel = readFileSync("src/renderer/src/components/app/BrowserPanel.tsx", "utf8");

/** 断言 markers 在源码中按给定顺序出现（用于锁定「先同步后加载」的先后关系）。 */
function assertOrdered(markers, label) {
	let cursor = -1;
	for (const marker of markers) {
		const found = panel.indexOf(marker, cursor + 1);
		assert.ok(found > cursor, `${label}: expected "${marker}" after position ${cursor}`);
		cursor = found;
	}
}

test("loadUrl itself syncs url/input before dispatching to the host", () => {
	assertOrdered(
		[
			"const loadUrl = useCallback(",
			"setUrl(targetUrl);",
			"setInputValue(targetUrl);",
			"setIsLoading(true);",
			"host.setDeviceProfile(",
			"await host.loadUrl(targetUrl);",
		],
		"loadUrl",
	);
});

test("product entries funnel through loadUrl; direct host.loadUrl only inside loadUrl itself", () => {
	// 所有真实导航统一经 loadUrl()（含外部导航订阅回调）；host.loadUrl 只允许出现
	// 一次（loadUrl 本体）。新增直调宿主的入口必须先补同步并更新此计数。
	assert.equal((panel.match(/host\.loadUrl\(/g) ?? []).length, 1);
	for (const marker of [
		"void loadUrl(finalUrl);", // 地址栏 Enter（navigate）
		"void loadUrl(DEFAULT_HOME);", // 新建 Tab + Home 按钮
		"void loadUrl(tab.url);", // 切 tab
		"void loadUrl(nextTab.url);", // 关闭 active tab 加载邻居
	]) {
		assert.ok(panel.includes(marker), `entry must call loadUrl: ${marker}`);
	}
});

test("external navigation subscription funnels through loadUrl and syncs tabs", () => {
	// 订阅回调只做 tab 列表同步 + 统一 loadUrl 入口（地址栏/isLoading/device 由
	// loadUrl 中心保证），不再自建第二套导航同步。
	assertOrdered(
		[
			"subscribeBrowserNavigation(",
			"setTabs([...snapshot.tabs]);",
			"setActiveTabId(tab.id);",
			"void loadUrl(tab.url, snapshot.device);",
		],
		"external navigation subscription",
	);
});

// 回归门禁（tab 元数据操作不触发多余导航）：
// - closeTab 曾对任意非最后 tab 无条件 loadUrl(nextTab.url)，关闭后台 tab 会把
//   正在填表单的当前页刷掉；必须仅 wasActive 时才导航。
// - switchTab 曾对已激活 tab 也重新导航；重复点击当前 tab 不应刷新。
test("closeTab navigates only when closing the active tab; switchTab no-ops on active tab", () => {
	const closeBlock = panel.slice(
		panel.indexOf("const closeTab = useCallback("),
		panel.indexOf("const selectDevice = useCallback("),
	);
	assert.ok(closeBlock.length > 0, "missing closeTab block");
	const wasActivePos = closeBlock.indexOf("const wasActive = currentActiveId === tabId;");
	const loadNeighborPos = closeBlock.indexOf("void loadUrl(nextTab.url);");
	assert.ok(wasActivePos >= 0, "closeTab must compute wasActive");
	assert.ok(loadNeighborPos > wasActivePos, "loadUrl(nextTab.url) must be guarded by wasActive");

	const switchStart = panel.indexOf("const switchTab = useCallback(");
	const switchEnd = panel.indexOf("const addTab = useCallback(");
	assert.ok(switchStart >= 0 && switchEnd > switchStart, "missing switchTab block");
	const switchBlock = panel.slice(switchStart, switchEnd);
	const guardPos = switchBlock.indexOf('getBrowserPanelSessionSnapshot().activeTabId === tabId) return;');
	const findTabPos = switchBlock.indexOf("getBrowserPanelSessionSnapshot().tabs.find");
	assert.ok(guardPos >= 0 && guardPos < findTabPos,
		"switchTab must early-return when the clicked tab is already active");
});
