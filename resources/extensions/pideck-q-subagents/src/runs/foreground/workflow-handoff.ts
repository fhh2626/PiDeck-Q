/** Keep a foreground workflow live while returning control for supervisor decisions. */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, SUPERVISOR_REQUEST_SETTLED_EVENT, type Details, type IntercomEventBus, type SubagentState } from "../../shared/types.ts";

export interface WorkflowAttentionRequest {
	requestId: string;
	runId: string;
	agent: string;
	childIndex: number;
	source?: "native" | "external";
	key?: string;
}

/** Memory-only continuation: never serialize a live VM or replay its already executed stages. */
export interface ForegroundWorkflowContinuation {
	runId: string;
	sessionId: string;
	cwd: string;
	updatedAt: number;
	requests: Map<string, WorkflowAttentionRequest>;
	result?: AgentToolResult<Details>;
	snapshot(): AgentToolResult<Details>;
	interrupt(): void;
}

function attentionRequest(value: unknown): WorkflowAttentionRequest | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (!("requestId" in value) || typeof value.requestId !== "string"
		|| !("runId" in value) || typeof value.runId !== "string"
		|| !("agent" in value) || typeof value.agent !== "string"
		|| !("childIndex" in value) || typeof value.childIndex !== "number") return undefined;
	return { requestId: value.requestId, runId: value.runId, agent: value.agent, childIndex: value.childIndex,
		...("source" in value && (value.source === "native" || value.source === "external") ? { source: value.source } : {}),
	};
}

/** Current output is an explicit nonterminal handoff, never a successful child result. */
export function foregroundWorkflowSnapshot(run: ForegroundWorkflowContinuation, partial: AgentToolResult<Details>): AgentToolResult<Details> {
	if (run.result) return run.result;
	const requests = [...run.requests.values()];
	const heading = requests.length ? "needs_attention: supervisor decision required" : "running: original foreground workflow continuation retained";
	const lines = [
		`Workflow ${run.runId} — ${heading}.`,
		...requests.map((request) => `- ${request.key ?? request.agent}: ${request.runId}#${request.childIndex}; request ${request.requestId}`),
		...(requests.some((request) => request.source === "external") ? ['Use intercom({ action: "pending" }) for external intercom questions and reply through that provider.'] : []),
		...(requests.some((request) => request.source !== "external") ? ['Use subagent_supervisor({ action: "pending" }) for native supervisor questions and reply by current request id.'] : []),
		"Expired requests must not be answered from an old notification.",
		`The original workflow will continue after the reply; do not resume, replay, or launch replacement writers. Use bg_wait({ id: \"${run.runId}\" }) or subagent({ action: \"status\", id: \"${run.runId}\" }) for the final output.`,
		"Keep the active worktree single-writer while the child remains live.",
	];
	return { ...partial, content: [{ type: "text", text: lines.join("\n") }, ...partial.content] };
}

/** A replaced parent context must not keep a suspended VM capable of launching later stages. */
export function interruptForeignForegroundWorkflows(state: SubagentState, sessionId: string | null | undefined): void {
	for (const run of state.foregroundWorkflows?.values() ?? []) {
		if (!run.result && run.sessionId !== sessionId) run.interrupt();
	}
}

/**
 * Race only the public tool response against attention, not the underlying VM. A supervisor ask
 * cannot be answered while the parent is awaiting that tool. Preserve the live promise and its
 * deadline/abort ownership, then publish its real result once all original stages have settled.
 */
