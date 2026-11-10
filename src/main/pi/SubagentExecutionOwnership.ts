import type { SubagentStatusSnapshot } from "../../shared/types/subagents";
import { SUBAGENT_RUN_TRACKER_LIMITS as LIMITS } from "./subagentRunLimits";

/** Identifiers are opaque: only first observation orders executions, never lexical id/time order. */
export type SubagentExecutionSource = {
	workflowRunId?: string;
	toolCallId?: string;
	taskKey: string;
	executionId?: string;
};

type Execution = {
	sourceKeys: string[];
	executionId?: string;
	workflowRunId?: string;
	toolCallId?: string;
	snapshotRunId?: string;
	/** A successful/cleared execution stays a tombstone, even though its light is gone. */
	finished: boolean;
};

type SessionOwnership = { executions: Execution[]; current: Execution; updatedAt: number };
type SnapshotFence = { ownerSessionId: string; sequence: number; closed: boolean; updatedAt: number };
type AgentOwnership = { sessions: Map<string, SessionOwnership>; snapshots: Map<string, SnapshotFence> };

/**
 * Bounded execution admission ledger, independent of visible rows.
 *
 * A source/key first seen without runId owns the same attempt when runId arrives later;
 * enriching an old workflow row must not make it newer than a resumed execution. Known
 * retired attempts never reclaim a path, including after success/clear removes the row.
 * Legacy publishers fall back to workflow+taskKey / toolCallId; an id-less update of the
 * same key cannot distinguish another execution, so current publishers include runId.
 */
export class SubagentExecutionOwnership {
	private readonly agents = new Map<string, AgentOwnership>();

	/** Sequence/closed-task fences survive slot cleanup, but do not create live tasks or timers. */
	acceptSnapshot(agentId: string, snapshot: SubagentStatusSnapshot, now: number): boolean {
		this.prune(agentId, now);
		const state = this.state(agentId);
		const previous = state.snapshots.get(snapshot.workflowRunId);
		if (previous && (previous.closed || previous.ownerSessionId !== snapshot.ownerSessionId || snapshot.sequence <= previous.sequence)) return false;
		// Empty unknown slots have no ownership to fence. Do not accumulate empty tasks.
		if (previous || snapshot.children.length > 0) {
			state.snapshots.delete(snapshot.workflowRunId);
			state.snapshots.set(snapshot.workflowRunId, {
				ownerSessionId: snapshot.ownerSessionId, sequence: snapshot.sequence,
				closed: snapshot.complete, updatedAt: now,
			});
			this.cap(state.snapshots, LIMITS.maxSnapshotTasksPerAgent);
		}
		this.dropEmptyAgent(agentId, state);
		return true;
	}

	closeSnapshot(agentId: string, workflowRunId: string): void {
		const fence = this.agents.get(agentId)?.snapshots.get(workflowRunId);
		if (fence) fence.closed = true;
	}

	current(agentId: string, sessionFile: string): Execution | undefined {
		return this.agents.get(agentId)?.sessions.get(sessionFile)?.current;
	}

	/** Resolve aliases before admission; old heartbeats refresh the fence, not the visible row TTL. */
	claim(agentId: string, sessionFile: string, source: SubagentExecutionSource, now: number, allowNew = true): Execution | undefined {
		const state = this.state(agentId);
		let session = state.sessions.get(sessionFile);
		const keys = this.sourceKeys(source);
		const matchesSource = (execution: Execution): boolean => execution.sourceKeys.some((key) => keys.includes(key));
		let execution = source.executionId
			? session?.executions.find((entry) => entry.executionId === source.executionId)
				// This is metadata enrichment, not a new attempt, even if the entry is retired.
				?? session?.executions.find((entry) => !entry.executionId && matchesSource(entry))
			: session?.executions.findLast(matchesSource);
		if (!execution) {
			if (!allowNew) return undefined;
			execution = { sourceKeys: keys, finished: false };
			if (session) {
				session.executions.push(execution);
				session.current = execution;
				if (session.executions.length > LIMITS.maxExecutionsPerSession) session.executions.shift();
			} else {
				session = { executions: [execution], current: execution, updatedAt: now };
			}
		}
		if (!session) return undefined;
		if (source.executionId) execution.executionId = source.executionId;
		if (source.workflowRunId) execution.workflowRunId = source.workflowRunId;
		if (source.toolCallId) execution.toolCallId = source.toolCallId;
		// At most two aliases per producer (workflow id and parent tool id). Keep alias growth bounded too.
		for (const key of keys) if (execution.sourceKeys.length < 4 && !execution.sourceKeys.includes(key)) execution.sourceKeys.push(key);
		session.updatedAt = now;
		state.sessions.delete(sessionFile);
		state.sessions.set(sessionFile, session);
		this.cap(state.sessions, LIMITS.maxRunsPerAgent);
		return session.current === execution ? execution : undefined;
	}

	clearAgent(agentId: string): void { this.agents.delete(agentId); }

	/** Fences expire lazily after 30 minutes without any source; runtime cleanup releases all of them. */
	prune(agentId: string, now: number): void {
		const state = this.agents.get(agentId);
		if (!state) return;
		for (const [file, session] of state.sessions) if (now - session.updatedAt >= LIMITS.errorTtlMs) state.sessions.delete(file);
		for (const [id, fence] of state.snapshots) if (now - fence.updatedAt >= LIMITS.errorTtlMs) state.snapshots.delete(id);
		this.dropEmptyAgent(agentId, state);
	}

	private state(agentId: string): AgentOwnership {
		let state = this.agents.get(agentId);
		if (!state) {
			state = { sessions: new Map(), snapshots: new Map() };
			this.agents.set(agentId, state);
		}
		return state;
	}

	private sourceKeys(source: SubagentExecutionSource): string[] {
		const keys: string[] = [];
		if (source.workflowRunId) keys.push(JSON.stringify(["workflow", source.workflowRunId, source.taskKey]));
		if (source.toolCallId) keys.push(JSON.stringify(["tool", source.toolCallId, source.taskKey]));
		return keys.length ? keys : [JSON.stringify(["legacy", source.taskKey])];
	}

	private cap<T>(entries: Map<string, T>, limit: number): void {
		while (entries.size > limit) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}

	private dropEmptyAgent(agentId: string, state: AgentOwnership): void {
		if (!state.sessions.size && !state.snapshots.size) this.agents.delete(agentId);
	}
}
