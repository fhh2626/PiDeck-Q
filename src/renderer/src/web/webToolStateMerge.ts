/** A late running snapshot must not undo a tool already settled in a row OR a combined SSE bubble. */
import { isToolUIPart, type UIMessage } from "ai";
import { uiMessageRole } from "./webMessageMetadata";
import { hasToolResultMissingMetadata } from "../../../shared/toolOutcome";

type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/** Carry terminal output forward before covered SSE bubbles are removed by the timeline merge. */
export function preserveSettledWebTools(current: UIMessage[], incoming: UIMessage[], preserveRunning = false): UIMessage[] {
	const completed = new Map<string, ToolPart>();
	const running = new Map<string, ToolPart>();
	const ambiguous = new Set<string>();
	for (const message of current) {
		for (const part of message.parts) {
			if (!isToolUIPart(part)) continue;
			if (preserveRunning && (part.state === "input-streaming" || part.state === "input-available")
				&& !hasToolResultMissingMetadata(part.toolMetadata)) {
				// A genuine live call is also stronger than a file snapshot that
				// merely lacks a result; retain complete input over streaming input.
				if (part.state === "input-available" || !running.has(part.toolCallId)) running.set(part.toolCallId, part);
			}
			if (part.state !== "output-available" && part.state !== "output-error") continue;
			const previous = completed.get(part.toolCallId);
			if (previous && JSON.stringify(previous) !== JSON.stringify(part)) ambiguous.add(part.toolCallId);
			completed.set(part.toolCallId, part);
		}
	}
	let changed = false;
	const result = incoming.map((message) => {
		if (uiMessageRole(message) !== "tool") return message;
		let rowChanged = false;
		const parts = message.parts.map((part) => {
			if (!isToolUIPart(part) || part.state !== "input-available" || ambiguous.has(part.toolCallId)) return part;
			const observed = completed.get(part.toolCallId)
				?? (hasToolResultMissingMetadata(part.toolMetadata) ? running.get(part.toolCallId) : undefined);
			if (!observed) return part;
			rowChanged = true;
			return observed;
		});
		if (!rowChanged) return message;
		changed = true;
		return { ...message, parts };
	});
	return changed ? result : incoming;
}
