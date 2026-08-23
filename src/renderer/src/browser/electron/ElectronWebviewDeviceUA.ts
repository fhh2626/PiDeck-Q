/**
 * device profile → 自定义 User-Agent 的纯选择函数。
 *
 * UA 常量自原 BrowserPanel.tsx 逐字节迁移（值一字不改）；
 * 本模块仅做 profile → UA 的映射，便于 node:test 直接锁定回归
 * （防止后续"顺手更新 UA"破坏迁移保真，见任务 §61/§53.16）。
 */

export const MOBILE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
export const TABLET_UA =
	"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/**
 * mobile/tablet 返回精确自定义 UA；pc 返回 null，
 * 表示由调用方（ElectronWebviewHost）恢复该 guest 捕获的真实默认 UA。
 */
export function deviceUserAgent(profile: "pc" | "mobile" | "tablet"): string | null {
	if (profile === "mobile") return MOBILE_UA;
	if (profile === "tablet") return TABLET_UA;
	return null;
}
