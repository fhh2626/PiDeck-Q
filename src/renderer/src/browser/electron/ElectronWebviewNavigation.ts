/**
 * 预期导航取消判断：Chromium 用 ERR_ABORTED / error -3 表示旧导航被新导航替换，
 * 这是 webview 正常生命周期，不应作为失败冒泡给 BrowserPanel。
 *
 * 独立成纯 TS 文件以便 node:test 直接导入（adapter 本体含 React 依赖）。
 */
export function isExpectedNavigationAbort(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /ERR_ABORTED|error code:?\s*-3|\(-3\)/i.test(message);
}
