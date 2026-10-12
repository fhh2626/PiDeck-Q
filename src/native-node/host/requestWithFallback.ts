/**
 * 等待宿主请求，但不允许它无限期阻塞调用方：超时或失败时返回兜底值。
 * HostBridge.request 本身没有超时；启动握手（/__pideck/bootstrap）若依赖一次永不返回的
 * 宿主调用（如被其他程序占用的系统剪贴板），页面就会永远停在启动画面。
 * 迟到的结果会被忽略（不会改写已返回的兜底值），迟到的拒绝也已被吞掉，避免未处理拒绝。
 */
export async function requestWithFallback<T>(
	request: () => Promise<T>,
	fallback: T,
	timeoutMs: number,
): Promise<{ value: T; degraded: boolean }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ value: T; degraded: boolean }>((resolve) => {
		timer = setTimeout(() => resolve({ value: fallback, degraded: true }), timeoutMs);
	});
	const attempt = request().then(
		(value) => ({ value, degraded: false }),
		() => ({ value: fallback, degraded: true }),
	);
	try {
		return await Promise.race([attempt, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
