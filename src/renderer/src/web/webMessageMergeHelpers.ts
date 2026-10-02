/** Pure identity, ordering, and coverage rules used by the Web timeline reconciler. */
import type { UIMessage } from "ai";
import type { ChatMessage } from "../../../shared/types";
import { readWebMessageMetadata, uiMessageIdentity, uiMessageRole } from "./webMessageMetadata";
import { mergeAdjacentWebMessageParts } from "./webMessageParts";

/** Inserts timestamped history before local rows that have no authoritative timestamp. */
export function findTimestampInsertionIndex(messages: UIMessage[], incoming: UIMessage): number {
	const timestamp = readWebMessageMetadata(incoming)?.timestamp;
	if (timestamp === undefined) return messages.length;
	let firstLaterIndex = messages.length;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidateTimestamp = readWebMessageMetadata(messages[index])?.timestamp;
		// Untimestamped local stream rows are not known to be older; keep them at the tail.
		if (candidateTimestamp === undefined) {
			firstLaterIndex = index;
			continue;
		}
		if (candidateTimestamp <= timestamp) return index + 1;
		firstLaterIndex = index;
	}
	return firstLaterIndex;
}

export function uiMessageText(message: UIMessage): string {
	return message.parts
		.map((part) => {
			if (part.type === "text" || part.type === "reasoning") return part.text;
			return "";
		})
		.join("");
}

export function sameUiMessage(left: UIMessage, right: UIMessage): boolean {
	return left.id === right.id
		&& left.role === right.role
		&& JSON.stringify(left.parts) === JSON.stringify(right.parts)
		// Metadata-only updates include settled ask_question cards, so they must replace the cache.
		&& JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null);
}

export function isEmptyUiMessage(message: UIMessage): boolean {
	return uiMessageText(message).trim().length === 0
		&& !message.parts.some((part) => part.type !== "text" && part.type !== "reasoning");
}

export function isLocalOnlyAssistantPlaceholder(message: UIMessage): boolean {
	if (uiMessageRole(message) !== "assistant") return false;
	if (readWebMessageMetadata(message)) return false;
	const hasVisibleText = message.parts.some((part) => part.type === "text" && part.text.trim());
	if (hasVisibleText) return false;
	return message.parts.some((part) =>
		part.type === "reasoning"
		|| part.type === "dynamic-tool"
		|| (typeof part.type === "string" && part.type.startsWith("tool-")),
	);
}

function leftoverPlaceholderToolIds(message: UIMessage): string[] {
	return message.parts.flatMap((part) => {
		if (
			part.type !== "dynamic-tool"
			&& !(typeof part.type === "string" && part.type.startsWith("tool-"))
		) return [];
		const toolCallId = Reflect.get(part, "toolCallId");
		return typeof toolCallId === "string" && toolCallId.trim() ? [toolCallId] : [];
	});
}

function hasUnidentifiedPlaceholderTool(message: UIMessage): boolean {
	return message.parts.some((part) => {
		if (
			part.type !== "dynamic-tool"
			&& !(typeof part.type === "string" && part.type.startsWith("tool-"))
		) return false;
		const toolCallId = Reflect.get(part, "toolCallId");
		return typeof toolCallId !== "string" || !toolCallId.trim();
	});
}

function leftoverReasoningText(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === "reasoning")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n");
}

function leftoverVisibleText(message: UIMessage): string {
	return message.parts
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n");
}

function rawReasoningCoverageText(message: UIMessage): string {
	return message.parts
		.map((part) => part.type === "reasoning" ? part.text : "")
		.filter((text) => text.length > 0)
		.join("\n");
}

function rawAnswerCoverageText(message: UIMessage): string {
	return message.parts
		.map((part) => part.type === "text" ? part.text : "")
		.filter((text) => text.length > 0)
		.join("\n");
}

/**
 * 本地 SSE 气泡按「段」列出 reasoning / text 原文（先合并相邻同类段）。
 * 为什么按段：一条本地气泡会包含多步（思考→工具→插入语→…→最终答案），
 * 而持久化侧每条 pi 消息只含其中一段；整体拼接后不可能是任何单条持久化行的前缀。
 * 先合并相邻段是因为 SSE 重连会把同一段拆成两个 part，拆开后后半段不是前缀。
 */
