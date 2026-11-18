/** Session-scoped snapshots and live status for remembered detached foreground work. */
import * as fs from "node:fs";
import type { ForegroundResumeRun, SubagentState } from "../../shared/types.ts";
import { formatDuration } from "../../shared/formatters.ts";

export type FindPendingForegroundAsks = (target: { runId: string; agent: string; childIndex: number }) => readonly string[];

export interface DetachedForegroundWaitTarget {
	runId: string;
	sessionId: string;
	children: Map<number, string>;
}

export interface DetachedForegroundWaitSnapshot {
	run: ForegroundResumeRun;
	indices: Set<number>;
	pending: boolean;
	failed: boolean;
	attention: ForegroundResumeRun["children"];
}

/** Resolve only active work owned by this session, optionally matching a public run prefix. */
export function activeDetachedForegroundRuns(state: SubagentState, id?: string): ForegroundResumeRun[] {
	const sessionId = state.currentSessionId;
	if (!sessionId) return [];
	return [...(state.foregroundRuns?.values() ?? [])].filter((run) =>
		(!id || run.runId.startsWith(id))
		&& run.sessionId === sessionId
		&& run.children.some((child) => child.status === "detached")
	);
}

/** Capture exact initial child identities so later launches cannot extend a wait's scope. */
export function captureDetachedForegroundWaitTargets(runs: readonly ForegroundResumeRun[], sessionId: string): DetachedForegroundWaitTarget[] {
	return runs.map((run) => ({ runId: run.runId, sessionId,
		children: new Map(run.children.filter((child) => child.status === "detached").map((child) => [child.index, child.agent])),
	}));
}

/** Missing ownership or child records cannot be interpreted as successful completion. */
export function snapshotDetachedForegroundWait(
	targets: readonly DetachedForegroundWaitTarget[], state: SubagentState, findPendingAsks?: FindPendingForegroundAsks,
	previous: readonly DetachedForegroundWaitSnapshot[] = [],
): DetachedForegroundWaitSnapshot[] {
	// Bounded foreground history can evict a completed run while another initial run remains
	// active. Keep already observed terminal evidence for this wait instead of reading it again.
	const settled = new Map(previous.filter((snapshot) => !snapshot.pending).map((snapshot) => [snapshot.run.runId, snapshot]));
	return targets.map((target) => {
		const completed = settled.get(target.runId);
		if (completed) return completed;
		const run = state.foregroundRuns?.get(target.runId);
		if (!run || run.sessionId !== target.sessionId) {
			throw new Error(`Remembered foreground run "${target.runId}" disappeared before a terminal child result was recorded. Completion cannot be confirmed; inspect the originating child session before launching a replacement.`);
		}
		const children = [...target.children].map(([index, agent]) => {
			const child = run.children.find((candidate) => candidate.index === index && candidate.agent === agent);
			if (!child) throw new Error(`Remembered foreground child "${target.runId}#${index}" disappeared before a terminal result was recorded. Completion cannot be confirmed; inspect the originating child session before launching a replacement.`);
			return child;
		});
		const pending = children.filter((child) => child.status === "detached");
		return { run: pending.length > 0 ? run : { ...run, children: children.map((child) => ({ ...child })) },
			indices: new Set(target.children.keys()), pending: pending.length > 0,
			failed: children.some((child) => child.status === "failed"),
			attention: pending.filter((child) =>
				(child.activityState === "needs_attention" && (child.currentTool === "contact_supervisor" || child.currentTool === "intercom"))
				|| (findPendingAsks?.({ runId: run.runId, agent: child.agent, childIndex: child.index }).length ?? 0) > 0),
		};
	});
}

export function summarizeForegroundChildren(run: ForegroundResumeRun, indices: Set<number>): string {
	const counts = new Map<string, number>();
	for (const child of run.children) {
		if (!indices.has(child.index) || child.status === "detached") continue;
		counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
	}
	return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
}

export function formatForegroundAttention(snapshot: DetachedForegroundWaitSnapshot, elapsedMs: number): string {
	const childList = snapshot.attention.map((child) => `${child.agent}#${child.index}`).join(", ");
	return `Waited ${formatDuration(elapsedMs)} for remembered detached foreground run "${snapshot.run.runId}"; attention required. ${snapshot.attention.length} child run(s) need attention: ${childList}. Reply to any pending supervisor request, then call bg_wait({ id: "${snapshot.run.runId}" }) again or inspect status; do not resume or launch a replacement while it remains detached.`;
}

