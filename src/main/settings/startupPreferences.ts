import { readFileSync } from "node:fs";
import type { AppSettings } from "../../shared/types";

function readDesktopSettingsSync(desktopSettingsFile: string): Partial<AppSettings> {
	try {
		const raw = readFileSync(desktopSettingsFile, "utf8");
		return JSON.parse(raw) as Partial<AppSettings>;
	} catch {
		return {};
	}
}

/**
 * 在 app.ready 之前同步读取 Chromium 沙箱偏好。
 * `no-sandbox` 必须在 ready 前 append，否则本进程已无法改 Chromium 启动参数。
 * 缺省 false：保持历史兼容（Windows 安全软件/旧驱动）。
 */
export function readElectronChromiumSandboxPreference(desktopSettingsFile: string): boolean {
	return readDesktopSettingsSync(desktopSettingsFile).electronChromiumSandbox === true;
}

/**
 * 在 app.ready 之前同步读取单实例偏好。
 * 版本级单实例锁必须在 ready 前申请（见 main/singleInstance.ts）。
 * 缺省 true：同一版本再次打开时复用窗口；不同版本始终可并行。
 */
export function readSingleInstancePreference(desktopSettingsFile: string): boolean {
	const value = readDesktopSettingsSync(desktopSettingsFile).singleInstance;
	// 未配置时默认开启单实例；只有显式 false 才允许同版本多开。
	return value !== false;
}
