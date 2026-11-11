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

export interface TodoTask {
	id: string;
	mode: TodoTaskMode;
	goal: string;
	created: boolean;
	locked: boolean;
	paused: boolean;
	stalls: number;
	completedIds: readonly number[];
}

/** A new command is a new task, never a persistent mode for later user messages. */
export function createTodoTask(id: string, mode: TodoTaskMode, goal: string): TodoTask {
	return { id, mode, goal, created: false, locked: false, paused: false, stalls: 0, completedIds: [] };
}

/** Only a successful add commits the goal's clarification -> execution transition. */
export function recordTodoMutation(task: TodoTask, action: TodoAction): TodoTask {
	return action === "add"
		? { ...task, created: true, locked: task.mode === "todo-goal" }
		: task;
}

export interface GoalDecision {
	task: TodoTask;
	action: "complete" | "continue" | "pause";
}

/**
 * Count progress only when an item is completed for the first time in this task.
 * Merely adding, listing or toggling an already-completed item cannot reset the fuse.
 * An error still counts as a failure even if that round changed the checklist.
 */
export function decideGoalBoundary(
	task: TodoTask,
	todos: readonly Todo[],
	outcome: "completed" | "error",
): GoalDecision {
	if (task.paused) return { task, action: "pause" };
	if (outcome === "completed" && task.created && todos.length > 0 && todos.every((item) => item.done)) {
		return { task, action: "complete" };
	}
	const completedIds = [...new Set([...task.completedIds, ...todos.filter((item) => item.done).map((item) => item.id)])];
	const progressed = completedIds.length > task.completedIds.length;
	const stalls = outcome === "completed" && progressed ? 0 : task.stalls + 1;
	const next = { ...task, completedIds, stalls, paused: stalls >= 3 };
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

/** Model-facing rules stay separate from the goal so old constraints can be filtered out. */
export function todoTaskInstructions(task: TodoTask): string {
	return [
		`[TODO TASK: ${task.mode}]`,
		"Use the todo tool to create a fresh checklist before working. Mark each step done immediately after finishing it.",
		"Keep completed items; do not clear or rebuild the checklist unless the user explicitly requests it.",
		task.mode === "todo"
			? "Use ask_question for clarification when needed. This task does not automatically continue after you finish a response."
			: "You may clarify with ask_question before the first successful todo add. After that, ask_question is blocked until this task finishes. Continue independently within the user's authority and safety limits.",
		"Never invent credentials, bypass permissions, or claim completion without verification. Report blockers honestly.",
	].join("\n");
}

/** Explicit continuation context prevents restarting work or repeating completed side effects. */
export function todoContinuation(task: TodoTask, todos: readonly Todo[]): string {
	const remaining = todos.filter((item) => !item.done);
	return [
		"[CONTINUE UNFINISHED TODO GOAL]",
		`Original goal:\n${task.goal}`,
		remaining.length > 0
			? `Unfinished items:\n${remaining.map((item) => `#${item.id} ${item.text}`).join("\n")}`
			: "No unfinished items are recorded. An empty list is not completion: create the checklist if it has not been created. If it was cleared, reconstruct remaining work from the original goal without repeating completed actions. If the previous turn errored, verify the goal and checklist before reporting success.",
		"Continue execution now. Do not reset or rebuild an existing checklist. Do not repeat completed operations.",
		task.locked ? "ask_question remains blocked. Work within existing authorization; report missing permissions or credentials as blockers." : "Clarify with ask_question only if needed before creating the checklist.",
	].join("\n\n");
}
