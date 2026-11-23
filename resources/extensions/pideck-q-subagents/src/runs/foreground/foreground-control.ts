import type { AgentProgress, ForegroundChildControl, ForegroundRunControl, SubagentState } from "../../shared/types.ts";
import { registerLivePromptAudit, removeLivePromptAudit, type PromptAuditRerunContract } from "./prompt-audit.ts";

interface BeginForegroundChildInput {
	index: number;
	agent: string;
	description?: string;
	authoredTask: string;
	effectivePrompt: string;
	cwd?: string;
	outputPath?: string;
	rerun?: PromptAuditRerunContract;
	model?: string;
	thinking?: string;
	interrupt: () => boolean;
	detach?: () => boolean;
	steer?: ForegroundChildControl["steer"];
}

interface ForegroundExecutionOwner {
	sessionId: string | undefined;
	controller: AbortController;
}

type ForegroundExecutionState = Pick<SubagentState, "foregroundControls" | "subagentInProgress">;
const foregroundExecutionOwners = new WeakMap<ForegroundExecutionState, Set<ForegroundExecutionOwner>>();
const foregroundDispatchOwners = new WeakMap<ForegroundExecutionState, Pick<ForegroundExecutionOwner, "sessionId">>();

/** Claim one foreground call for this parent without letting an outgoing call release its successor. */
export function claimForegroundDispatch(state: ForegroundExecutionState, sessionId: string | undefined): (() => void) | undefined {
	const previous = foregroundDispatchOwners.get(state);
	// An unavailable incoming identity cannot prove that the active parent changed.
	if (previous && (sessionId === undefined || previous.sessionId === sessionId)) return undefined;
	const owner = { sessionId };
	foregroundDispatchOwners.set(state, owner);
	state.subagentInProgress = true;
	return () => {
		if (foregroundDispatchOwners.get(state) !== owner) return;
		foregroundDispatchOwners.delete(state);
		state.subagentInProgress = false;
	};
}

