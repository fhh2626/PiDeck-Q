/** Desktop projection of the neutral custom goal emitted by the standalone todo extension. */
export const PI_TODO_TASK_START = "pi-deck-todo-task-start";

/** Only explicitly visible task starts are goals; rules and continuation prompts remain hidden. */
export function readTodoTaskGoal(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (Reflect.get(value, "customType") !== PI_TODO_TASK_START || Reflect.get(value, "display") !== true) return undefined;
	if (Reflect.get(value, "role") !== "custom" && Reflect.get(value, "type") !== "custom_message") return undefined;
	const content: unknown = Reflect.get(value, "content");
	return typeof content === "string" && content.trim() ? content.trim() : undefined;
}

/**
 * Adapt a Pi JSONL entry for browsing only. Never rewrite persisted entries or
 * manufacture editable user records: a task start stays a custom message.
 */
export function piDisplayEntry(entry: Record<string, unknown>): { type: string; message: unknown } {
	const goal = readTodoTaskGoal(entry);
	if (goal === undefined) return { type: typeof entry.type === "string" ? entry.type : "", message: entry.message };
	const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : entry.timestamp;
	return { type: "message", message: {
		role: "custom", customType: PI_TODO_TASK_START, content: goal, display: true, details: entry.details,
		...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { timestamp } : {}),
	} };
}

/** Raw Pi goals and their read-only desktop cards are user-initiated turn boundaries. */
export function isPiUserTurn(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const role: unknown = Reflect.get(message, "role");
	if (role === "user" || readTodoTaskGoal(message) !== undefined) return true;
	const meta: unknown = Reflect.get(message, "meta");
	return role === "system" && typeof meta === "object" && meta !== null && Reflect.get(meta, "type") === "todoTask";
}