import type { SubagentLiveRun, SubagentLiveRunStatus, SubagentStatusSnapshot } from "../../shared/types/subagents";
import { SubagentExecutionOwnership } from "./SubagentExecutionOwnership";
import { SubagentExpiryScheduler } from "./SubagentExpiryScheduler";
import { extractSubagentRunUpdates, subagentRecord } from "./subagentRunUpdates";
import { SUBAGENT_RUN_TRACKER_LIMITS as LIMITS } from "./subagentRunLimits";

export { extractSubagentRunUpdates } from "./subagentRunUpdates";
export { SUBAGENT_RUN_TRACKER_LIMITS } from "./subagentRunLimits";

/** Only observe existing stdio tool/status events, never poll or manage pi's child processes. */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent", "bg_wait"]);

type TrackedRun = SubagentLiveRun & { toolCallId?: string; snapshotRunId?: string; workflowRunId?: string };
type SnapshotTask = { updatedAt: number };

/**
 * Bounded sidebar projection for pi-owned child sessions (not PiDeck Agent runtimes).
 * Execution admission and completed tombstones live separately from visible rows:
 * path reuse must not let an older workflow heartbeat revive a failure after resume.
 * With an expiry listener, idle renderers receive TTL cleanup on the existing channel.
 */
export class SubagentRunTracker {
	private readonly runsByAgent = new Map<string, Map<string, TrackedRun>>();
	private readonly snapshotTasksByAgent = new Map<string, Map<string, SnapshotTask>>();
	private readonly ownership = new SubagentExecutionOwnership();
	private readonly expiry: SubagentExpiryScheduler | undefined;

	constructor(onExpiry?: (agentId: string) => void) {
		if (onExpiry) this.expiry = new SubagentExpiryScheduler((agentId) => {
			const changed = this.prune(agentId, Date.now());
			this.updateExpiry(agentId);
			if (changed) onExpiry(agentId);
		});
	}

	/** Same-state frames refresh timestamps/deadlines but do not flood the renderer. */
	observe(agentId: string, event: unknown, now = Date.now()): boolean {
		const record = subagentRecord(event);
		const toolName = typeof record?.toolName === "string" ? record.toolName.toLowerCase() : "";
		if (!record || !SUBAGENT_TOOL_NAMES.has(toolName)) return false;
		const details = subagentRecord(subagentRecord(record.result)?.details)
			?? subagentRecord(subagentRecord(record.partialResult)?.details);
		if (!details) return false;
		let changed = this.prune(agentId, now);
		const toolCallId = typeof record.toolCallId === "string" && record.toolCallId.length <= 128 ? record.toolCallId : undefined;
		const runs = this.runsByAgent.get(agentId) ?? new Map<string, TrackedRun>();
		for (const update of extractSubagentRunUpdates(details)) {
			const previousOwner = this.ownership.current(agentId, update.sessionFile);
			// An anonymous detach receipt cannot prove a NEW execution. Known aliases still
			// resolve normally; actual new launches identify themselves with runId or running.
			const allowNew = update.status === "running" || Boolean(update.executionId || update.workflowRunId) || !previousOwner?.snapshotRunId;
			const owner = this.ownership.claim(agentId, update.sessionFile, { ...update, ...(toolCallId ? { toolCallId } : {}) }, now, allowNew);
			if (!owner) continue;
			if (owner.snapshotRunId && this.hasLiveSnapshotTask(agentId, owner.snapshotRunId, now)) continue;
			// Completion closes liveness, not the outcome: a current terminal failure
			// may arrive after an empty complete frame and still needs its red row.
			if (owner.finished && owner.executionId && update.status === "running") continue;
			if (update.status === "completed") {
				owner.finished = true;
				if (runs.delete(update.sessionFile)) changed = true;
				continue;
			}
			changed = this.writeRun(runs, {
				sessionFile: update.sessionFile, status: update.status, updatedAt: now,
				...(update.agent ? { agent: update.agent } : {}),
				...(owner.toolCallId ? { toolCallId: owner.toolCallId } : {}),
				...(owner.workflowRunId ? { workflowRunId: owner.workflowRunId } : {}),
			}) || changed;
		}
		return this.settle(agentId, runs, changed);
	}