/** Headless shutdown must retain both standalone detached children and live workflow VMs. */
export function hasOutstandingForegroundWork(state: SubagentState, sessionId: string): boolean {
	return [...(state.foregroundRuns?.values() ?? [])].some((run) => run.sessionId === sessionId && run.children.some((child) => child.status === "detached"))
		|| [...(state.foregroundWorkflows?.values() ?? [])].some((run) => run.sessionId === sessionId && !run.result);
}

const TRANSCRIPT_TAIL_BYTES = 128 * 1024;
const TRANSCRIPT_PREVIEW_LINES = 3;
const TRANSCRIPT_PREVIEW_WIDTH = 220;

interface TranscriptActivity {
	currentTool?: string;
	currentToolArgs?: string;
	latestAt?: number;
	recent: string[];
}

function compactTranscriptText(value: unknown, maxWidth = TRANSCRIPT_PREVIEW_WIDTH): string | undefined {
	if (typeof value !== "string") return undefined;
	const compact = value.replace(/\s+/g, " ").trim();
	if (!compact) return undefined;
	return compact.length <= maxWidth ? compact : `${compact.slice(0, Math.max(1, maxWidth - 1))}…`;
}

function readTranscriptActivity(transcriptPath: string | undefined): TranscriptActivity | undefined {
	if (!transcriptPath) return undefined;
	let fd: number | undefined;
	try {
		const stat = fs.statSync(transcriptPath);
		if (!stat.isFile() || stat.size <= 0) return undefined;
		const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
		const length = stat.size - start;
		const buffer = Buffer.allocUnsafe(length);
		fd = fs.openSync(transcriptPath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, length, start);
		let lines = buffer.subarray(0, bytesRead).toString("utf-8").split(/\r?\n/);
		if (start > 0) lines = lines.slice(1); // The first tail line may be partial JSON.

		let currentTool: string | undefined;
		let currentToolArgs: string | undefined;
		let latestAt: number | undefined;
		const recent: string[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue; // Concurrent append can leave the final line temporarily incomplete.
			}
			if (typeof record.ts === "number" && Number.isFinite(record.ts)) latestAt = record.ts;
			if (record.recordType === "tool_start" && typeof record.toolName === "string") {
				currentTool = record.toolName;
				currentToolArgs = compactTranscriptText(record.argsPreview, 140);
				const preview = currentToolArgs ? `${currentTool}: ${currentToolArgs}` : currentTool;
				recent.push(`tool: ${preview}`);
				continue;
			}
			if (record.recordType === "tool_end") {
				currentTool = undefined;
				currentToolArgs = undefined;
				continue;
			}
			if (record.recordType === "message") {
				if (record.sourceEventType === "initial_prompt" || record.role === "user") continue;
				const text = compactTranscriptText(record.text);
				if (text) recent.push(`${typeof record.role === "string" ? record.role : "message"}: ${text}`);
				continue;
			}
			if (record.recordType === "stdout" || record.recordType === "stderr") {
				const text = compactTranscriptText(record.text);
				if (text) recent.push(`${record.recordType}: ${text}`);
			}
		}
		return { currentTool, currentToolArgs, latestAt, recent: recent.slice(-TRANSCRIPT_PREVIEW_LINES) };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* best-effort close */ }
		}
	}
}

export function detachedForegroundWaitStatus(run: ForegroundResumeRun, pendingIndices: Set<number>, nowMs: number, elapsedMs: number): string {
	const lines = [`Waiting for detached foreground run "${run.runId}" · ${formatDuration(elapsedMs)}`];
	for (const child of run.children) {
		if (!pendingIndices.has(child.index) || child.status !== "detached") continue;
		const activity = readTranscriptActivity(child.transcriptPath);
		const age = activity?.latestAt !== undefined ? ` · activity ${formatDuration(Math.max(0, nowMs - activity.latestAt))} ago` : "";
		lines.push(`${child.agent} · working after supervisor handoff${age}`);
		if (activity?.currentTool) {
			lines.push(`  current: ${activity.currentTool}${activity.currentToolArgs ? `: ${activity.currentToolArgs}` : ""}`);
		}
		for (const preview of activity?.recent ?? []) lines.push(`  ${preview}`);
		if (!activity && child.transcriptPath) lines.push("  live transcript has no new activity yet");
		if (!child.transcriptPath) lines.push("  live transcript unavailable; waiting for completion event");
	}
	return lines.join("\n");
}
