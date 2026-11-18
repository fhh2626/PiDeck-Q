/**
 * `bg_wait` tool: block the current turn until outstanding async or
 * remembered detached foreground work finishes.
 *
 * Background subagent runs are detached. In an interactive session the parent
 * can end its turn and Pi will wake it with a completion notification. That
 * does not work when the parent is a skill that must run to completion, and it
 * cannot work at all non-interactively (`pi -p ...`), where the run is a single
 * turn: once the turn ends there is nothing left to receive the notification.
 *
 * `bg_wait` closes that gap. It keeps the turn alive until a tracked async
 * run for this session reaches a terminal state (complete / failed / paused),
 * the caller-supplied timeout elapses, or the turn is aborted. Because it awaits
 * inside the turn, the completion the model was told to wait for is actually
 * observed before the tool returns.
 *
 * By default `bg_wait` returns as soon as ONE run finishes, so a fleet
 * manager can use it in a rolling-replacement loop: launch N workers, wait for
 * the next one to finish, spawn its replacement, then call `bg_wait`
 * again — keeping N in flight instead of draining to zero between batches.
 * Pass `all: true` to block until every initially tracked run is terminal, or `id`
 * to block on one specific async or remembered detached foreground run.
 *
 * `bg_wait` also returns when a run needs attention — not just on
 * completion. A child that goes idle or blocks for a decision surfaces
 * `needs_attention` (the same signal Pi shows as a control notice and,
 * interactively, wakes the parent with). Since `bg_wait` is used exactly
 * where there is no next turn to receive that notice, it must break on it too,
 * or a stuck child would stall the loop until the timeout. Attention runs are
 * reported so the caller can inspect / nudge / resume / interrupt them.
 *
 * Wake mechanism: when given Pi's event bus (`deps.events`), `bg_wait`
 * subscribes to the subagent completion/control channels and wakes the instant
 * any fires, rather than waiting out a fixed poll interval. A poll still runs
 * on the interval as a reconciliation fallback (crashed runners, missed
 * events), and the poll is the source of truth for what actually changed — the
 * event only ends the sleep early. With no bus, `bg_wait` degrades to pure
 * polling.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ForegroundWorkflowContinuation } from "../foreground/workflow-handoff.ts";
import {
	listBackgroundWorkWakeChannels,
	snapshotBackgroundWork,
	type BackgroundWorkSnapshot,
	type RegisteredBackgroundWorkItem,
} from "../../api/background-work.ts";
import { formatAsyncRunList, listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";
import {
	DIRS,
	INTERCOM_DETACH_REQUEST_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type Details,
	type ForegroundResumeRun,
	type SubagentState,
	type Usage,
	type WaitCompletion,
} from "../../shared/types.ts";
import { formatDuration, shortenPath } from "../../shared/formatters.ts";
import { toAgentToolUsage } from "../../shared/utils.ts";
import { collectWaitCompletions } from "./wait-completions.ts";
import { formatResumeFirstFailedRunsNote } from "./resume-guidance.ts";
import { formatTimeoutRecoveryLines } from "../shared/mutation-evidence.ts";
import {
	activeDetachedForegroundRuns,
	captureDetachedForegroundWaitTargets,
	detachedForegroundWaitStatus,
	formatForegroundAttention,
	snapshotDetachedForegroundWait,
	summarizeForegroundChildren,
} from "./foreground-wait.ts";
export { WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV, WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, type ResolvedWaitToolConfig } from "./wait-config.ts";

/** States that mean a run is still in flight (not yet resolved). */
const ACTIVE_STATES: ReadonlyArray<AsyncRunSummary["state"]> = ["queued", "running"];

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface SubagentWaitParams {
	/** Optional run id/prefix to wait for. When omitted, waits across every active run in this session. */
	id?: string;
	/** Arm a durable exact-run wake subscription and return immediately. Requires id. */
	nonBlocking?: boolean;
	/**
	 * When true, block until EVERY active run in this session (or matching `id`)
	 * is terminal. Default false: return when the first tracked run or provider
	 * item finishes or needs attention. Ignored when `id` targets a single run.
	 */
	all?: boolean;
	/** Give up after this many milliseconds. Defaults to waitTool.defaultTimeoutMs, then 30 minutes. */
	timeoutMs?: number;
	/** False keeps a blocking wait open through idle attention; supervisor/contact requests still stop the wait. */
	stopOnAttention?: boolean;
}

