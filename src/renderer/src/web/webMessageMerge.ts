/** Reconciles persisted history with local Web SSE messages without losing timeline order. */
import type { UIMessage } from "ai";
import { reconcileWebMessageIdentities } from "./webMessageReconciliation";
import { preserveSettledWebTools } from "./webToolStateMerge";
import { isWebToolPart, webMessageContentKey } from "./webMessageParts";
import { readWebMessageMetadata, uiMessageIdentity, uiMessageRole } from "./webMessageMetadata";
import {
	canMatchPartialText,
	findTimestampInsertionIndex,
	hasConflictingStableIdentity,
	haveConflictingTimestamps,
	isCombinedLocalSseAssistant,
	isCoveredLocalSseAssistant,
	isEmptyUiMessage,
	isLocalOnlyAssistantPlaceholder,
	isLocalSseAssistant,
	isLocalSseFullyCovered,
	isLocalSsePlainTextAssistant,
	precedingUserMessage,
	sameUiMessage,
	textFallbackRange,
	uiMessageText,
} from "./webMessageMergeHelpers";

/** User messages with repeated text require identity, timestamp, or unique sequence evidence. */
function canFallbackMatchUserMessageByText(
	candidate: UIMessage,
	incoming: UIMessage,
	current: UIMessage[],
	authoritative: UIMessage[],
): boolean {
	if (uiMessageRole(incoming) !== "user") return true;
	// Identical captions/placeholders do not identify different image submissions.
	if (webMessageContentKey(candidate) !== webMessageContentKey(incoming)) return false;
	const candidateIdentity = uiMessageIdentity(candidate);
	const incomingIdentity = uiMessageIdentity(incoming);
	if (candidateIdentity && incomingIdentity) return candidateIdentity === incomingIdentity;
	const candidateTimestamp = readWebMessageMetadata(candidate)?.timestamp;
	const incomingTimestamp = readWebMessageMetadata(incoming)?.timestamp;
	if (candidateTimestamp !== undefined && incomingTimestamp !== undefined) {
		if (candidateTimestamp !== incomingTimestamp) return false;
		const text = uiMessageText(incoming);
		const countTimestampedMatches = (messages: UIMessage[]) => messages.filter((message) =>
			uiMessageRole(message) === "user"
			&& uiMessageText(message) === text
			&& readWebMessageMetadata(message)?.timestamp === incomingTimestamp,
		).length;
		return countTimestampedMatches(current) === 1 && countTimestampedMatches(authoritative) === 1;
	}
	const text = uiMessageText(incoming);
	const countMatchingUsers = (messages: UIMessage[]) => messages.filter(
		(message) => uiMessageRole(message) === "user" && uiMessageText(message) === text,
	).length;
	// When either side lacks a stable key, duplicate prompts cannot be paired by reverse text order.
	return countMatchingUsers(current) === 1 && countMatchingUsers(authoritative) === 1;
}

/** A partial history page cannot prove that its only same-text user is the live optimistic turn. */
function hasLocalUserReplyEvidence(
	candidate: UIMessage,
	incoming: UIMessage,
	current: UIMessage[],
	authoritative: UIMessage[],
): boolean {
	if (readWebMessageMetadata(candidate)) return true;
	const sourceIndex = current.findIndex((message) => message.id === candidate.id);
	if (sourceIndex < 0) return false;
	const nextUserIndex = current.findIndex((message, index) => index > sourceIndex && uiMessageRole(message) === "user");
	// Only the newest cached turn can still be an unpersisted optimistic turn.
	if (nextUserIndex >= 0) return true;
	const sourceReplies = current.slice(sourceIndex + 1).filter((message) => uiMessageRole(message) === "assistant");
	const historyRange = textFallbackRange(authoritative, "assistant", incoming, authoritative);
	const historyReplies = authoritative.slice(historyRange.start, historyRange.end);
	for (const reply of sourceReplies) {
		const identity = uiMessageIdentity(reply);
		if (historyReplies.some((persisted) =>
			reply.id === persisted.id || (identity !== undefined && identity === uiMessageIdentity(persisted)),
		)) return true;
		const coverage = isLocalSseFullyCovered(reply, authoritative, candidate, current);
		if (coverage.fullyCovered && coverage.coveredInSameTurn) return true;
	}
	return false;
}