function localSegmentTexts(message: UIMessage, type: "reasoning" | "text"): string[] {
	return mergeAdjacentWebMessageParts(message.parts).flatMap((part) => {
		if (type === "reasoning" && part.type === "reasoning" && part.text.trim()) return [part.text];
		if (type === "text" && part.type === "text" && part.text.trim()) return [part.text];
		return [];
	});
}

export function isLocalSseAssistant(message: UIMessage): boolean {
	return uiMessageRole(message) === "assistant" && !readWebMessageMetadata(message);
}

/** A text-only SSE reply has no part-level evidence to distinguish it from another reply. */
export function isLocalSsePlainTextAssistant(message: UIMessage): boolean {
	if (!isLocalSseAssistant(message)) return false;
	const textParts = message.parts.filter((part) => part.type === "text" && part.text.trim());
	return textParts.length > 0 && message.parts.every((part) =>
		part.type === "text" || part.type === "step-start",
	);
}

/** Live SSE bubbles may combine reasoning, tools and answer text unlike persisted rows. */
export function isCombinedLocalSseAssistant(message: UIMessage): boolean {
	if (!isLocalSseAssistant(message)) return false;
	const hasReasoning = leftoverReasoningText(message).length > 0;
	const hasTool = leftoverPlaceholderToolIds(message).length > 0 || hasUnidentifiedPlaceholderTool(message);
	const hasText = leftoverVisibleText(message).length > 0;
	return (hasReasoning && hasText) || (hasReasoning && hasTool) || (hasTool && hasText);
}

function hasVisibleAssistantText(message: UIMessage): boolean {
	return message.parts.some((part) => part.type === "text" && part.text.trim());
}

/** Local reasoning/tool placeholders are removable only once a final answer is persisted. */
function snapshotHasSettledAssistant(authoritative: UIMessage[]): boolean {
	return authoritative.some((message) =>
		uiMessageRole(message) === "assistant" && hasVisibleAssistantText(message),
	);
}

function localSseCoveringIndices(leftover: UIMessage, authoritative: UIMessage[]): number[] {
	if (!isLocalSseAssistant(leftover)) return [];
	const leftoverText = leftoverReasoningText(leftover);
	const leftoverToolIds = leftoverPlaceholderToolIds(leftover);
	const leftoverAnswer = leftoverVisibleText(leftover);
	const covering: number[] = [];
	for (let index = 0; index < authoritative.length; index += 1) {
		const incoming = authoritative[index];
		if (leftoverText) {
			const incomingText = leftoverReasoningText(incoming);
			if (
				incomingText
				&& (incomingText === leftoverText
					|| incomingText.startsWith(leftoverText)
					|| leftoverText.startsWith(incomingText))
			) {
				covering.push(index);
				continue;
			}
		}
		if (leftoverToolIds.length > 0) {
			const incomingIdentity = uiMessageIdentity(incoming);
			if (
				(incomingIdentity && leftoverToolIds.some((id) => incomingIdentity === `tool:${id}`))
				|| leftoverPlaceholderToolIds(incoming).some((id) => leftoverToolIds.includes(id))
			) {
				covering.push(index);
				continue;
			}
		}
		if (leftoverAnswer) {
			const incomingAnswer = leftoverVisibleText(incoming);
			if (
				incomingAnswer
				&& (incomingAnswer === leftoverAnswer
					|| incomingAnswer.startsWith(leftoverAnswer)
					|| leftoverAnswer.startsWith(incomingAnswer))
			) covering.push(index);
		}
	}
	return covering;
}

/** Finds any authoritative row that covers a local SSE placeholder. */
export function isCoveredLocalSseAssistant(leftover: UIMessage, authoritative: UIMessage[]): boolean {
	return localSseCoveringIndices(leftover, authoritative).length > 0;
}

/** Text fallback may claim assistant rows only after the newest user turn. */
export function textFallbackRange(
	messages: UIMessage[],
	role: ChatMessage["role"],
	anchor?: UIMessage,
	sourceMessages: UIMessage[] = messages,
): { start: number; end: number } {
	if (role === "user") return { start: 0, end: messages.length };
	if (anchor) return sameTurnCoverageRange(messages, sourceMessages, anchor) ?? { start: messages.length, end: messages.length };
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (uiMessageRole(messages[index]) === "user") return { start: index + 1, end: messages.length };
	}
	return { start: 0, end: messages.length };
}