/** Minimal event-bus surface wait subscribes to (matches pi.events). */
export interface WaitEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface SubagentWaitDeps {
	state: SubagentState;
	/** Runtime supervision asks are independent of whichever tool the child is executing. */
	findPendingAsks?: (target: { runId: string; agent: string; childIndex: number }) => readonly string[];
	/** Stream live wait status into Pi's pending tool row. */
	onUpdate?: (result: AgentToolResult<Details>) => void;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	pollIntervalMs?: number;
	/** False makes the tool return immediately without blocking active async runs. */
	enabled?: boolean;
	/** Configured blocking window used when the call omits timeoutMs. */
	defaultTimeoutMs?: number;
	/** Injectable sleep for tests. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Internal auto-drain mode waits through needs-attention states. */
	stopOnAttention?: boolean;
	/** Internal auto-drain mode surfaces failed terminal subagent runs as errors. */
	failOnFailedRuns?: boolean;
	/** Internal auto-drain mode surfaces actionable attention as an error. */
	failOnAttention?: boolean;
	/** Arm a durable exact-target wait subscription in a long-lived interactive runtime. */
	subscribe?: (input: { targetKind: "async" | "foreground"; runId: string; requestedId: string; timeoutMs: number }) => { token: string; expiresAt: number };
	/** Injectable provider protocol surfaces for deterministic tests. */
	backgroundWork?: {
		snapshot(sessionId: string, nowMs: number): BackgroundWorkSnapshot;
		wakeChannels(): readonly string[];
	};
	/**
	 * Optional event bus (pi.events). When provided, wait wakes immediately on a
	 * subagent completion/control event instead of waiting out the poll interval;
	 * the poll then remains as a reconciliation fallback (crashed runners, missed
	 * events). Omit in tests that want pure poll behavior.
	 */
	events?: WaitEventBus;
}

/** Bus channels that indicate a run changed state or needs attention. */
const WAKE_CHANNELS = [
	INTERCOM_DETACH_REQUEST_EVENT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
];

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Sleep up to `ms`, but wake early if a subagent event fires on the bus (or the
 * turn aborts). Returns when the first of those happens. With no bus this is a
 * plain sleep, so the poll interval alone drives progress.
 */
function waitForWake(ms: number, signal: AbortSignal | undefined, deps: SubagentWaitDeps): Promise<void> {
	const sleep = deps.sleep ?? defaultSleep;
	const events = deps.events;
	if (!events) return sleep(ms, signal);
	const providerChannels = deps.backgroundWork?.wakeChannels() ?? listBackgroundWorkWakeChannels();
	return new Promise((resolve, reject) => {
		let settled = false;
		const unsubs: Array<() => void> = [];
		const wakeController = new AbortController();
		const done = () => {
			if (settled) return;
			settled = true;
			wakeController.abort();
			signal?.removeEventListener("abort", done);
			for (const u of unsubs) {
				try { u(); } catch { /* best effort */ }
			}
			resolve();
		};
		if (signal?.aborted) {
			done();
			return;
		}
		signal?.addEventListener("abort", done, { once: true });
		try {
			for (const channel of [...new Set([...WAKE_CHANNELS, ...providerChannels])]) {
				unsubs.push(events.on(channel, done));
			}
		} catch (error) {
			signal?.removeEventListener("abort", done);
			for (const unsubscribe of unsubs) {
				try { unsubscribe(); } catch { /* best effort cleanup */ }
			}
			reject(error);
			return;
		}
		// Poll-interval fallback so we still reconcile even if no event arrives.
		// The local signal cancels that fallback timer when an event wakes us first.
		void sleep(ms, wakeController.signal).then(done);
	});
}

function matchesId(run: AsyncRunSummary, id: string): boolean {
	return run.id === id || run.id.startsWith(id);
}

