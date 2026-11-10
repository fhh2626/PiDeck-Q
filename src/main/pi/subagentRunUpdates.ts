import type { SubagentLiveRunStatus } from "../../shared/types/subagents";
import type { SubagentExecutionSource } from "./SubagentExecutionOwnership";
import { SUBAGENT_RUN_TRACKER_LIMITS as LIMITS } from "./subagentRunLimits";

export type ObservedSubagentRun = SubagentExecutionSource & {
	sessionFile: string;
	status: SubagentLiveRunStatus | "completed";
	agent?: string;
};

/** Narrow untrusted pi tool payloads before projecting bounded sidebar fields. */
export function subagentRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function bounded(value: unknown, maxLength = 128): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

/** progress.status precedes legacy flags; detached receipts are not live status sources. */
function resultStatus(item: Record<string, unknown>): ObservedSubagentRun["status"] {
	switch (subagentRecord(item.progress)?.status) {
		case "running": case "pending": return "running";
		case "failed": return "error";
		case "completed": case "detached": return "completed";
	}
	if (item.success === true) return "completed";
	if (item.stopped === true || item.timedOut === true || item.interrupted === true || item.turnBudgetExceeded === true) return "error";
	if (typeof item.error === "string" && item.error.trim()) return "error";
	if (typeof item.exitCode === "number") return item.exitCode === 0 ? "completed" : "error";
	return "running";
}

function workflowStatus(value: unknown): ObservedSubagentRun["status"] | undefined {
	switch (value) {
		case "running": return "running";
		case "failed": case "rejected": return "error";
		case "completed": case "stopped": case "detached": case "paused": return "completed";
		// pending is queued, not started: never light a session before launch.
		default: return undefined;
	}
}

/**
 * Extract the latest execution of each session in a tool frame. Workflow rows carry
 * childId/runId; single results use Details.runId. Keep identity alongside the status
 * so an older result cannot override a newer row just because their paths match.
 */
export function extractSubagentRunUpdates(details: unknown): ObservedSubagentRun[] {
	const record = subagentRecord(details);
	if (!record) return [];
	const observed: ObservedSubagentRun[] = [];
	if (record.mode !== "management") {
		const summary = subagentRecord(record.workflowChildren);
		const workflowRunId = bounded(summary?.workflowRunId) ?? bounded(record.runId);
		const childRows = Array.isArray(summary?.children) ? summary.children.slice(0, LIMITS.maxRunsPerAgent) : [];
		const rows = childRows.map(subagentRecord).filter((row) => row !== undefined);
		const results = Array.isArray(record.results) ? record.results.slice(0, LIMITS.maxRunsPerAgent) : [];
		const settledBySession = new Map<string, ObservedSubagentRun>();
		for (const item of results) {
			const result = subagentRecord(item);
			const sessionFile = bounded(result?.sessionFile, 1024);
			if (!result || !sessionFile) continue;
			const taskKey = bounded(result.workflowKey) ?? "single";
			const row = rows.find((child) => child.childId === taskKey);
			const executionId = bounded(result.runId) ?? bounded(row?.runId) ?? (summary ? undefined : bounded(record.runId));
			const agent = bounded(result.agent, 96);
			settledBySession.set(sessionFile, {
				sessionFile, status: resultStatus(result), taskKey,
				...(workflowRunId ? { workflowRunId } : {}), ...(executionId ? { executionId } : {}), ...(agent ? { agent } : {}),
			});
		}
		const updatesBySession = new Map<string, ObservedSubagentRun>();
		for (const child of rows) {
			const sessionFile = bounded(child.sessionFile, 1024);
			const status = workflowStatus(child.state);
			if (!sessionFile || !status) continue;
			const agent = bounded(child.agent, 96) ?? settledBySession.get(sessionFile)?.agent;
			const executionId = bounded(child.runId);
			updatesBySession.set(sessionFile, {
				sessionFile, status, taskKey: bounded(child.childId) ?? "single",
				...(workflowRunId ? { workflowRunId } : {}), ...(executionId ? { executionId } : {}), ...(agent ? { agent } : {}),
			});
		}
		for (const [sessionFile, settled] of settledBySession) {
			const current = updatesBySession.get(sessionFile);
			// Legacy terminal results settle a lagging running row. With identities,
			// only the SAME execution may settle it (old results often remain in a workflow).
			const sameExecution = !current || (current.executionId || settled.executionId
				? Boolean(current.executionId && current.executionId === settled.executionId)
				: current.taskKey === settled.taskKey || (settled.taskKey === "single" && rows.filter((row) => bounded(row.sessionFile, 1024) === sessionFile).length === 1));
			if (!current || (sameExecution && current.status === "running" && settled.status !== "running")) {
				updatesBySession.set(sessionFile, current ? { ...current, ...settled, taskKey: current.taskKey } : settled);
			}
		}
		observed.push(...updatesBySession.values());
	}

	// bg_wait uses mode:management too; completions must bypass the management filter.
	const completions = Array.isArray(record.completions) ? record.completions.slice(0, LIMITS.maxRunsPerAgent) : [];
	for (const item of completions) {
		const completion = subagentRecord(item);
		const children = Array.isArray(completion?.results) ? completion.results.slice(0, LIMITS.maxRunsPerAgent) : [];
		for (const child of children) {
			const result = subagentRecord(child);
			const sessionFile = bounded(result?.sessionFile, 1024);
			if (!sessionFile) continue;
			const executionId = bounded(result?.runId) ?? bounded(completion?.runId);
			observed.push({ sessionFile, taskKey: "single", status: result?.success === false ? "error" : "completed", ...(executionId ? { executionId } : {}) });
		}
	}
	return observed;
}
