export type NativeHeartbeatPayloadLike = {
	lastEventSeq?: number;
};

export type NativeHeartbeatRecoveryState = {
	consecutiveStalledHeartbeats: number;
	lastRendererEventSeq: number | null;
};

export type NativeHeartbeatRecoveryResult = {
	state: NativeHeartbeatRecoveryState;
	shouldReload: boolean;
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
		shouldReload: consecutiveStalledHeartbeats >= threshold,
	};
}