export async function runForegroundWorkflowWithHandoff(input: {
	state: SubagentState;
	events: IntercomEventBus;
	runId: string;
	sessionId: string;
	cwd: string;
	signal: AbortSignal;
	run(signal: AbortSignal): Promise<AgentToolResult<Details>>;
	partial(): AgentToolResult<Details>;
	onHandoff?(): void;
	notify?(run: ForegroundWorkflowContinuation): void;
}): Promise<AgentToolResult<Details>> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(input.signal.reason);
	input.signal.addEventListener("abort", onAbort, { once: true });
	if (input.signal.aborted) onAbort();
	let yielded = false;
	let release: ((result: AgentToolResult<Details>) => void) | undefined;
	const attention = new Promise<AgentToolResult<Details>>((resolve) => { release = resolve; });
	const run: ForegroundWorkflowContinuation = {
		runId: input.runId, sessionId: input.sessionId, cwd: input.cwd, updatedAt: Date.now(),
		requests: new Map(),
		snapshot: () => foregroundWorkflowSnapshot(run, input.partial()),
		interrupt: () => controller.abort(new Error("Foreground workflow interrupted.")),
	};
	input.state.foregroundWorkflows ??= new Map();
	// Bound terminal retention without evicting a live continuation or its result before handoff.
	for (const [id, previous] of input.state.foregroundWorkflows) {
		if (input.state.foregroundWorkflows.size < 50) break;
		if (previous.result) input.state.foregroundWorkflows.delete(id);
	}
	if (input.state.foregroundWorkflows.size >= 50) {
		input.signal.removeEventListener("abort", onAbort);
		return { content: [{ type: "text", text: "Foreground workflow capacity reached (50 live continuations). Resolve or interrupt existing work before launching more." }], isError: true, details: { mode: "workflow", results: [] } };
	}
	input.state.foregroundWorkflows.set(input.runId, run);
	input.state.workflowControllers ??= new Map();
	input.state.workflowControllers.set(input.runId, controller);
	const onAttention = (value: unknown) => {
		const request = attentionRequest(value);
		if (!request || run.result || input.state.currentSessionId !== input.sessionId) return;
		const control = input.state.foregroundControls.get(request.runId);
		if (control?.parentWorkflowRunId !== input.runId || control.sessionId !== input.sessionId) return;
		run.requests.set(request.requestId, { ...request, ...(control.workflowKey ? { key: control.workflowKey } : {}) });
		run.updatedAt = Date.now();
		if (!yielded) input.onHandoff?.();
		yielded = true;
		release?.(run.snapshot());
	};
	const unsubscribeAsk = input.events.on?.(INTERCOM_DETACH_REQUEST_EVENT, (value) => {
		// Native discovery has validated the pending request. External requests need the
		// child's accepted, tool-correlated response before they may become blocking attention.
		if (attentionRequest(value)?.source === "native") onAttention(value);
	});
	// External intercom providers can omit routing in their request. Execution's accepted response
	// always carries the owned child identity; use it as a fallback instead of silently waiting.
	const unsubscribeDetach = input.events.on?.(INTERCOM_DETACH_RESPONSE_EVENT, (value) => {
		if (value && typeof value === "object" && "accepted" in value && value.accepted === true) onAttention(value);
	});
	const unsubscribeSettled = input.events.on?.(SUPERVISOR_REQUEST_SETTLED_EVENT, (value) => {
		const request = attentionRequest(value);
		if (!request) return;
		const pending = run.requests.get(request.requestId);
		if (!pending || pending.runId !== request.runId || pending.agent !== request.agent || pending.childIndex !== request.childIndex
			|| (pending.source && request.source && pending.source !== request.source)) return;
		run.requests.delete(request.requestId);
		run.updatedAt = Date.now();
	});
	const completion = Promise.resolve().then(() => input.run(controller.signal)).catch((error: unknown): AgentToolResult<Details> => {
		const checkpoint = input.partial();
		return { ...checkpoint,
			content: [{ type: "text", text: `Workflow ${input.runId} failed: ${error instanceof Error ? error.message : String(error)}` }, ...checkpoint.content],
			isError: true,
		};
	}).then((result) => {
		run.result = result;
		run.requests.clear();
		run.updatedAt = Date.now();
		unsubscribeAsk?.();
		unsubscribeDetach?.();
		unsubscribeSettled?.();
		input.signal.removeEventListener("abort", onAbort);
		if (input.state.workflowControllers?.get(input.runId) === controller) input.state.workflowControllers.delete(input.runId);
		if (yielded && input.state.currentSessionId === input.sessionId) {
			try { input.notify?.(run); } catch { /* A notification failure cannot discard the retained result. */ }
		}
		return result;
	});
	return Promise.race([completion, attention]);
}