export function hasConflictingStableIdentity(candidate: UIMessage, incoming: UIMessage): boolean {
	const candidateIdentity = uiMessageIdentity(candidate);
	const incomingIdentity = uiMessageIdentity(incoming);
	return Boolean(candidateIdentity && incomingIdentity && candidateIdentity !== incomingIdentity);
}

export function haveConflictingTimestamps(candidate: UIMessage, incoming: UIMessage): boolean {
	if (uiMessageRole(incoming) !== "user") return false;
	const candidateTimestamp = readWebMessageMetadata(candidate)?.timestamp;
	const incomingTimestamp = readWebMessageMetadata(incoming)?.timestamp;
	return candidateTimestamp !== undefined
		&& incomingTimestamp !== undefined
		&& candidateTimestamp !== incomingTimestamp;
}

function sameTurnCoverageRange(
	messages: UIMessage[],
	sourceMessages: UIMessage[],
	anchor: UIMessage | undefined,
): { start: number; end: number } | undefined {
	if (!anchor || uiMessageRole(anchor) !== "user") return undefined;
	const users = (rows: UIMessage[]) => rows
		.map((message, index) => ({ message, index }))
		.filter(({ message }) => uiMessageRole(message) === "user");
	const targetUsers = users(messages);
	const sourceUsers = users(sourceMessages);
	let matchedIndex: number | undefined;

	// Resolve strong identity evidence by itself; never mix it with text candidates.
	const idMatches = targetUsers.filter(({ message }) => message.id === anchor.id);
	if (idMatches.length === 1) matchedIndex = idMatches[0].index;
	else if (idMatches.length > 1) return undefined;
	if (matchedIndex === undefined) {
		const anchorIdentity = uiMessageIdentity(anchor);
		if (anchorIdentity) {
			const identityMatches = targetUsers.filter(({ message }) => uiMessageIdentity(message) === anchorIdentity);
			if (identityMatches.length === 1) matchedIndex = identityMatches[0].index;
			else if (identityMatches.length > 1) return undefined;
		}
	}
	if (matchedIndex === undefined) {
		const timestamp = readWebMessageMetadata(anchor)?.timestamp;
		const anchorIdentity = uiMessageIdentity(anchor);
		const text = uiMessageText(anchor);
		if (timestamp !== undefined) {
			const sourceTimestampMatches = sourceUsers.filter(({ message }) =>
				uiMessageText(message) === text && readWebMessageMetadata(message)?.timestamp === timestamp,
			);
			const targetTimestampMatches = targetUsers.filter(({ message }) =>
				uiMessageText(message) === text
				&& readWebMessageMetadata(message)?.timestamp === timestamp
				&& !(anchorIdentity && uiMessageIdentity(message) && uiMessageIdentity(message) !== anchorIdentity),
			);
			if (sourceTimestampMatches.length === 1 && targetTimestampMatches.length === 1) {
				matchedIndex = targetTimestampMatches[0].index;
			}
		}
	}
	if (matchedIndex === undefined) {
		const text = uiMessageText(anchor);
		const anchorIdentity = uiMessageIdentity(anchor);
		const sourceTextMatches = sourceUsers.filter(({ message }) => uiMessageText(message) === text);
		const anchorTimestamp = readWebMessageMetadata(anchor)?.timestamp;
		const targetTextMatches = targetUsers.filter(({ message }) => {
			const candidateTimestamp = readWebMessageMetadata(message)?.timestamp;
			return uiMessageText(message) === text
				&& !(anchorIdentity && uiMessageIdentity(message) && uiMessageIdentity(message) !== anchorIdentity)
				// Different known timestamps identify different turns, even if this page has one matching text.
				&& !(anchorTimestamp !== undefined && candidateTimestamp !== undefined && anchorTimestamp !== candidateTimestamp);
		});
		if (sourceTextMatches.length === 1 && targetTextMatches.length === 1) {
			matchedIndex = targetTextMatches[0].index;
		}
	}
	if (matchedIndex === undefined) return undefined;
	const start = matchedIndex + 1;
	let end = messages.length;
	for (let index = start; index < messages.length; index += 1) {
		if (uiMessageRole(messages[index]) === "user") {
			end = index;
			break;
		}
	}
	return { start, end };
}

