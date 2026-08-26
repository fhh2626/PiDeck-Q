export type LoadFailureAction =
	| { kind: "retry"; delayMs: number }
	| { kind: "showError" };

const LOAD_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

/** Finite renderer startup recovery: three retries, then a user-visible error. */
export function nextLoadFailureAction(failureCount: number): LoadFailureAction {
	if (!Number.isInteger(failureCount) || failureCount < 0) return { kind: "retry", delayMs: 500 };
	const delayMs = LOAD_RETRY_DELAYS_MS[failureCount];
	return delayMs === undefined ? { kind: "showError" } : { kind: "retry", delayMs };
}
