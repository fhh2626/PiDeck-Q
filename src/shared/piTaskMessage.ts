/** Desktop projection of the neutral custom messages emitted by the standalone todo extension. */
export const PI_TODO_TASK_START = "pi-deck-todo-task-start";
/** User guidance that resumed a blocked goal; same read-only card, different label. */
export const PI_TODO_TASK_RESUME = "pi-deck-todo-task-resume";

export type TodoTaskMessageKind = "goal" | "resume";

/** Only explicitly visible task messages are user turns; rules and continuations stay hidden. */
export function readTodoTaskMessage(value: unknown): { kind: TodoTaskMessageKind; text: string } | undefined {
	const goal = readVisibleCustom(value, PI_TODO_TASK_START);
	if (goal !== undefined) return { kind: "goal", text: goal };
	const resume = readVisibleCustom(value, PI_TODO_TASK_RESUME);
	return resume === undefined ? undefined : { kind: "resume", text: resume };
}

/** Goal-only reader: session titles and previews keep using the original task. */
export function readTodoTaskGoal(value: unknown): string | undefined {
	return readVisibleCustom(value, PI_TODO_TASK_START);
}

/** Pi entries store ISO timestamps while chat messages use epoch milliseconds. */
export function toEpochMs(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * Sender-provided identity for one task message. Live events and projected history must
 * agree on it, otherwise a genuinely new resume is mistaken for a replayed card.
 */
export function readTodoTaskMessageId(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details: unknown = Reflect.get(value, "details");
	if (typeof details !== "object" || details === null) return undefined;
	const id: unknown = Reflect.get(details, "messageId");
	return typeof id === "string" && id.trim() ? id : undefined;
}

function readVisibleCustom(value: unknown, customType: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (Reflect.get(value, "customType") !== customType || Reflect.get(value, "display") !== true) return undefined;
	if (Reflect.get(value, "role") !== "custom" && Reflect.get(value, "type") !== "custom_message") return undefined;
	const content: unknown = Reflect.get(value, "content");
	return typeof content === "string" && content.trim() ? content.trim() : undefined;
}

/**
 * Adapt a Pi JSONL entry for browsing only. Never rewrite persisted entries or
 * manufacture editable user records: task messages stay custom messages.
 */
export function piDisplayEntry(entry: Record<string, unknown>): { type: string; message: unknown } {
	const task = readTodoTaskMessage(entry);
	if (task === undefined) return { type: typeof entry.type === "string" ? entry.type : "", message: entry.message };
	const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : entry.timestamp;
	return { type: "message", message: {
		role: "custom",
		customType: task.kind === "goal" ? PI_TODO_TASK_START : PI_TODO_TASK_RESUME,
		content: task.text, display: true, details: entry.details,
		...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { timestamp } : {}),
	} };
}

/**
 * Desktop cards for task messages are projected as `system` for read-only safety, yet they start a
 * turn. Both the live cache and the file index must agree on that boundary, or entry mapping shifts.
 */
export function isTodoTaskCard(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	if (Reflect.get(message, "role") !== "system") return false;
	const meta: unknown = Reflect.get(message, "meta");
	return typeof meta === "object" && meta !== null && Reflect.get(meta, "type") === "todoTask";
}

/** Raw Pi task messages and their read-only desktop cards are user-initiated turn boundaries. */
export function isPiUserTurn(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const role: unknown = Reflect.get(message, "role");
	if (role === "user" || readTodoTaskMessage(message) !== undefined) return true;
	const meta: unknown = Reflect.get(message, "meta");
	return role === "system" && typeof meta === "object" && meta !== null && Reflect.get(meta, "type") === "todoTask";
}