export function precedingUserMessage(messages: UIMessage[], beforeIndex: number): UIMessage | undefined {
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		if (uiMessageRole(messages[index]) === "user") return messages[index];
	}
	return undefined;
}

/**
 * True only when every local SSE part is covered, with same-turn evidence tracked separately.
 * 多步合并气泡按段逐一核对：每段 reasoning / text 都必须是本轮某条持久化行的前缀。
 */
export function isLocalSseFullyCovered(
	leftover: UIMessage,
	baseline: UIMessage[],
	anchor: UIMessage | undefined,
	sourceMessages: UIMessage[] = baseline,
): { fullyCovered: boolean; coveredInSameTurn: boolean } {
	if (!isLocalSseAssistant(leftover)) return { fullyCovered: false, coveredInSameTurn: false };
	const reasoningSegments = localSegmentTexts(leftover, "reasoning");
	const toolIds = leftoverPlaceholderToolIds(leftover);
	const answerSegments = localSegmentTexts(leftover, "text");
	// A same-turn text prefix cannot identify which distinct plain-text reply was persisted.
	if (isLocalSsePlainTextAssistant(leftover)) return { fullyCovered: false, coveredInSameTurn: false };
	// Do not infer that an unidentifiable tool call was persisted from its display text.
	if (hasUnidentifiedPlaceholderTool(leftover)) {
		return { fullyCovered: false, coveredInSameTurn: false };
	}
	if (reasoningSegments.length === 0 && toolIds.length === 0 && answerSegments.length === 0) {
		return { fullyCovered: false, coveredInSameTurn: false };
	}

	const coveredReasoning = new Set<number>();
	const coveredToolIds = new Set<string>();
	const coveredAnswer = new Set<number>();
	const turnRange = sameTurnCoverageRange(baseline, sourceMessages, anchor);
	let coveredInSameTurn = false;
	if (!turnRange) {
		// A tool-only bubble can precede loading its user anchor (e.g. ask_question).
		// A unique call id identifies that row without guessing text/turn ownership.
		// Never use this fallback for a conflicting anchor or any text/reasoning content.
		const coveredByUniqueCalls = !anchor && reasoningSegments.length === 0 && answerSegments.length === 0
			&& toolIds.length > 0 && toolIds.every((id) => baseline.filter((message) =>
				uiMessageIdentity(message) === `tool:${id}` || leftoverPlaceholderToolIds(message).includes(id),
			).length === 1);
		return { fullyCovered: coveredByUniqueCalls, coveredInSameTurn: coveredByUniqueCalls };
	}
	for (let index = turnRange.start; index < turnRange.end; index += 1) {
		const incoming = baseline[index];
		let coversPart = false;
		const incomingReasoning = rawReasoningCoverageText(incoming);
		if (incomingReasoning) {
			reasoningSegments.forEach((segment, segmentIndex) => {
				if (!coveredReasoning.has(segmentIndex) && incomingReasoning.startsWith(segment)) {
					coveredReasoning.add(segmentIndex);
					coversPart = true;
				}
			});
		}
		const incomingIdentity = uiMessageIdentity(incoming);
		const incomingToolIds = leftoverPlaceholderToolIds(incoming);
		for (const id of toolIds) {
			if (incomingIdentity === `tool:${id}` || incomingToolIds.includes(id)) {
				coveredToolIds.add(id);
				coversPart = true;
			}
		}
		const incomingAnswer = rawAnswerCoverageText(incoming);
		if (incomingAnswer) {
			answerSegments.forEach((segment, segmentIndex) => {
				if (!coveredAnswer.has(segmentIndex) && incomingAnswer.startsWith(segment)) {
					coveredAnswer.add(segmentIndex);
					coversPart = true;
				}
			});
		}
		if (coversPart) coveredInSameTurn = true;
	}
	return {
		fullyCovered: coveredReasoning.size === reasoningSegments.length
			&& toolIds.every((id) => coveredToolIds.has(id))
			&& coveredAnswer.size === answerSegments.length,
		coveredInSameTurn,
	};
}

/** User messages still use exact text fallback; only non-user roles use prefix matching. */
export function canMatchPartialText(role: ChatMessage["role"]): boolean {
	return role === "assistant" || role === "tool" || role === "system" || role === "error";
}
