export type NativeHeartbeatScheduler = {
	setTimeout: (callback: () => void, delayMs: number) => number;
	clearTimeout: (timer: number) => void;
};

export type NativeHeartbeatRequest = {
	run: () => void;
	dispose: () => void;
};

/**
 * Runs at most one heartbeat request at a time and aborts a request that never
 * completes. The renderer timer remains cheap even when the loopback server is
 * stuck before producing an HTTP response.
 */
export function createNativeHeartbeatRequest(
	task: (signal: AbortSignal) => Promise<void>,
	scheduler: NativeHeartbeatScheduler,
	timeoutMs: number,
): NativeHeartbeatRequest {
	let inFlight: AbortController | null = null;
	let timeoutTimer: number | null = null;
	let disposed = false;

	const run = (): void => {
		if (disposed || inFlight) return;
		const controller = new AbortController();
		inFlight = controller;
		timeoutTimer = scheduler.setTimeout(() => {
			if (inFlight !== controller) return;
			if (timeoutTimer !== null) scheduler.clearTimeout(timeoutTimer);
			timeoutTimer = null;
			controller.abort();
		}, timeoutMs);
		void task(controller.signal)
			.catch(() => undefined)
			.finally(() => {
				if (inFlight !== controller) return;
				inFlight = null;
				if (timeoutTimer !== null) scheduler.clearTimeout(timeoutTimer);
				timeoutTimer = null;
			});
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		if (timeoutTimer !== null) scheduler.clearTimeout(timeoutTimer);
		timeoutTimer = null;
		inFlight?.abort();
		inFlight = null;
	};

	return { run, dispose };
}