/** A running run that has flagged it needs the parent's attention. */
function needsAttention(run: AsyncRunSummary): boolean {
	return run.activityState === "needs_attention" || run.steps.some((step) => step.activityState === "needs_attention");
}

function hasSupervisorTool(run: AsyncRunSummary): boolean {
	return run.currentTool === "contact_supervisor"
		|| run.currentTool === "intercom"
		|| run.steps.some((step) => step.currentTool === "contact_supervisor" || step.currentTool === "intercom");
}

/** Native run reviews can arrive during a normal long tool call without changing its status. */
function hasPendingSupervisorAsk(run: AsyncRunSummary, deps: SubagentWaitDeps): boolean {
	return run.steps.some((step) => (deps.findPendingAsks?.({
		// Workflow rows reference independently launched single children. Their row index
		// belongs to the workflow display, while the referenced child's own index is zero.
		runId: step.runId ?? run.id, agent: step.agent, childIndex: step.runId && step.runId !== run.id ? 0 : step.index,
	}).length ?? 0) > 0);
}

function backgroundWorkIdentity(item: RegisteredBackgroundWorkItem): string {
	return `${item.provider}\0${item.sessionId}\0${item.id}`;
}

function backgroundWorkForSession(deps: SubagentWaitDeps, nowMs: number): BackgroundWorkSnapshot {
	const sessionId = deps.state.currentSessionId;
	if (!sessionId) throw new Error("bg_wait requires an active session identity to scope background work safely.");
	return deps.backgroundWork?.snapshot(sessionId, nowMs) ?? snapshotBackgroundWork(sessionId, nowMs);
}

/** Queued/running runs from this session, including runs that need attention. */
function activeRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? DIRS.async;
	const resultsDir = deps.resultsDir ?? DIRS.results;
	const runs = listAsyncRuns(asyncDirRoot, {
		states: [...ACTIVE_STATES],
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
		includeNested: false,
		...(params.id ? { runId: params.id } : {}),
	});
	return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
}

/** Runs (from the initial set) currently flagged needs_attention, for reporting. */
function attentionRunsForSession(params: SubagentWaitParams, deps: SubagentWaitDeps, initialIds: Set<string>): AsyncRunSummary[] {
	return activeRunsForSession(params, deps).filter((run) => initialIds.has(run.id) && (needsAttention(run) || hasPendingSupervisorAsk(run, deps)));
}

/** Exact initial runs in any state, for the final summary. */
function runsForIds(runIds: Iterable<string>, deps: SubagentWaitDeps): AsyncRunSummary[] {
	const asyncDirRoot = deps.asyncDirRoot ?? DIRS.async;
	const resultsDir = deps.resultsDir ?? DIRS.results;
	return [...runIds].flatMap((runId) => listAsyncRuns(asyncDirRoot, {
		sessionId: deps.state.currentSessionId ?? undefined,
		resultsDir,
		kill: deps.kill,
		now: deps.now,
		includeNested: false,
		runId,
		exactRunId: true,
	}));
}

function summarizeTerminalRuns(runs: AsyncRunSummary[], providerFinishedCount = 0): string {
	if (runs.length === 0 && providerFinishedCount === 0) return "";
	const counts = { complete: 0, failed: 0, paused: 0 } as Record<string, number>;
	for (const run of runs) {
		const count = counts[run.state];
		if (count !== undefined) counts[run.state] = count + 1;
	}
	const parts: string[] = [];
	if (counts.complete) parts.push(`${counts.complete} complete`);
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.paused) parts.push(`${counts.paused} paused`);
	if (providerFinishedCount > 0) parts.push(`${providerFinishedCount} provider item(s) finished`);
	return parts.join(", ");
}