	/** Full snapshots remove omitted OWNED rows; truncated snapshots only update included rows. */
	observeStatusSnapshot(agentId: string, snapshot: SubagentStatusSnapshot, now = Date.now()): boolean {
		let changed = this.prune(agentId, now);
		if (!this.ownership.acceptSnapshot(agentId, snapshot, now)) {
			this.updateExpiry(agentId);
			return changed;
		}
		const runs = this.runsByAgent.get(agentId) ?? new Map<string, TrackedRun>();
		const tasks = this.snapshotTasksByAgent.get(agentId) ?? new Map<string, SnapshotTask>();
		const nextFiles = new Set<string>();
		const supersededFiles = new Set<string>();
		for (const child of snapshot.children) {
			nextFiles.add(child.sessionFile);
			const owner = this.ownership.claim(agentId, child.sessionFile, {
				workflowRunId: snapshot.workflowRunId, toolCallId: snapshot.parentToolCallId,
				taskKey: child.taskKey, ...(child.executionId ? { executionId: child.executionId } : {}),
			}, now);
			if (!owner) { supersededFiles.add(child.sessionFile); continue; }
			owner.snapshotRunId = snapshot.workflowRunId;
			if (owner.finished && owner.executionId && child.state === "running") continue;
			const status: SubagentLiveRunStatus | undefined = child.state === "failed" ? "error"
				: child.state === "running" && !snapshot.complete ? "running" : undefined;
			if (status) {
				changed = this.writeRun(runs, {
					sessionFile: child.sessionFile, status, updatedAt: now,
					...(child.agent ? { agent: child.agent } : {}),
					toolCallId: snapshot.parentToolCallId,
					snapshotRunId: snapshot.workflowRunId, workflowRunId: snapshot.workflowRunId,
				}) || changed;
			} else {
				owner.finished = true;
				if (runs.delete(child.sessionFile)) changed = true;
			}
		}
		for (const [sessionFile, run] of runs) {
			if (supersededFiles.has(sessionFile)) continue;
			if (snapshot.complete) {
				// Close only rows still owned by this workflow, including tool-only rows.
				// Another workflow/new tool execution must survive old complete/clear frames.
				if (run.snapshotRunId !== snapshot.workflowRunId && run.workflowRunId !== snapshot.workflowRunId) continue;
				if (run.status === "error") continue;
			} else if (snapshot.truncated || run.snapshotRunId !== snapshot.workflowRunId || nextFiles.has(sessionFile)) continue;
			const owner = this.ownership.current(agentId, sessionFile);
			if (owner) owner.finished = true;
			runs.delete(sessionFile);
			changed = true;
		}
		if (snapshot.complete) tasks.delete(snapshot.workflowRunId);
		else if (snapshot.children.length || tasks.has(snapshot.workflowRunId)) {
			tasks.delete(snapshot.workflowRunId);
			tasks.set(snapshot.workflowRunId, { updatedAt: now });
		}
		// A publisher/task flood is bounded independently of the visible row limit.
		while (tasks.size > LIMITS.maxSnapshotTasksPerAgent) {
			const oldest = tasks.keys().next().value;
			if (oldest === undefined) break;
			tasks.delete(oldest);
			changed = this.removeTaskRunning(runs, oldest) || changed;
		}
		if (tasks.size) this.snapshotTasksByAgent.set(agentId, tasks);
		else this.snapshotTasksByAgent.delete(agentId);
		return this.settle(agentId, runs, changed);
	}

	/** Explicit clear closes the source, preserves failures, and cannot clear a newer owner. */
	clearStatusTask(agentId: string, workflowRunId: string): boolean {
		this.ownership.closeSnapshot(agentId, workflowRunId);
		this.snapshotTasksByAgent.get(agentId)?.delete(workflowRunId);
		const runs = this.runsByAgent.get(agentId) ?? new Map<string, TrackedRun>();
		for (const [file, run] of runs) {
			if (run.status !== "running" || (run.snapshotRunId !== workflowRunId && run.workflowRunId !== workflowRunId)) continue;
			const owner = this.ownership.current(agentId, file);
			if (owner) owner.finished = true;
		}
		return this.settle(agentId, runs, this.removeTaskRunning(runs, workflowRunId));
	}

	/** Read projection; expiry callbacks proactively push changes even with no further reads/events. */
	snapshot(agentId: string, now = Date.now()): SubagentLiveRun[] {
		this.prune(agentId, now);
		this.updateExpiry(agentId);
		return [...(this.runsByAgent.get(agentId)?.values() ?? [])].map((run) => ({
			sessionFile: run.sessionFile, status: run.status, updatedAt: run.updatedAt,
			...(run.agent ? { agent: run.agent } : {}),
		}));
	}

	/** Tool-level failures remove that call's running rows, never a live snapshot or a failure row. */
	clearToolCall(agentId: string, toolCallId: string, now = Date.now()): boolean {
		const runs = this.runsByAgent.get(agentId) ?? new Map<string, TrackedRun>();
		let changed = false;
		for (const [file, run] of runs) {
			if (!toolCallId || run.toolCallId !== toolCallId || run.status !== "running") continue;
			if (run.snapshotRunId && this.hasLiveSnapshotTask(agentId, run.snapshotRunId, now)) continue;
			runs.delete(file);
			changed = true;
		}
		return this.settle(agentId, runs, changed);
	}

