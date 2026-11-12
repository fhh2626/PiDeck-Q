/** Pure, task-scoped todo policy. No runtime state is persisted with list snapshots. */
export interface Todo {
	id: number;
	text: string;
	done: boolean;
}

export interface TodoState {
	todos: Todo[];
	nextId: number;
}

export type TodoAction = "list" | "add" | "toggle" | "clear";
export type TodoTaskMode = "todo" | "todo-goal";

/** A step that already ran; kept after an authorized clear so it is never repeated. */
export interface TodoDoneItem {
	id: number;
	text: string;
}

export interface TodoTask {
	id: string;
	mode: TodoTaskMode;
	goal: string;
	created: boolean;
	locked: boolean;
	paused: boolean;
	/** Plan mode owns the turn, so /todo-resume must not steal it back. */
	planPaused: boolean;
	/** The next ordinary user message continues this paused goal as guidance. */
	resumeOnUserInput: boolean;
	consecutiveErrors: number;
	blocked?: { reason: string; needs: string };
	/** Steps finished before an authorized clear; they must not be repeated. */
	clearedCompleted: readonly TodoDoneItem[];
}

/** A new command is a new task, never a persistent mode for later user messages. */
export function createTodoTask(id: string, mode: TodoTaskMode, goal: string): TodoTask {
	return {
		id, mode, goal, created: false, locked: false, paused: false, planPaused: false,
		resumeOnUserInput: false, consecutiveErrors: 0, clearedCompleted: [],
	};
}

/**
 * Clear a reported pause once the resuming run is confirmed. The checklist and the
 * original goal survive, so the user's guidance continues the same task instead of
 * starting a new one.
 */
export function resumePausedGoal(task: TodoTask): TodoTask {
	return {
		...task, paused: false, blocked: undefined, planPaused: false,
		resumeOnUserInput: false, consecutiveErrors: 0,
	};
}

/**
 * Plan mode takes the turn. Keep the pause reason (reported blocker, error fuse, unsupported
 * boundary) intact and only add plan ownership, so leaving plan mode restores the exact resume
 * rule the goal had before: a blocker resumes from a plain reply, the error fuse needs /todo-resume.
 */
export function suspendForPlan(task: TodoTask): TodoTask {
	return { ...task, paused: true, planPaused: true, resumeOnUserInput: !task.paused || task.resumeOnUserInput };
}

/** Only a successful add commits the goal's clarification -> execution transition. */
export function recordTodoMutation(
	task: TodoTask,
	action: TodoAction,
	completed: readonly TodoDoneItem[] = [],
): TodoTask {
	if (action === "add") return { ...task, created: true, locked: task.mode === "todo-goal" };
	if (action !== "clear") return task;
	// An authorized clear must not erase what already ran: the goal continues by rebuilding
	// only the remaining work, so the completed identity is merged into the task.
	const merged = [...task.clearedCompleted];
	for (const item of completed) {
		if (!merged.some((entry) => entry.id === item.id)) merged.push(item);
	}
	return { ...task, clearedCompleted: merged };
}

export interface GoalDecision {
	task: TodoTask;
	action: "complete" | "continue" | "pause";
}

/** Continue every normal unfinished response; only consecutive errors trip the failure fuse. */
export function decideGoalBoundary(
	task: TodoTask,
	todos: readonly Todo[],
	outcome: "completed" | "error",
): GoalDecision {
	if (task.paused) return { task, action: "pause" };
	if (outcome === "completed" && task.created && todos.length > 0 && todos.every((item) => item.done)) {
		return { task, action: "complete" };
	}
	const consecutiveErrors = outcome === "completed" ? 0 : task.consecutiveErrors + 1;
	const next = { ...task, consecutiveErrors, paused: consecutiveErrors >= 3 };
	return { task: next, action: next.paused ? "pause" : "continue" };
}

/** Read plain user text without depending on runtime-specific message implementations. */
function userText(message: unknown): string {
	if (typeof message !== "object" || message === null || Reflect.get(message, "role") !== "user") return "";
	const content: unknown = Reflect.get(message, "content");
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: unknown) => {
		if (typeof part !== "object" || part === null || Reflect.get(part, "type") !== "text") return [];
		const text: unknown = Reflect.get(part, "text");
		return typeof text === "string" ? [text] : [];
	}).join("\n").trim();
}