function completionUsage(completions: WaitCompletion[] | undefined): Usage | undefined {
	if (!completions?.length) return undefined;
	const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	let projected = false;
	for (const completion of completions) {
		for (const child of completion.results ?? []) {
			if (!child.usage || (child.usage.input === 0 && child.usage.output === 0 && child.usage.cacheRead === 0 && child.usage.cacheWrite === 0 && child.usage.cost === 0 && child.usage.turns === 0)) continue;
			projected = true;
			usage.input += child.usage.input;
			usage.output += child.usage.output;
			usage.cacheRead += child.usage.cacheRead;
			usage.cacheWrite += child.usage.cacheWrite;
			usage.cost += child.usage.cost;
			usage.turns += child.usage.turns;
		}
	}
	return projected ? usage : undefined;
}

function result(text: string, isError = false, completions?: WaitCompletion[]): AgentToolResult<Details> {
	const usage = completionUsage(completions);
	for (const completion of completions ?? []) {
		if (completion.workflowReceiptPath) text += `\nWorkflow receipt [${completion.runId}]: ${completion.workflowReceiptPath}`;
	}
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		...(usage ? { usage: toAgentToolUsage(usage) } : {}),
		details: {
			mode: "management",
			results: [],
			...(completions && completions.length > 0 ? { completions } : {}),
		},
	};
}

/** Merge retained VM output without discarding async completions, usage, or failure policy. */
function appendWorkflowResults(response: AgentToolResult<Details>, workflows: readonly ForegroundWorkflowContinuation[]): AgentToolResult<Details> {
	return { ...response,
		content: [...response.content, ...workflows.flatMap((run) => run.result?.content ?? (run.requests.size > 0 ? run.snapshot().content : []))],
		details: { ...response.details, results: [...response.details.results, ...workflows.flatMap((run) => run.result?.details.results ?? [])] },
	};
}

function formatCompletionRecovery(completions: WaitCompletion[] | undefined): string {
	const lines = (completions ?? []).flatMap((completion) =>
		(completion.results ?? []).flatMap((child) => formatTimeoutRecoveryLines(child.timeoutRecovery)));
	return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

function windowElapsedResult(
	text: string,
	activeRunIds: string[],
	activeProviderItems: readonly RegisteredBackgroundWorkItem[] = [],
): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		details: {
			mode: "management",
			results: [],
			wait: {
				reason: "window_elapsed",
				timedOut: true,
				activeRunIds,
				activeProviderItems: activeProviderItems.map(({ provider, id }) => ({ provider, id })),
			},
		},
	};
}

/** Build the live status shown while async work keeps bg_wait blocked. */
function asyncWaitUpdate(runs: AsyncRunSummary[], providerCount: number, elapsedMs: number): AgentToolResult<Details> {
	const activity = runs.flatMap((run) => {
		const activeSteps = run.steps.filter((step) => step.status === "pending" || step.status === "running");
		if (activeSteps.length === 0) {
			return [`${run.id}: ${run.state}`];
		}
		return activeSteps.map((step) => {
			const current = step.currentTool ?? (step.status === "pending" ? "queued" : "thinking…");
			return `${step.agent}: ${current}${step.currentPath ? ` ${shortenPath(step.currentPath)}` : ""}`;
		});
	});
	const headline = [
		`Waiting ${formatDuration(elapsedMs)} for ${runs.length} async run(s) and ${providerCount} provider item(s).`,
		...activity,
	].join(" · ");
	return result([headline, runs.length > 0 ? formatAsyncRunList(runs) : ""].filter(Boolean).join("\n"));
}

/**
 * Block until the targeted async or remembered detached foreground run finishes,
 * the timeout elapses, or the turn is aborted. Resolves with a short
 * human-readable summary either way.
 */