	/** Turn end is not child end after handoff: keep lights with a live snapshot owner. */
	clearRunning(agentId: string, now = Date.now()): boolean {
		let changed = false;
		const runs = this.runsByAgent.get(agentId) ?? new Map<string, TrackedRun>();
		for (const [file, run] of runs) {
			if (run.status !== "running") continue;
			if (run.snapshotRunId && this.hasLiveSnapshotTask(agentId, run.snapshotRunId, now)) continue;
			runs.delete(file);
			changed = true;
		}
		return this.settle(agentId, runs, changed);
	}

	/** All stop/restart/exit/stopAll paths pair timer, row, task, and ownership cleanup here. */
	clearAgent(agentId: string): boolean {
		this.expiry?.cancel(agentId);
		this.ownership.clearAgent(agentId);
		this.snapshotTasksByAgent.delete(agentId);
		return this.runsByAgent.delete(agentId);
	}

	private prune(agentId: string, now: number): boolean {
		this.ownership.prune(agentId, now);
		let changed = false;
		const runs = this.runsByAgent.get(agentId) ?? new Map<string, TrackedRun>();
		const tasks = this.snapshotTasksByAgent.get(agentId);
		for (const [id, task] of tasks ?? []) {
			if (now - task.updatedAt < LIMITS.snapshotStaleMs) continue;
			tasks?.delete(id);
			// Lost heartbeat only invalidates running status. Failures remain for 30 minutes.
			changed = this.removeTaskRunning(runs, id) || changed;
		}
		for (const [file, run] of runs) {
			const ttl = run.status === "error" ? LIMITS.errorTtlMs : LIMITS.runningTtlMs;
			if (now - run.updatedAt < ttl) continue;
			runs.delete(file);
			changed = true;
		}
		if (!runs.size) this.runsByAgent.delete(agentId);
		this.dropEmptyTasks(agentId, runs);
		return changed;
	}

	private removeTaskRunning(runs: Map<string, TrackedRun>, workflowRunId: string): boolean {
		let changed = false;
		for (const [file, run] of runs) {
			if (run.status === "error" || (run.snapshotRunId !== workflowRunId && run.workflowRunId !== workflowRunId)) continue;
			runs.delete(file);
			changed = true;
		}
		return changed;
	}

	private hasLiveSnapshotTask(agentId: string, workflowRunId: string, now: number): boolean {
		const task = this.snapshotTasksByAgent.get(agentId)?.get(workflowRunId);
		return task !== undefined && now - task.updatedAt < LIMITS.snapshotStaleMs;
	}

	private writeRun(runs: Map<string, TrackedRun>, run: TrackedRun): boolean {
		const previous = runs.get(run.sessionFile);
		const changed = !previous || previous.status !== run.status || previous.agent !== run.agent;
		runs.delete(run.sessionFile);
		runs.set(run.sessionFile, run);
		return changed;
	}

	private settle(agentId: string, runs: Map<string, TrackedRun>, changed: boolean): boolean {
		while (runs.size > LIMITS.maxRunsPerAgent) {
			const oldest = runs.keys().next().value;
			if (oldest === undefined) break;
			runs.delete(oldest);
			changed = true;
		}
		if (runs.size) this.runsByAgent.set(agentId, runs);
		else this.runsByAgent.delete(agentId);
		this.dropEmptyTasks(agentId, runs);
		this.updateExpiry(agentId);
		return changed;
	}

	private dropEmptyTasks(agentId: string, runs: Map<string, TrackedRun>): void {
		const tasks = this.snapshotTasksByAgent.get(agentId);
		if (!tasks) return;
		const owners = new Set([...runs.values()].map((run) => run.snapshotRunId));
		for (const id of tasks.keys()) if (!owners.has(id)) tasks.delete(id);
		if (!tasks.size) this.snapshotTasksByAgent.delete(agentId);
	}

	private updateExpiry(agentId: string): void {
		if (!this.expiry) return;
		let deadline = Infinity;
		for (const task of this.snapshotTasksByAgent.get(agentId)?.values() ?? []) deadline = Math.min(deadline, task.updatedAt + LIMITS.snapshotStaleMs);
		for (const run of this.runsByAgent.get(agentId)?.values() ?? []) deadline = Math.min(deadline, run.updatedAt + (run.status === "error" ? LIMITS.errorTtlMs : LIMITS.runningTtlMs));
		this.expiry.schedule(agentId, Number.isFinite(deadline) ? deadline : undefined);
	}
}
