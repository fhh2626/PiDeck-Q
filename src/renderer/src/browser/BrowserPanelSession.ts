/**
 * BrowserPanel 的 host 无关模块级会话状态。
 *
 * 浏览器抽屉/全屏切换会导致 BrowserPanel remount，但 tabs/activeTabId/device
 * 必须在同一 renderer 生命周期内保留，因此这里沿用原 BrowserPanel.tsx 中的
 * intentional module state（不迁 Jotai，见任务边界）。
 *
 * 该模块不允许出现任何 Electron/webview 引用；宿主 API（BrowserHostApi 实例）
 * 绝不能缓存在这里，否则 remount 后会持有已销毁的 guest webContents。
 */
import type { BrowserDeviceProfile } from "./BrowserHostApi";

export const DEFAULT_HOME = "https://github.com/fhh2626/PiDeck-Pi_Agent_Rust";

export type BrowserTab = {
	id: string;
	title: string;
	url: string;
};

export type BrowserPanelSessionSnapshot = {
	tabs: BrowserTab[];
	activeTabId: string | null;
	device: BrowserDeviceProfile;
};

export type BrowserNavigationListener = (tab: BrowserTab) => void;

let nextTabId = 1;
function genTabId(): string {
	return `tab-${nextTabId++}`;
}

const moduleState: BrowserPanelSessionSnapshot = {
	tabs: [],
	activeTabId: null,
	device: "pc",
};

/** 已挂载 BrowserPanel 的主动订阅集合。 */
const navigationListeners = new Set<BrowserNavigationListener>();

function ensureInitialTab() {
	if (moduleState.tabs.length > 0) return;
	const id = genTabId();
	moduleState.tabs = [{ id, title: "PiDeck-Q", url: DEFAULT_HOME }];
	moduleState.activeTabId = id;
}

/** 读取当前快照（纯读，不触发初始 tab 创建；ensure 只发生在组件挂载路径）。 */
export function getBrowserPanelSessionSnapshot(): BrowserPanelSessionSnapshot {
	return {
		tabs: [...moduleState.tabs],
		activeTabId: moduleState.activeTabId,
		device: moduleState.device,
	};
}

/** 组件首次挂载时取 active tab（tabs 为空则先建默认 Home tab）。 */
export function ensureInitialBrowserTab(): BrowserTab {
	ensureInitialTab();
	return (
		moduleState.tabs.find((tab) => tab.id === moduleState.activeTabId) ??
		moduleState.tabs[0]
	);
}

/** 写回部分快照字段；调用方负责随后同步 React state。 */
export function updateBrowserPanelSession(patch: Partial<BrowserPanelSessionSnapshot>): void {
	if (patch.tabs !== undefined) moduleState.tabs = patch.tabs;
	if (patch.activeTabId !== undefined) moduleState.activeTabId = patch.activeTabId;
	if (patch.device !== undefined) moduleState.device = patch.device;
}

/** 在 session 内新建一个 tab（统一 id 生成入口，返回新 tab；不改变 activeTabId）。 */
export function createBrowserTabInSession(url: string, title: string): BrowserTab {
	const id = genTabId();
	const tab: BrowserTab = { id, title, url };
	moduleState.tabs = [...moduleState.tabs, tab];
	return tab;
}

/**
 * 供外部（App.tsx）调用：在浏览器侧栏/弹框中导航到指定 URL。
 * 每次都新建 tab 并设为 active；若 BrowserPanel 已挂载，直接推送事件通知组件导航。
 */
export function requestBrowserNavigation(url: string): BrowserTab {
	const id = genTabId();
	// 初始 title 留空（渲染层 fallback 显示 URL，等宿主上报真实 page title 后替换），
	// 防止标题闪烁
	const tab: BrowserTab = { id, title: "", url };
	moduleState.tabs.push(tab);
	moduleState.activeTabId = id;
	// 主动通知已挂载的 BrowserPanel 实例（无需轮询）
	for (const listener of navigationListeners) {
		listener(tab);
	}
	return tab;
}

/** 订阅外部导航请求事件（BrowserPanel 挂载时监听，卸载时取消）。 */
export function subscribeBrowserNavigation(listener: BrowserNavigationListener): () => void {
	navigationListeners.add(listener);
	return () => {
		navigationListeners.delete(listener);
	};
}

/**
 * 清空会话状态（关闭最后一个 tab 时使用），下次打开时重建默认 Home tab。
 * 注意：与重构前行为一致，不重置 device——设备模式属于用户偏好，关闭最后 tab 不丢失。
 */
export function resetBrowserPanelSession(): void {
	moduleState.tabs = [];
	moduleState.activeTabId = null;
}
