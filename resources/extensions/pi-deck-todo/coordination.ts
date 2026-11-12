import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi's in-process event bus, scoped to a session; this is not a second desktop channel. */
export const PI_DECK_PLAN_MODE_MARKER = "__PI_DECK_PLAN_MODE__";
export const TODO_TASK_PAUSE_EVENT = "pi-deck-todo:pause";
export const TODO_TASK_PLAN_RELEASE_EVENT = "pi-deck-todo:plan-release";
export const TODO_TASK_PLAN_STATE_EVENT = "pi-deck-todo:plan-state";

/** Plan ownership published per session so commands can refuse to start or resume inside it. */
export interface TodoPlanState {
	sessionId: string;
	active: boolean;
}

/** An explicit plan pause/close must also prevent goal's next automatic request. */
export function pauseTodoTask(pi: ExtensionAPI, ctx: ExtensionContext): void {
	pi.events?.emit(TODO_TASK_PAUSE_EVENT, ctx.sessionManager.getSessionId());
}

/**
 * Plan mode owns the turn from the moment it is enabled, before any goal exists. Publishing the
 * state lets /todo-goal and /todo-resume refuse to start a run inside a read-only plan turn.
 */
export function publishTodoPlanState(pi: ExtensionAPI, ctx: ExtensionContext, active: boolean): void {
	if (!pi.events) return;
	const state: TodoPlanState = { sessionId: ctx.sessionManager.getSessionId(), active };
	pi.events.emit(TODO_TASK_PLAN_STATE_EVENT, state);
}

/** Leaving plan mode never starts a run; explicit plan approval may resume the suspended goal. */
export function releaseTodoPlanPause(pi: ExtensionAPI, ctx: ExtensionContext, approved = false): void {
	// Legacy hosts without an event bus need not expose the coordination context either.
	if (!pi.events) return;
	const sessionId = ctx.sessionManager.getSessionId();
	pi.events.emit(TODO_TASK_PLAN_RELEASE_EVENT, approved ? { sessionId, approved: true } : sessionId);
}
