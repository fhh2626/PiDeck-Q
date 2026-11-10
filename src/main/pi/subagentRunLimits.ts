/** Shared in-memory bounds for the sidebar projection, ownership fences, and expiry. */
export const SUBAGENT_RUN_TRACKER_LIMITS = Object.freeze({
	maxRunsPerAgent: 64,
	maxSnapshotTasksPerAgent: 64,
	maxExecutionsPerSession: 64,
	runningTtlMs: 10 * 60_000,
	errorTtlMs: 30 * 60_000,
	snapshotStaleMs: 30_000,
});