export async function waitForSubagents(
	params: SubagentWaitParams,
	signal: AbortSignal | undefined,
	deps: SubagentWaitDeps,
): Promise<AgentToolResult<Details>> {
	if (deps.enabled === false) {
		return result("bg_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED; returning immediately without blocking background work. Active work keeps going, and you can inspect subagents with subagent({ action: \"status\" }) or rely on completion notifications.");
	}
	if (!deps.state.currentSessionId) {
		return result("bg_wait requires an active session identity to scope background work safely.", true);
	}

	const now = deps.now ?? Date.now;
	const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
	const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0
		? params.timeoutMs
		: deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const startedAt = now();
	const ownerSessionId = deps.state.currentSessionId;
	const waitForAll = params.id ? true : params.all === true;
	if (params.nonBlocking && !params.id) {
		return result("Non-blocking wait subscriptions require id so the registration can bind one exact run identity.", true);
	}
	if (params.nonBlocking && params.all) {
		return result("nonBlocking cannot be combined with all; subscribe to one exact run id.", true);
	}

	// A handoff is still a foreground VM, not an async runner. Track it alongside existing work
	// so both targeted waits and all:true can yield immediately on a new supervisor decision.
	let workflows = [...(deps.state.foregroundWorkflows?.values() ?? [])].filter((run) => run.sessionId === deps.state.currentSessionId && (!run.result || params.id !== undefined)
		&& (!params.id || run.runId.startsWith(params.id)));
	let active: AsyncRunSummary[];
	let foreground: ForegroundResumeRun[];
	let providerSnapshot: BackgroundWorkSnapshot;
	try {
		active = activeRunsForSession(params, deps);
		foreground = activeDetachedForegroundRuns(deps.state, params.id);
		if (!params.id) {
			// Workflow children are already covered by their retained root. Counting a child
			// separately would make a rolling wait finish before the workflow's later stages.
			const workflowRoots = new Set([...workflows.map((run) => run.runId), ...active.map((run) => run.id)]);
			foreground = foreground.filter((run) => {
				const parentId = deps.state.foregroundControls.get(run.runId)?.parentWorkflowRunId;
				return !parentId || !workflowRoots.has(parentId);
			});
		}
		providerSnapshot = params.id ? { providers: [], items: [] } : backgroundWorkForSession(deps, startedAt);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	if (params.id) {
		const candidates = [
			...workflows.map((run) => ({ kind: "workflow" as const, id: run.runId, run })),
			...active.map((run) => ({ kind: "async" as const, id: run.id, run })),
			...foreground.map((run) => ({ kind: "foreground" as const, id: run.runId, run })),
		];
		const exact = candidates.filter((candidate) => candidate.id === params.id);
		const matches = exact.length > 0 ? exact : candidates;
		if (matches.length > 1) {
			return result(`Ambiguous subagent run id prefix "${params.id}" matched ${matches.length} active runs: ${matches.map((candidate) => candidate.id).join(", ")}. Pass a longer id.`, true);
		}
		const selected = matches[0];
		if (selected?.kind === "workflow" && params.nonBlocking) {
			return result(`Foreground workflow ${selected.id} already publishes a completion notification. Use status or blocking bg_wait({ id: "${selected.id}" }); no second subscription was created.`);
		}
		if (selected && selected.kind !== "workflow" && params.nonBlocking) {
			if (!deps.subscribe) {
				return result("Non-blocking wait subscriptions require a long-lived interactive subagent runtime; this runtime can only use blocking bg_wait calls.", true);
			}
			try {
				const registration = deps.subscribe({ targetKind: selected.kind, runId: selected.id, requestedId: params.id, timeoutMs });
				return result(`Armed wait subscription ${registration.token} for exact ${selected.kind} run ${selected.id}. Returning immediately; this session will be woken on completion, failure, attention, reconciliation failure, or timeout. Inspect armed subscriptions with subagent({ action: "status" }).`);
			} catch (error) {
				return result(error instanceof Error ? error.message : String(error), true);
			}
		}
		foreground = selected?.kind === "foreground" ? [selected.run] : [];
		active = selected?.kind === "async" ? [selected.run] : [];
		workflows = selected?.kind === "workflow" ? [selected.run] : [];
		if (selected?.kind === "workflow" && selected.run.result) return selected.run.snapshot();
	}

	let providerActive = providerSnapshot.items;
	if (active.length === 0 && providerActive.length === 0 && workflows.length === 0 && foreground.length === 0) {
		return result(params.id
			? `No active run matched "${params.id}". Nothing to wait for.`
			: "No active async runs, detached foreground runs, workflows, or registered provider work in this session. Nothing to wait for.");
	}
	const waitParams = params.id && active[0] ? { ...params, id: active[0].id } : params;
	const initialAsyncIds = new Set(active.map((run) => run.id));
	const initialProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
	const initialProviderNames = new Set(providerActive.map((item) => item.provider));
	const foregroundTargets = captureDetachedForegroundWaitTargets(foreground, ownerSessionId);
	let foregroundSnapshots = snapshotDetachedForegroundWait(foregroundTargets, deps.state, deps.findPendingAsks);
	const initialCount = initialAsyncIds.size + initialProviderIds.size + workflows.length + foregroundTargets.length;
	const stopOnAttention = params.stopOnAttention ?? deps.stopOnAttention !== false;
	let attention = active.filter((run) => needsAttention(run) || hasPendingSupervisorAsk(run, deps));

	const isDone = (): boolean => {
		if (workflows.some((run) => run.requests.size > 0)) return true;
		if (foregroundSnapshots.some((snapshot) => snapshot.attention.length > 0)) return true;
		if (attention.some((run) => initialAsyncIds.has(run.id) && (stopOnAttention || hasSupervisorTool(run) || hasPendingSupervisorAsk(run, deps)))) return true;
		const activeAsyncIds = new Set(active.map((run) => run.id));
		const activeProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
		if (waitForAll) {
			return [...initialAsyncIds].every((id) => !activeAsyncIds.has(id))
				&& [...initialProviderIds].every((id) => !activeProviderIds.has(id))
				&& workflows.every((run) => run.result !== undefined)
				&& foregroundSnapshots.every((snapshot) => !snapshot.pending);
		}
		return [...initialAsyncIds].some((id) => !activeAsyncIds.has(id))
			|| [...initialProviderIds].some((id) => !activeProviderIds.has(id))
			|| workflows.some((run) => run.result !== undefined)
			|| foregroundSnapshots.some((snapshot) => !snapshot.pending);
	};

	while (!isDone()) {
		if (deps.state.currentSessionId !== ownerSessionId) return result("Wait stopped because the originating session is no longer active.", true);
		if (workflows.some((run) => run.sessionId !== deps.state.currentSessionId)) return result("Wait stopped because the originating foreground workflow session is no longer active.", true);
		const activeInitialRuns = active.filter((run) => initialAsyncIds.has(run.id));
		const activeInitialProviderItems = providerActive.filter((item) => initialProviderIds.has(backgroundWorkIdentity(item)));
		const activeForeground = foregroundSnapshots.filter((snapshot) => snapshot.pending);
		const stillActive = [
			...activeInitialRuns.map((run) => `${run.id} (${run.state})`),
			...activeInitialProviderItems.map((item) => `${item.provider}/${item.id}`),
			...workflows.filter((run) => !run.result).map((run) => `${run.runId} (foreground workflow)`),
			...activeForeground.map((snapshot) => `${snapshot.run.runId} (detached foreground)`),
		].join(", ");
		if (deps.onUpdate) {
			const updateNow = now();
			const update = asyncWaitUpdate(activeInitialRuns, activeInitialProviderItems.length, updateNow - startedAt);
			update.content.push(...activeForeground.map((snapshot) => ({ type: "text" as const,
				text: detachedForegroundWaitStatus(snapshot.run, snapshot.indices, updateNow, updateNow - startedAt),
			})));
			deps.onUpdate(update);
		}
		if (signal?.aborted) {
			return result(`Wait aborted after ${formatDuration(now() - startedAt)}. Still active: ${stillActive}.`, true);
		}
		if (now() - startedAt >= timeoutMs) {
			return windowElapsedResult(
				`Wait window elapsed after ${formatDuration(timeoutMs)} with ${activeInitialRuns.length} async run(s) and ${activeInitialProviderItems.length} provider item(s) still active: ${stillActive}. The work keeps going; call bg_wait again or inspect subagent status.`,
				[...activeInitialRuns.map((run) => run.id), ...workflows.filter((run) => !run.result).map((run) => run.runId), ...activeForeground.map((snapshot) => snapshot.run.runId)],
				activeInitialProviderItems,
			);
		}
		try {
			await waitForWake(pollIntervalMs, signal, deps);
			if (deps.state.currentSessionId !== ownerSessionId) return result("Wait stopped because the originating session is no longer active.", true);
			foregroundSnapshots = snapshotDetachedForegroundWait(foregroundTargets, deps.state, deps.findPendingAsks, foregroundSnapshots);
			active = activeRunsForSession(waitParams, deps);
			attention = attentionRunsForSession(waitParams, deps, initialAsyncIds);
			providerSnapshot = params.id ? providerSnapshot : backgroundWorkForSession(deps, now());
			for (const provider of initialProviderNames) {
				if (!providerSnapshot.providers.includes(provider)) {
					return result(`Background-work provider '${provider}' disappeared while bg_wait was tracking its active work; completion cannot be confirmed.`, true);
				}
			}
			providerActive = providerSnapshot.items;
		} catch (error) {
			return result(error instanceof Error ? error.message : String(error), true);
		}
	}

	if (deps.state.currentSessionId !== ownerSessionId) return result("Wait stopped because the originating session is no longer active.", true);
	if (workflows.some((run) => run.sessionId !== deps.state.currentSessionId)) return result("Wait stopped because the originating foreground workflow session is no longer active.", true);
	const workflowAttention = workflows.filter((run) => run.requests.size > 0);
	const foregroundAttention = foregroundSnapshots.filter((snapshot) => snapshot.attention.length > 0);
	if (params.id && foregroundSnapshots[0]) {
		const snapshot = foregroundSnapshots[0];
		return result(snapshot.attention.length > 0
			? formatForegroundAttention(snapshot, now() - startedAt)
			: `Waited ${formatDuration(now() - startedAt)} for remembered detached foreground run "${snapshot.run.runId}"; done. Outcome: ${summarizeForegroundChildren(snapshot.run, snapshot.indices)}. Completion event observed; inspect with subagent({ action: "status", id: "${snapshot.run.runId}" }) for recovered output.`,
			(deps.failOnFailedRuns === true && snapshot.failed) || (deps.failOnAttention === true && snapshot.attention.length > 0));
	}
	if (workflowAttention[0] && initialAsyncIds.size === 0 && initialProviderIds.size === 0 && foregroundTargets.length === 0) return { ...workflowAttention[0].snapshot(), ...(deps.failOnAttention ? { isError: true } : {}) };
	if (params.id && workflows[0]?.result) return workflows[0].snapshot();
	if (workflows.length > 0 && initialAsyncIds.size === 0 && initialProviderIds.size === 0 && foregroundTargets.length === 0) {
		return { content: workflows.flatMap((run) => run.snapshot().content), isError: workflows.some((run) => run.result?.isError), details: { mode: "workflow", results: workflows.flatMap((run) => run.result?.details.results ?? []) } };
	}
	let terminalSummary: string;
	let finishedAsyncCount: number;
	let failedAsyncCount: number;
	let completions: WaitCompletion[] | undefined;
	let resumeGuidance = "";
	const activeProviderIds = new Set(providerActive.map(backgroundWorkIdentity));
	const providerFinishedCount = [...initialProviderIds].filter((id) => !activeProviderIds.has(id)).length;
	try {
		const allNow = runsForIds(initialAsyncIds, deps);
		const terminal = allNow.filter((run) => !ACTIVE_STATES.includes(run.state) && initialAsyncIds.has(run.id));
		finishedAsyncCount = terminal.length;
		failedAsyncCount = terminal.filter((run) => run.state === "failed" || run.state === "partial").length;
		terminalSummary = summarizeTerminalRuns(terminal, providerFinishedCount);
		resumeGuidance = formatResumeFirstFailedRunsNote(terminal);
		completions = collectWaitCompletions(terminal, deps.state, deps.resultsDir ?? DIRS.results);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}

	const relevantAttention = attention.filter((run) => initialAsyncIds.has(run.id));
	const supervisorAttentionHint = relevantAttention.some((run) => hasSupervisorTool(run) || hasPendingSupervisorAsk(run, deps))
		? " Reply to any pending supervisor request. If subagent_supervisor({ action: \"pending\" }) is empty, check intercom({ action: \"pending\" }) because an external intercom tool may own the request."
		: "";
	const attentionNote = relevantAttention.length > 0
		? ` ${relevantAttention.length} run(s) need attention: ${relevantAttention.map((run) => run.id).join(", ")}.${supervisorAttentionHint}${supervisorAttentionHint
			? " Answer the pending request, then wait again or inspect status. Do not resume or launch a replacement while the child is still live."
			: ' Inspect with subagent({ action: "status" }), then steer a top-level live async child, resume a paused/completed/failed child, or interrupt explicitly.'}`
		: "";
	const stillRunning = active.filter((run) => initialAsyncIds.has(run.id)).length
		+ providerActive.filter((item) => initialProviderIds.has(backgroundWorkIdentity(item))).length
		+ workflows.filter((run) => !run.result).length
		+ foregroundSnapshots.filter((snapshot) => snapshot.pending).length;
	const elapsed = formatDuration(now() - startedAt);
	const workflowSummary = workflows.map((run) => `Foreground workflow ${run.runId}: ${run.result ? run.result.isError ? "failed" : "complete" : run.requests.size > 0 ? "needs_attention" : "running"}; inspect status for output.`).join(" ");
	const foregroundSummary = foregroundSnapshots.map((snapshot) => snapshot.attention.length > 0
		? formatForegroundAttention(snapshot, now() - startedAt)
		: `Detached foreground run ${snapshot.run.runId}: ${snapshot.pending ? "running" : summarizeForegroundChildren(snapshot.run, snapshot.indices)}; inspect status for recovered output.`).join(" ");
	const outcome = `${terminalSummary ? ` Outcome: ${terminalSummary}.` : ""}${workflowSummary ? ` ${workflowSummary}` : ""}${foregroundSummary ? ` ${foregroundSummary}` : ""}`;
	const recoveryNote = formatCompletionRecovery(completions);
	const attentionCount = relevantAttention.length + workflowAttention.length + foregroundAttention.length;
	const failed = failedAsyncCount > 0 || workflows.some((run) => run.result?.isError) || foregroundSnapshots.some((snapshot) => snapshot.failed);
	const isError = (deps.failOnFailedRuns === true && failed) || (deps.failOnAttention === true && attentionCount > 0);

	if (waitForAll) {
		const scope = params.id
			? `run "${params.id}"`
			: `${initialAsyncIds.size} async run(s)${workflows.length ? ` and ${workflows.length} foreground workflow(s)` : ""}${foregroundTargets.length ? ` and ${foregroundTargets.length} detached foreground run(s)` : ""}${initialProviderIds.size ? ` and ${initialProviderIds.size} provider item(s)` : ""}`;
		const status = attentionCount > 0 ? "attention required" : "done";
		return appendWorkflowResults(result(
			`Waited ${elapsed} for ${scope}; ${status}.${outcome}${recoveryNote}${resumeGuidance}${attentionNote} Completion/control events have been observed; inspect status if a notification is not visible yet.`,
			isError,
			completions,
		), workflows);
	}

	const finishedCount = finishedAsyncCount + providerFinishedCount + workflows.filter((run) => run.result).length + foregroundSnapshots.filter((snapshot) => !snapshot.pending).length;
	const subject = initialProviderIds.size === 0 ? "run(s)" : "item(s)";
	const remainder = stillRunning > 0
		? ` ${stillRunning} ${subject} still in flight — call bg_wait again to catch the next one.`
		: attentionCount > 0
			? " No other work is waitable until attention is handled."
			: initialProviderIds.size === 0 ? " No runs remain in flight." : " No work remains in flight.";
	const progress = attentionCount > 0 && finishedCount === 0
		? `${attentionCount} of ${initialCount} ${subject} need attention`
		: `${finishedCount} of ${initialCount} ${subject} finished`;
	return appendWorkflowResults(result(
		`Waited ${elapsed}; ${progress}.${outcome}${recoveryNote}${resumeGuidance}${attentionNote}${remainder} Relevant completion/control events have been observed; inspect status if a notification is not visible yet.`,
		isError,
		completions,
	), workflows);
}