/** An older cached reply before the next user can still reconcile with its history row. */
function hasLaterUserAfterMessage(message: UIMessage, current: UIMessage[]): boolean {
	const index = current.findIndex((candidate) => candidate.id === message.id);
	return index >= 0 && current.some((candidate, candidateIndex) =>
		candidateIndex > index && uiMessageRole(candidate) === "user",
	);
}

/** Limit idle recovery's optimistic-user protection to a live visible answer in that turn. */
function hasLocalPlainTextReplyAfterUser(candidate: UIMessage, current: UIMessage[]): boolean {
	const index = current.findIndex((message) => message.id === candidate.id);
	if (index < 0) return false;
	const nextUser = current.findIndex((message, candidateIndex) =>
		candidateIndex > index && uiMessageRole(message) === "user",
	);
	return current.slice(index + 1, nextUser < 0 ? current.length : nextUser).some(isLocalSsePlainTextAssistant);
}

function hasEarlierPersistedAssistantInTurn(message: UIMessage, current: UIMessage[]): boolean {
	const sourceIndex = current.findIndex((candidate) => candidate.id === message.id);
	if (sourceIndex < 0) return false;
	const anchor = precedingUserMessage(current, sourceIndex);
	if (!anchor) return false;
	const range = textFallbackRange(current, "assistant", anchor, current);
	return current.slice(range.start, sourceIndex).some((candidate) =>
		uiMessageRole(candidate) === "assistant" && readWebMessageMetadata(candidate) !== undefined,
	);
}

/**
 * 空闲快照清理「孤儿乐观提问」。
 * 背景：本地 SSE 提问气泡没有 metadata，纯文本回复又拿不到配对证据，
 * 快照合并后本地回复已被持久化行替换，只剩这条本地提问垫在时间线底部（重复提问）。
 * 只有同时满足以下条件才判为孤儿：它原本有本地回复且这些回复都已被消化、
 * 它后面已没有任何内容、快照最后一条提问正是同一文本且已有正文回复。
 * 「原本有本地回复」用来保护发送失败、从未得到回复的新提问（它必须留在界面上）。
 */
function isOrphanedOptimisticUser(
	leftover: UIMessage,
	mergedIndex: number,
	merged: UIMessage[],
	current: UIMessage[],
	authoritative: UIMessage[],
): boolean {
	if (uiMessageRole(leftover) !== "user" || readWebMessageMetadata(leftover)) return false;
	const sourceIndex = current.findIndex((message) => message.id === leftover.id);
	if (sourceIndex < 0) return false;
	const nextUserInCurrent = current.findIndex((message, index) =>
		index > sourceIndex && uiMessageRole(message) === "user",
	);
	const localReplies = current
		.slice(sourceIndex + 1, nextUserInCurrent < 0 ? current.length : nextUserInCurrent)
		.filter(isLocalSseAssistant);
	if (localReplies.length === 0) return false;
	const mergedIds = new Set(merged.map((message) => message.id));
	if (localReplies.some((reply) => mergedIds.has(reply.id))) return false;
	const nextInMerged = merged[mergedIndex + 1];
	if (nextInMerged && uiMessageRole(nextInMerged) !== "user") return false;
	let lastUserIndex = -1;
	for (let index = authoritative.length - 1; index >= 0; index -= 1) {
		if (uiMessageRole(authoritative[index]) === "user") {
			lastUserIndex = index;
			break;
		}
	}
	if (lastUserIndex < 0 || uiMessageText(authoritative[lastUserIndex]) !== uiMessageText(leftover)) return false;
	return authoritative.slice(lastUserIndex + 1).some((message) =>
		uiMessageRole(message) === "assistant"
		&& message.parts.some((part) => part.type === "text" && part.text.trim()),
	);
}

/** Text fallbacks only compare cached rows that originated in the incoming message's turn. */
function candidateBelongsToIncomingTurn(
	candidate: UIMessage,
	current: UIMessage[],
	authoritative: UIMessage[],
	incomingAnchor: UIMessage | undefined,
): boolean {
	if (!incomingAnchor) return true;
	const sourceIndex = current.findIndex((message) => message.id === candidate.id);
	if (sourceIndex < 0) return false;
	const range = textFallbackRange(current, "assistant", incomingAnchor, authoritative);
	return sourceIndex >= range.start && sourceIndex < range.end;
}

