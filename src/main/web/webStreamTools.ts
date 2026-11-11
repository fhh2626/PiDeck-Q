import type { ChatMessage, SessionRuntimeInfo, SessionTargetedValue } from "../../shared/types";

/** Tool identity and input only: replay must never invent execution results. */
export type WebStreamToolInput = {
	toolCallId: string;
	toolName: string;
	args: unknown;
};

const MAX_REPLAY_INPUT_CHARS = 8000;

/** Retain a bounded, detached input snapshot for long-lived/reconnected streams. */
export function snapshotWebToolInput(input: unknown): unknown {
	// Strings can already be truncated JSON snapshots. Keep truncation idempotent
	// instead of quoting/escaping them again on every progress notification.
	if (typeof input === "string") return input.length > MAX_REPLAY_INPUT_CHARS
		? `${input.slice(0, MAX_REPLAY_INPUT_CHARS)}…` : input;
	try {
		const serialized = JSON.stringify(input ?? {});
		if (!serialized) return {};
		return serialized.length > MAX_REPLAY_INPUT_CHARS
			? `${serialized.slice(0, MAX_REPLAY_INPUT_CHARS)}…`
			: JSON.parse(serialized);
	} catch {
		// Unsupported/cyclic extension input must not break the entire SSE stream.
		return {};
	}
}

/** Assistant snapshots can declare tools even when their execution-start event was missed. */
export function readWebAssistantToolCalls(content: unknown): WebStreamToolInput[] {
	if (!Array.isArray(content)) return [];
	const calls: WebStreamToolInput[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || Reflect.get(block, "type") !== "toolCall") continue;
		const id: unknown = Reflect.get(block, "id");
		const name: unknown = Reflect.get(block, "name");
		if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()) continue;
		calls.push({ toolCallId: id, toolName: name, args: Reflect.get(block, "arguments") ?? Reflect.get(block, "input") ?? {} });
	}
	return calls;
}

/** Reject stale/cross-session runtime snapshots before using them to seed SSE state. */
export function readCurrentWebStreamTools(
	sessionId: string,
	runtimes: readonly SessionRuntimeInfo[],
	snapshot: SessionTargetedValue<ChatMessage[]> | undefined,
): WebStreamToolInput[] {
	const runtime = runtimes.find((item) => item.sessionId === sessionId && item.status === "running");
	if (!runtime || !snapshot || snapshot.target.sessionId !== sessionId
		|| snapshot.target.agentId !== runtime.agentId
		|| snapshot.target.runtimeGeneration !== runtime.runtimeGeneration) return [];
	return readRunningWebTools(snapshot.value);
}

/** Only current, genuinely running runtime rows may bootstrap a cold Web translator. */
export function readRunningWebTools(messages: readonly ChatMessage[]): WebStreamToolInput[] {
	const calls: WebStreamToolInput[] = [];
	for (const message of messages) {
		if (message.role !== "tool" || message.meta?.status !== "running") continue;
		const { toolCallId, toolName, args } = message.meta;
		if (typeof toolCallId !== "string" || !toolCallId.trim() || typeof toolName !== "string" || !toolName.trim()) continue;
		let input: unknown = args ?? {};
		if (typeof input === "string") {
			try { input = JSON.parse(input); } catch { /* Older/truncated inputs remain readable strings. */ }
		}
		calls.push({ toolCallId, toolName, args: snapshotWebToolInput(input) });
	}
	return calls;
}
