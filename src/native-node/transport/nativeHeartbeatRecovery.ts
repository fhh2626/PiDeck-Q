export type NativeHeartbeatPayloadLike = {
	lastEventSeq?: number;
};

export type NativeHeartbeatRecoveryState = {
	consecutiveStalledHeartbeats: number;
	lastRendererEventSeq: number | null;
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

/** Create the sidecar's cursor-based recovery state for a new renderer page. */
export function createNativeHeartbeatRecoveryState(): NativeHeartbeatRecoveryState {
	return {
		consecutiveStalledHeartbeats: 0,
		lastRendererEventSeq: null,
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
	reloadAfter = 3,
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
	const consecutiveStalledHeartbeats =
		eventChannelHealthy || cursorAdvanced
			? 0
			: previous.consecutiveStalledHeartbeats + 1;
	const threshold = Math.max(1, Math.floor(reloadAfter));
	return {
		state: { consecutiveStalledHeartbeats, lastRendererEventSeq },
		shouldReload: false,
		shouldResync: consecutiveStalledHeartbeats >= threshold,
	};
}