/**
 * Reconciles Web useChat's local cache with authoritative runtime/history rows.
 * Stable ids win; text fallbacks are confined to the originating user turn.
 */
export function mergeAuthoritativeUiMessages(
	current: UIMessage[],
	authoritative: UIMessage[],
	options?: {
		dropUnmatchedTrailingPlaceholders?: boolean;
		dropCoveredLocalSseLeftovers?: boolean;
	},
): UIMessage[] {
	if (authoritative.length === 0) return current;
	const reconciled = reconcileWebMessageIdentities(current, authoritative);
	// A final SSE bubble can settle tools that are still running in the cached snapshot.
	current = preserveSettledWebTools(reconciled.incoming, reconciled.current);
	authoritative = preserveSettledWebTools(current, reconciled.incoming);
	const merged = [...current];
	const matchedCurrent = new Set<number>();
	let changed = false;
	// Authoritative rows are chronological; cached stream rows usually lack timestamps.
	let lastPlacedIndex = -1;

	for (let incomingIndex = 0; incomingIndex < authoritative.length; incomingIndex += 1) {
		const incoming = authoritative[incomingIndex];
		const incomingTurnAnchor = precedingUserMessage(authoritative, incomingIndex);
		// Keep the source stream's user-turn anchor before inserting/reordering history rows.
		if (options?.dropCoveredLocalSseLeftovers === true && isLocalSseAssistant(incoming)) {
			const coverage = isLocalSseFullyCovered(
				incoming,
				current,
				precedingUserMessage(authoritative, incomingIndex),
			);
			if (coverage.fullyCovered && coverage.coveredInSameTurn) {
				continue;
			}
		}
		let matchIndex = -1;
		for (let index = 0; index < merged.length; index += 1) {
			if (!matchedCurrent.has(index) && merged[index].id === incoming.id) {
				matchIndex = index;
				break;
			}
		}

		const incomingIdentity = uiMessageIdentity(incoming);
		if (matchIndex < 0 && incomingIdentity) {
			for (let index = 0; index < merged.length; index += 1) {
				if (
					!matchedCurrent.has(index)
					&& uiMessageIdentity(merged[index]) === incomingIdentity
				) {
					matchIndex = index;
					break;
				}
			}
		}

		const incomingText = uiMessageText(incoming);
		const incomingRole = uiMessageRole(incoming);
		// A bounded history page can start mid-turn; without its user anchor, never claim
		// an unidentified assistant from the latest cached turn by text alone.
		const textRange = (options?.dropCoveredLocalSseLeftovers === true
			|| options?.dropUnmatchedTrailingPlaceholders === true)
			&& incomingRole === "assistant" && !incomingTurnAnchor
			? { start: merged.length, end: merged.length }
			: textFallbackRange(merged, incomingRole, incomingTurnAnchor, authoritative);
		// A combined stream row cannot be identified by the text of just one split row,
		// including during idle replay or final-frame cache writes.
		const preserveUncoveredCombined = isCombinedLocalSseAssistant(incoming)
			|| (isLocalSseAssistant(incoming) && incoming.parts.some(isWebToolPart));
		const preserveUnidentifiedPlainText = options?.dropCoveredLocalSseLeftovers === true
			&& isLocalSsePlainTextAssistant(incoming);
		if (matchIndex < 0 && !preserveUncoveredCombined) {
			for (let index = textRange.end - 1; index >= textRange.start; index -= 1) {
				const candidate = merged[index];
				if (
					matchedCurrent.has(index)
					|| uiMessageRole(candidate) !== incomingRole
					|| hasConflictingStableIdentity(candidate, incoming)
					|| !canFallbackMatchUserMessageByText(candidate, incoming, current, authoritative)
					|| (incomingRole === "user"
						&& (options?.dropCoveredLocalSseLeftovers === true
							|| (options?.dropUnmatchedTrailingPlaceholders === true
								&& hasLocalPlainTextReplyAfterUser(candidate, current)))
						&& !hasLocalUserReplyEvidence(candidate, incoming, current, authoritative))
					|| (incomingRole !== "user" && !candidateBelongsToIncomingTurn(candidate, current, authoritative, incomingTurnAnchor))
					|| ((isCombinedLocalSseAssistant(candidate) || (isLocalSseAssistant(candidate) && candidate.parts.some(isWebToolPart)))
						&& (options?.dropCoveredLocalSseLeftovers === true || !isLocalSseFullyCovered(
							candidate, authoritative,
							precedingUserMessage(current, current.findIndex((row) => row.id === candidate.id)), current,
						).fullyCovered))
					|| (options?.dropCoveredLocalSseLeftovers === true && isLocalSsePlainTextAssistant(candidate)
						&& !hasLaterUserAfterMessage(candidate, current))
					|| (isLocalSsePlainTextAssistant(candidate) && hasEarlierPersistedAssistantInTurn(candidate, current))
					|| preserveUnidentifiedPlainText
					|| haveConflictingTimestamps(candidate, incoming)
					|| uiMessageText(candidate) !== incomingText
				) continue;
				matchIndex = index;
				break;
			}
		}

		// Match a partial local answer against its authoritative version within this turn only.
		if (matchIndex < 0 && !preserveUncoveredCombined && incomingText && canMatchPartialText(incomingRole)) {
			for (let index = textRange.end - 1; index >= textRange.start; index -= 1) {
				const candidate = merged[index];
				const candidateText = uiMessageText(candidate);
				if (
					matchedCurrent.has(index)
					|| uiMessageRole(candidate) !== incomingRole
					|| hasConflictingStableIdentity(candidate, incoming)
					|| (incomingRole !== "user" && !candidateBelongsToIncomingTurn(candidate, current, authoritative, incomingTurnAnchor))
					|| !candidateText
					|| isLocalOnlyAssistantPlaceholder(candidate)
					|| isCombinedLocalSseAssistant(candidate)
					|| (options?.dropCoveredLocalSseLeftovers === true && isLocalSsePlainTextAssistant(candidate)
						&& !hasLaterUserAfterMessage(candidate, current))
					|| (isLocalSsePlainTextAssistant(candidate) && hasEarlierPersistedAssistantInTurn(candidate, current))
					|| !incomingText.startsWith(candidateText)
				) continue;
				matchIndex = index;
				break;
			}
		}

		if (matchIndex >= 0) {
			// Cached rows can be out of order after an earlier merge. Reposition a match that
			// predates the previous authoritative row so reconnect heals the visible timeline.
			if (matchIndex < lastPlacedIndex) {
				merged.splice(matchIndex, 1);
				const shiftedAfterRemoval = [...matchedCurrent].map((index) =>
					index > matchIndex ? index - 1 : index,
				);
				matchedCurrent.clear();
				for (const index of shiftedAfterRemoval) matchedCurrent.add(index);
				lastPlacedIndex -= 1;

				const insertionIndex = lastPlacedIndex + 1;
				const shiftedAfterInsertion = [...matchedCurrent].map((index) =>
					index >= insertionIndex ? index + 1 : index,
				);
				matchedCurrent.clear();
				for (const index of shiftedAfterInsertion) matchedCurrent.add(index);
				merged.splice(insertionIndex, 0, incoming);
				matchedCurrent.add(insertionIndex);
				lastPlacedIndex = insertionIndex;
				changed = true;
				continue;
			}
			matchedCurrent.add(matchIndex);
			if (!sameUiMessage(merged[matchIndex], incoming)) {
				merged[matchIndex] = incoming;
				changed = true;
			}
			lastPlacedIndex = matchIndex;
			continue;
		}

		const insertionIndex = lastPlacedIndex >= 0
			? lastPlacedIndex + 1
			: findTimestampInsertionIndex(merged, incoming);
		// Keep matchedCurrent aligned when an older history row is inserted before a match.
		if (insertionIndex < merged.length) {
			const shifted = [...matchedCurrent]
				.filter((index) => index >= insertionIndex)
				.map((index) => index + 1);
			for (const index of [...matchedCurrent]) {
				if (index >= insertionIndex) matchedCurrent.delete(index);
			}
			for (const index of shifted) matchedCurrent.add(index);
		}
		merged.splice(insertionIndex, 0, incoming);
		matchedCurrent.add(insertionIndex);
		lastPlacedIndex = insertionIndex;
		changed = true;
	}

	// Drop the empty optimistic user bubble only after the snapshot includes its real turn.
	const canDropUnmatchedPlaceholders =
		options?.dropUnmatchedTrailingPlaceholders === true
		&& authoritative.some((message) =>
			uiMessageRole(message) === "assistant"
			&& message.parts.some((part) => part.type === "text" && part.text.trim()),
		);
	// A page starting with an assistant lacks the user-turn evidence needed to
	// clean up a later text-only live answer just because their text overlaps.
	const unanchoredPageAssistant = authoritative.some((message, messageIndex) =>
		uiMessageRole(message) === "assistant"
		&& !precedingUserMessage(authoritative, messageIndex),
	);
	for (let index = merged.length - 1; index >= 0; index -= 1) {
		if (matchedCurrent.has(index)) continue;
		const leftover = merged[index];
		const dropEmptyUser = uiMessageRole(leftover) === "user" && isEmptyUiMessage(leftover);
		const strictBaselineMode = options?.dropCoveredLocalSseLeftovers === true;
		const covered = strictBaselineMode ? false : isCoveredLocalSseAssistant(leftover, authoritative);
		const sourceIndex = current.findIndex((message) => message.id === leftover.id);
		const needsFullCoverage = isCombinedLocalSseAssistant(leftover) || leftover.parts.some(isWebToolPart);
		// Idle snapshots may still be older than the last SSE frame. Like disk history,
		// they must cover ALL segments/tools, including tool-only frames.
		const baselineCoverage = (strictBaselineMode || needsFullCoverage) && sourceIndex >= 0
			? isLocalSseFullyCovered(
				leftover,
				authoritative,
				precedingUserMessage(current, sourceIndex),
				current,
			)
			: undefined;
		const fullyCovered = baselineCoverage?.fullyCovered === true && baselineCoverage.coveredInSameTurn;
		const dropCoveredBaselineBubble = strictBaselineMode && fullyCovered;
		const dropPlaceholder = (!needsFullCoverage || fullyCovered) && isLocalOnlyAssistantPlaceholder(leftover) && (
			(!strictBaselineMode && covered)
			|| (!strictBaselineMode && canDropUnmatchedPlaceholders)
		);
		const dropCoveredSseWithText = !strictBaselineMode
			&& canDropUnmatchedPlaceholders
			&& covered
			&& (!needsFullCoverage || fullyCovered)
			&& isLocalSseAssistant(leftover)
			&& !(isLocalSsePlainTextAssistant(leftover)
				&& (hasEarlierPersistedAssistantInTurn(leftover, current) || unanchoredPageAssistant));
		// 孤儿乐观提问：只在空闲快照（非严格基线）且快照已有正文回复时清理。
		// 循环自后向前，执行到这里时该提问之后的本地回复已先被处理，孤立判定才准确。
		const dropOrphanUser = !strictBaselineMode
			&& canDropUnmatchedPlaceholders
			&& isOrphanedOptimisticUser(leftover, index, merged, current, authoritative);
		if (!dropEmptyUser && !dropPlaceholder && !dropCoveredSseWithText && !dropCoveredBaselineBubble && !dropOrphanUser) continue;
		merged.splice(index, 1);
		changed = true;
	}

	return changed ? merged : current;
}

/** Prepends older history without disturbing the streaming tail; overlaps keep the cached row. */
export function prependOlderHistoryPage(older: UIMessage[], current: UIMessage[]): UIMessage[] {
	if (older.length === 0) return current;
	// The same pairing policy serves both tail recovery and overlapping disk pages.
	const reconciled = reconcileWebMessageIdentities(current, older);
	current = reconciled.current;
	older = reconciled.incoming;
	const currentIds = new Set(current.map((message) => message.id));
	const currentIdentities = new Set(
		current
			.map((message) => uiMessageIdentity(message))
			.filter((identity): identity is string => identity !== undefined),
	);
	const uniqueOlder = older.filter((message) => {
		if (currentIds.has(message.id)) return false;
		const identity = uiMessageIdentity(message);
		return identity === undefined || !currentIdentities.has(identity);
	});
	if (uniqueOlder.length === 0) return current;
	return [...uniqueOlder, ...current];
}
