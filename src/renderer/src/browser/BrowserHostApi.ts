import type { ComponentType } from "react";

/**
 * 嵌入式浏览器宿主中立契约（Browser feature → host adapter 边界）。
 *
 * 这里定义的是 BrowserPanel 需要什么能力，而不是具体宿主技术有什么 API：
 * - 不允许出现宿主专有类型 / DOM 元素 / raw 宿主事件名；
 * - URL normalization（补 https://）属于 BrowserPanel 产品逻辑，host 只加载已决定的 URL；
 * - 预期导航取消（旧导航被新导航替换）等宿主特有错误格式由具体 adapter 吸收并映射成 neutral event。
 */

export type BrowserDeviceProfile = "pc" | "mobile" | "tablet";

/** Adapter 下发给 BrowserPanel 的 neutral 生命周期事件（与宿主事件 shape 解耦）。 */
export type BrowserHostEvent =
	| {
			type: "navigated";
			url: string;
			canGoBack: boolean;
			canGoForward: boolean;
	  }
	| {
			type: "loading-started";
	  }
	| {
			type: "loading-stopped";
			canGoBack: boolean;
			canGoForward: boolean;
	  }
	| {
			type: "title-updated";
			title: string;
	  }
	| {
			type: "load-failed";
			kind: "failed";
			errorCode?: number;
			errorDescription?: string;
	  };

/**
 * 宿主控制命令。BrowserPanel 通过 onApiChange 拿到实例；
 * unmount 时 onApiChange(null)，引用只属于当前 mounted host，
 * 绝不允许缓存在模块级状态里（会持有已销毁的 guest webContents）。
 */
export interface BrowserHostApi {
	loadUrl(url: string): Promise<void>;
	goBack(): void;
	goForward(): void;
	reload(): void;
	setDeviceProfile(profile: BrowserDeviceProfile): void;
}

/** HostSurface 的 props：initialUrl/initialDevice 仅在 mount 时读取一次，不是 controlled prop。 */
export interface BrowserHostSurfaceProps {
	initialUrl: string;
	initialDevice: BrowserDeviceProfile;
	className?: string;
	onApiChange(api: BrowserHostApi | null): void;
	onEvent(event: BrowserHostEvent): void;
}

export type BrowserHostSurface = ComponentType<BrowserHostSurfaceProps>;
