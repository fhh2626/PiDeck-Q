/** Validates and reads the non-visual identity metadata shared by Web history and runtime rows. */
import type { UIMessage } from "ai";
import type { AskQuestionResultSummary, ChatMessage } from "../../../shared/types";
import { normalizeAskQuestionResultSummary } from "../../../shared/askQuestion";

/** Stable non-visual identity and ordering data carried with a Web UIMessage. */
export type WebMessageMetadata = {
	/** Original ChatMessage role; UIMessage can only express user/assistant/system. */
	chatRole: ChatMessage["role"];
	/** Orders history rows against runtime snapshots. */
	timestamp?: number;
	/** Stable Pi branch entry identity shared by runtime and history projections. */
	entryId?: string;
	/** Stable tool result identity; tool display text changes while execution proceeds. */
	toolCallId?: string;
	/** Normalized completed ask_question result used by the persistent answer card. */
	askQuestionResult?: AskQuestionResultSummary;
};

/** Reads only validated metadata fields from UI messages crossing the SSE/cache boundary. */
export function readWebMessageMetadata(message: UIMessage): WebMessageMetadata | undefined {
	const value = message.metadata;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const chatRole = Reflect.get(value, "chatRole");
	if (chatRole !== "user" && chatRole !== "assistant" && chatRole !== "tool" && chatRole !== "system" && chatRole !== "error") {
		return undefined;
	}
	const timestamp = Reflect.get(value, "timestamp");
	const entryId = Reflect.get(value, "entryId");
	const toolCallId = Reflect.get(value, "toolCallId");
	const askQuestionResult = normalizeAskQuestionResultSummary(
		Reflect.get(value, "askQuestionResult"),
	);
	return {
		chatRole,
		...(typeof timestamp === "number" ? { timestamp } : {}),
		...(typeof entryId === "string" && entryId ? { entryId } : {}),
		...(typeof toolCallId === "string" && toolCallId ? { toolCallId } : {}),
		...(askQuestionResult ? { askQuestionResult } : {}),
	};
}

/** Returns the original role, falling back to the UI role for local SSE messages. */
export function uiMessageRole(message: UIMessage): ChatMessage["role"] {
	return readWebMessageMetadata(message)?.chatRole ?? (message.role === "user" ? "user" : "assistant");
}

/** Stable identity is preferred over content matching for Pi-backed rows and tools. */
export function uiMessageIdentity(message: UIMessage): string | undefined {
	const metadata = readWebMessageMetadata(message);
	if (!metadata) return undefined;
	if (metadata.chatRole === "tool" && metadata.toolCallId) return `tool:${metadata.toolCallId}`;
	if (metadata.entryId) return `${metadata.chatRole}:entry:${metadata.entryId}`;
	return undefined;
}
