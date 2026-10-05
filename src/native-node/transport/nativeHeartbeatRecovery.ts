export type NativeHeartbeatPayloadLike = {
	lastEventSeq?: number;
};

/** 连续停滞期内，相邻两次 resync 之间的间隔上限（单位：心跳次数，约 60 秒）。 */
const MAX_RESYNC_BACKOFF_HEARTBEATS = 20;

export type NativeHeartbeatRecoveryState = {
	consecutiveStalledHeartbeats: number;
	lastRendererEventSeq: number | null;
	/** 已在当前停滞期内触发过的 resync 次数；游标推进或通道恢复健康时清零。 */
	resyncAttempts: number;
	/** 下一次 resync 所需的连续停滞心跳数（随 resyncAttempts 指数退避）。 */
	nextResyncAtStalled: number;
};

export type NativeHeartbeatRecoveryResult = {
	state: NativeHeartbeatRecoveryState;
	/**
	 * 恒为 false（2026-09 恢复策略修复）：事件序号滞后只说明消息流被堵过一段，
	 * 不代表页面真的卡死。这里不再授权整页重载，避免删除/流式结束后的自动「重启」。
	 */
	shouldReload: boolean;
	/** 连续多轮心跳序号完全未推进时，改为补发一次全量渲染状态。 */
	shouldResync: boolean;
};

const DEFAULT_RESYNC_AFTER_STALLED = 3;

/** Create the sidecar's cursor-based recovery state for a new renderer page. */
export function createNativeHeartbeatRecoveryState(): NativeHeartbeatRecoveryState {
	return {
		consecutiveStalledHeartbeats: 0,
		lastRendererEventSeq: null,
		resyncAttempts: 0,
		nextResyncAtStalled: DEFAULT_RESYNC_AFTER_STALLED,
	};
}

/**
 * Count only unhealthy heartbeats whose renderer cursor did not advance.
 * A stale server snapshot during active SSE delivery must not escalate into a
 * page reload while the renderer is demonstrably consuming newer events.
 *
 * 序号确实停住时也不再整页重载：返回 shouldResync 由调用方补发全量状态，
 * 只有「心跳本身消失」（页面定时器停了）才允许重载，见 nativeHeartbeatWatchdog。
 */
export function advanceNativeHeartbeatRecovery(
	previous: NativeHeartbeatRecoveryState,
	payload: NativeHeartbeatPayloadLike,
	eventChannelHealthy: boolean,
	reloadAfter = DEFAULT_RESYNC_AFTER_STALLED,
): NativeHeartbeatRecoveryResult {
	const rendererEventSeq =
		typeof payload.lastEventSeq === "number" &&
		Number.isInteger(payload.lastEventSeq) &&
		payload.lastEventSeq >= 0
			? payload.lastEventSeq
			: null;
	const cursorAdvanced =
		rendererEventSeq !== null &&
		previous.lastRendererEventSeq !== null &&
		rendererEventSeq > previous.lastRendererEventSeq;
	const lastRendererEventSeq =
		rendererEventSeq === null
			? previous.lastRendererEventSeq
			: previous.lastRendererEventSeq === null
				? rendererEventSeq
				: Math.max(previous.lastRendererEventSeq, rendererEventSeq);
	const recovered = eventChannelHealthy || cursorAdvanced;
	const consecutiveStalledHeartbeats = recovered ? 0 : previous.consecutiveStalledHeartbeats + 1;
	const threshold = Math.max(1, Math.floor(reloadAfter));
	// 恢复健康后重置退避；停滞期内每次 resync 之后把下一次的门槛推远。
	// 没有退避时，每次 resync 又会补发全量消息窗口，加重渲染层负担，使停滞延续、
	// 每 3 秒触发一次（日志里 stalled-event-cursor 成串出现）。
	const resyncAttempts = recovered ? 0 : previous.resyncAttempts;
	// 本停滞期内尚未 resync 过时，门槛始终取调用方给的 threshold（而不是创建状态时的默认值）。
	const nextResyncAtStalled = recovered || resyncAttempts === 0 ? threshold : previous.nextResyncAtStalled;
	const shouldResync = !recovered && consecutiveStalledHeartbeats >= nextResyncAtStalled;
	if (shouldResync) {
		const backoff = Math.min(threshold * 2 ** (resyncAttempts + 1), MAX_RESYNC_BACKOFF_HEARTBEATS);
		return {
			state: {
				consecutiveStalledHeartbeats,
				lastRendererEventSeq,
				resyncAttempts: resyncAttempts + 1,
				nextResyncAtStalled: consecutiveStalledHeartbeats + backoff,
			},
			shouldReload: false,
			shouldResync: true,
		};
	}
	return {
		state: { consecutiveStalledHeartbeats, lastRendererEventSeq, resyncAttempts, nextResyncAtStalled },
		shouldReload: false,
		shouldResync: false,
	};
}