/** Own preparation from entry until the executor returns, including before any child control exists. */
export async function withForegroundExecutionOwner<T>(
	state: ForegroundExecutionState,
	sessionId: string | undefined,
	signal: AbortSignal,
	execute: (ownedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	const owners = foregroundExecutionOwners.get(state) ?? new Set<ForegroundExecutionOwner>();
	foregroundExecutionOwners.set(state, owners);
	const owner = { sessionId, controller: new AbortController() };
	owners.add(owner);
	try {
		return await execute(AbortSignal.any([signal, owner.controller.signal]));
	} finally {
		owners.delete(owner);
		if (owners.size === 0) foregroundExecutionOwners.delete(state);
	}
}

/** Keep outgoing ownership in memory while exposing only the active parent's controls. */
export function currentSessionForegroundControls(state: Pick<SubagentState, "currentSessionId" | "foregroundControls">): ForegroundRunControl[] {
	if (!state.currentSessionId) return [];
	return [...state.foregroundControls.values()].filter((control) => control.sessionId === state.currentSessionId);
}

/** Cancel outgoing children without releasing their controls before authoritative completion. */
export function interruptForegroundControls(state: ForegroundExecutionState, keepSessionId?: string | null): void {
	const dispatchOwner = foregroundDispatchOwners.get(state);
	if (dispatchOwner && (!keepSessionId || dispatchOwner.sessionId !== keepSessionId)) {
		foregroundDispatchOwners.delete(state);
		state.subagentInProgress = false;
	}
	for (const owner of foregroundExecutionOwners.get(state) ?? []) {
		if (!keepSessionId || owner.sessionId !== keepSessionId) owner.controller.abort();
	}
	for (const control of state.foregroundControls.values()) {
		if (keepSessionId && control.sessionId === keepSessionId) continue;
		const children = [...(control.activeChildren?.values() ?? [])];
		const interrupts = children.length > 0 ? children.map((child) => child.interrupt) : [control.interrupt];
		for (const interrupt of interrupts) {
			try {
				interrupt?.();
			} catch (error) {
				// One failed child cancellation must not leave its siblings running after teardown.
				console.error("Failed to interrupt a foreground child during session cleanup:", error);
			}
		}
	}
}

function copyProgress(target: ForegroundChildControl, progress: AgentProgress | undefined): void {
	if (!progress) return;
	target.sessionName = progress.sessionName;
	target.currentActivityState = progress.activityState;
	target.lastActivityAt = progress.lastActivityAt;
	target.currentTool = progress.currentTool;
	target.currentToolStartedAt = progress.currentToolStartedAt;
	target.currentPath = progress.currentPath;
	target.turnCount = progress.turnCount;
	target.tokens = progress.tokens;
	target.inputTokens = progress.inputTokens;
	target.outputTokens = progress.outputTokens;
	target.window = progress.window;
	target.windowPeak = progress.windowPeak;
	target.model = progress.model;
	target.thinking = progress.thinking;
	target.toolCount = progress.toolCount;
}

function syncCurrentChild(control: ForegroundRunControl, child: ForegroundChildControl): void {
	control.currentAgent = child.agent;
	control.sessionName = child.sessionName;
	control.currentIndex = child.index;
	control.description = child.description;
	control.currentActivityState = child.currentActivityState;
	control.lastActivityAt = child.lastActivityAt;
	control.currentTool = child.currentTool;
	control.currentToolStartedAt = child.currentToolStartedAt;
	control.currentPath = child.currentPath;
	control.turnCount = child.turnCount;
	control.tokens = child.tokens;
	control.inputTokens = child.inputTokens;
	control.outputTokens = child.outputTokens;
	control.window = child.window;
	control.windowPeak = child.windowPeak;
	control.model = child.model;
	control.thinking = child.thinking;
	control.toolCount = child.toolCount;
	control.interrupt = child.interrupt;
	control.detach = child.detach;
	control.steer = child.steer;
	control.updatedAt = child.updatedAt;
}

function clearCurrentChild(control: ForegroundRunControl): void {
	control.currentAgent = undefined;
	control.sessionName = undefined;
	control.currentIndex = undefined;
	control.currentActivityState = undefined;
	control.lastActivityAt = undefined;
	control.currentTool = undefined;
	control.currentToolStartedAt = undefined;
	control.currentPath = undefined;
	control.turnCount = undefined;
	control.tokens = undefined;
	control.inputTokens = undefined;
	control.outputTokens = undefined;
	control.window = undefined;
	control.windowPeak = undefined;
	control.model = undefined;
	control.thinking = undefined;
	control.toolCount = undefined;
	control.interrupt = undefined;
	control.detach = undefined;
	control.steer = undefined;
}

export function retainForegroundSchedulingOwner(control: ForegroundRunControl): void {
	control.schedulingOwners = (control.schedulingOwners ?? 0) + 1;
	control.updatedAt = Date.now();
}

export function settleForegroundSchedulingOwner(control: ForegroundRunControl): void {
	control.schedulingOwners = Math.max(0, (control.schedulingOwners ?? 0) - 1);
	control.updatedAt = Date.now();
}

export function foregroundSchedulingSettled(control: ForegroundRunControl): boolean {
	return (control.schedulingOwners ?? 0) === 0;
}

export function beginForegroundChild(control: ForegroundRunControl, input: BeginForegroundChildInput): void {
	const now = Date.now();
	const child: ForegroundChildControl = {
		index: input.index,
		agent: input.agent,
		...(input.description ? { description: input.description } : {}),
		startedAt: now,
		updatedAt: now,
		...(input.model ? { model: input.model } : {}),
		...(input.thinking ? { thinking: input.thinking } : {}),
	};
	child.interrupt = () => {
		if (!input.interrupt()) return false;
		child.currentActivityState = undefined;
		child.updatedAt = Date.now();
		syncCurrentChild(control, child);
		return true;
	};
	if (input.detach) {
		child.detach = () => {
			if (!input.detach?.()) return false;
			child.currentActivityState = undefined;
			child.updatedAt = Date.now();
			syncCurrentChild(control, child);
			return true;
		};
	}
	if (input.steer) child.steer = input.steer;
	control.activeChildren ??= new Map();
	control.activeChildren.set(input.index, child);
	registerLivePromptAudit(control, input.index, input.authoredTask, input.effectivePrompt, {
		...(input.cwd ? { cwd: input.cwd } : {}),
		...(input.outputPath ? { outputPath: input.outputPath } : {}),
		...(input.rerun ? { rerun: input.rerun } : {}),
	});
	syncCurrentChild(control, child);
}

export function updateForegroundChild(control: ForegroundRunControl, index: number, progress: AgentProgress | undefined): void {
	const child = control.activeChildren?.get(index);
	if (!child) return;
	copyProgress(child, progress);
	child.updatedAt = Date.now();
	syncCurrentChild(control, child);
}

export function finishForegroundChild(control: ForegroundRunControl, index: number): void {
	removeLivePromptAudit(control, index);
	control.activeChildren?.delete(index);
	if (control.currentIndex === index) {
		const next = [...(control.activeChildren?.values() ?? [])]
			.sort((left, right) => right.updatedAt - left.updatedAt || left.index - right.index)[0];
		if (next) syncCurrentChild(control, next);
		else clearCurrentChild(control);
	}
	control.updatedAt = Date.now();
}