export const TASK_START = "pi-deck-todo-task-start";
export const TASK_CONTEXT = "pi-deck-todo-task-context";
export const TASK_CONTINUE = "pi-deck-todo-task-continue";
export const TASK_RESUME = "pi-deck-todo-task-resume";

/** Resolve the latest task only on the current branch, ignoring command-only messages. */
export function recentTodoTask(entries: readonly unknown[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null) continue;
		if (Reflect.get(entry, "type") === "custom_message" && Reflect.get(entry, "customType") === TASK_START) {
			const goal: unknown = Reflect.get(entry, "content");
			if (typeof goal === "string" && goal.trim()) return goal.trim();
		}
		if (Reflect.get(entry, "type") !== "message") continue;
		const text = userText(Reflect.get(entry, "message"));
		if (!text) continue;
		const command = /^\/todo(?:-goal)?(?:\s+([\s\S]*))?$/.exec(text);
		if (command) {
			if (command[1]?.trim()) return command[1].trim();
			continue;
		}
		if (/^\/[\w-]+(?:\s|$)/.test(text)) continue;
		return text;
	}
	return "";
}

/** Completed steps recorded before an authorized clear, formatted for the model. */
function completedSteps(task: TodoTask): string {
	return task.clearedCompleted.map((item) => `#${item.id} ${item.text}`).join("; ");
}

/** A cleared goal keeps its completed identity instead of restarting finished steps. */
function needsRebuild(task: TodoTask, todos: readonly Todo[]): boolean {
	// Clearing before any step is done still needs reconstruction, not an existing-list rule.
	return task.created && todos.length === 0;
}

/** Model-facing rules stay separate from the goal so old constraints can be filtered out. */
export function todoTaskInstructions(task: TodoTask, todos: readonly Todo[]): string {
	const rebuild = needsRebuild(task, todos);
	return [
		`[TODO TASK: ${task.mode}]`,
		rebuild
			? `The checklist was cleared. Rebuild only the remaining work from the original goal.${task.clearedCompleted.length ? ` These steps are already completed and must not be repeated: ${completedSteps(task)}.` : ""}`
			: task.created
				? "Continue the existing checklist; do not create a new one or re-add completed steps. Mark each step done immediately after finishing it."
				: "Use the todo tool to create a fresh checklist before working. Mark each step done immediately after finishing it.",
		rebuild
			? "Add the remaining steps with the todo tool before continuing; an empty checklist is not completion."
			: "Once the checklist exists, keep completed items; do not clear or rebuild it unless the user explicitly requests it.",
		task.mode === "todo"
			? "Use ask_question for clarification when needed. This task does not automatically continue after you finish a response."
			: "You may clarify with ask_question before the first successful todo add. After that, ask_question is blocked until this task finishes. Continue independently within the user's authority and safety limits. Use todo_goal_context to refresh the goal or checklist. Call todo_goal_blocked only when you cannot continue safely without user input; unfinished work, difficulty, or a progress update alone is not a blocker.",
		"Never invent credentials, bypass permissions, or claim completion without verification. Report blockers honestly.",
	].join("\n");
}

/** Keep each persisted continuation short while preserving rules through compaction. */
export function todoContinuation(task: TodoTask, todos: readonly Todo[]): string {
	return [
		"[CONTINUE UNFINISHED TODO GOAL]",
		needsRebuild(task, todos)
			? `The checklist was cleared; rebuild only the remaining work from the original goal.${task.clearedCompleted.length ? ` Do not repeat these completed steps: ${completedSteps(task)}.` : ""}`
			: "Continue the goal; do not repeat completed work or rebuild the checklist.",
		"An empty checklist is not completion. Call todo_goal_context if you need the original goal or current checklist.",
		"Call todo_goal_blocked only when you cannot continue safely without user input, not merely because work remains or is difficult.",
		task.locked ? "ask_question remains blocked; work within existing authorization." : "Clarify with ask_question only if needed before creating the checklist.",
	].join("\n\n");
}
