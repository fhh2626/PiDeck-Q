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
