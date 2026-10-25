const DEFAULT_HEARTBEAT_WINDOW_MS = 15_000;
const DEFAULT_MISSED_WINDOWS_BEFORE_RELOAD = 3;

/**
 * Distinguish a temporary renderer event-loop stall from a renderer that has
 * stopped responding across several complete heartbeat windows.
 */
export function shouldReloadAfterMissedHeartbeats(
	elapsedMs: number,
	options: {
		windowMs?: number;
		missedWindowsBeforeReload?: number;
	} = {},
): boolean {
	const windowMs = Math.max(1, options.windowMs ?? DEFAULT_HEARTBEAT_WINDOW_MS);
	const threshold = Math.max(
		1,
		Math.floor(options.missedWindowsBeforeReload ?? DEFAULT_MISSED_WINDOWS_BEFORE_RELOAD),
	);
	return Math.floor(Math.max(0, elapsedMs) / windowMs) >= threshold;
}

export type RendererHeartbeatWatchdogDeps = {
	/** 当前时间（毫秒）；注入以便测试用假时钟。 */
	now: () => number;
	/** 窗口尚未显示/正在销毁时不应判定心跳丢失。 */
	shouldWatch: () => boolean;
	/** 请求渲染层整页重载；失败也算一次已处理，不会卡住后续判定。 */
	reload: () => Promise<unknown>;
	/** 触发重载时的诊断钩子（日志）。 */
	onReload?: () => void | Promise<unknown>;
};

/**
 * 渲染层心跳看门狗：由定时器周期性调用 tick()，收到心跳/窗口重新可见时调用 touch()。
 * 业务规则：
 * - 连续多个完整窗口没有心跳才重载（见 shouldReloadAfterMissedHeartbeats）；
 * - 一次重载未结束前不再发起第二次（reloadInFlight 去重）；
 * - 重载结束（无论成败）后把计时起点重置为当前时间，给新页面一个完整的宽限期，
 *   否则刚重载完立刻又判定超时，形成重载循环。
 */
export function createRendererHeartbeatWatchdog(deps: RendererHeartbeatWatchdogDeps) {
	let lastHeartbeatAt = deps.now();
	let reloadInFlight = false;
	/** 诊断失败不能阻止恢复；同步异常和异步拒绝都必须释放重载锁。 */
	async function performReload(): Promise<void> {
		try {
			void Promise.resolve(deps.onReload?.()).catch(() => undefined);
		} catch {
			// 日志通道本身故障时仍尝试重载，避免诊断反过来禁用恢复机制。
		}
		try {
			await deps.reload();
		} catch {
			// 宿主暂时不可用时等待下一个完整宽限期再尝试。
		} finally {
			reloadInFlight = false;
			lastHeartbeatAt = deps.now();
		}
	}
	return {
		touch(): void {
			lastHeartbeatAt = deps.now();
		},
		tick(): void {
			if (!deps.shouldWatch()) return;
			if (!shouldReloadAfterMissedHeartbeats(deps.now() - lastHeartbeatAt) || reloadInFlight) return;
			reloadInFlight = true;
			void performReload();
		},
	};
}
