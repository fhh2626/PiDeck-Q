import type { createStore } from "jotai/vanilla";
import type { ChatMessage, SessionHistoryMessageTarget, SessionMessagePage } from "../../../shared/types";
import { isSameSummaryCard } from "../../../shared/messageFingerprint";
import { countUserTurns, sessionMessagesCacheAtom } from "../atoms/session-atoms";
import { isStoppedHistoryCurrent, restoreStoppedSessionMessagesAtom } from "../atoms/stopped-session-history";
import { t } from "../i18n";

const HISTORY_PAGE_TURNS = 50;
const MIN_RELOAD_PAGE_BUDGET = 20;

/** Pages can both carry the summary at their shared boundary. Keep its canonical identity once. */
function joinHistoryPages(pages: SessionMessagePage[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const seen = new Set<string>();
	const summaries: ChatMessage[] = [];
	for (const page of [...pages].reverse()) {
		for (const message of page.messages) {
			const entryId = message.meta?.entryId;
			const key = typeof entryId === "string" && entryId ? `e:${entryId}` : `m:${message.id}`;
			const summary = message.role === "system" && (message.meta?.type === "compaction" || message.meta?.type === "branchSummary");
			if (seen.has(key) || summary && summaries.some((known) => isSameSummaryCard(known, message))) continue;
			seen.add(key);
			if (summary) summaries.push(message);
			messages.push(message);
		}
	}
	return messages;
}

/** Replaces transient UUID rows after stop with file-owned identities, preserving loaded depth. */
export async function refreshStoppedSessionHistory(target: SessionHistoryMessageTarget, deps: {
	store: ReturnType<typeof createStore>;
	readPage: (sessionId: string, before?: number, pageSize?: number,
		options?: { unit?: "message" | "turn"; beforeEntryId?: string }) => Promise<SessionMessagePage>;
}): Promise<boolean> {
	const { store } = deps;
	const original = store.get(sessionMessagesCacheAtom)[target.sessionId];
	if (!original || !isStoppedHistoryCurrent(store.get, target, original.revision)) return false;
	const visible = [...(original.history?.messages ?? []), ...original.messages];
	const firstConversationRow = visible.find((message) => message.role === "user" || message.role === "assistant"
		|| message.role === "tool" || message.role === "system" && message.meta?.type === "todoTask");
	// Compaction can retain an answer/tool fragment whose prompt is outside the
	// visible prefix. Include its owning turn when rebuilding full file pages.
	// Summary and diagnostic cards alone do not create another conversation turn.
	const hasLeadingFragment = firstConversationRow?.role === "assistant" || firstConversationRow?.role === "tool";
	const targetTurns = Math.max(1, countUserTurns(visible) + (hasLeadingFragment ? 1 : 0));
	// Byte limits can reduce a requested 50-turn page to one complete turn.
	// Bound work by the history already in memory, including a leading fragment.
	const maxPages = Math.max(MIN_RELOAD_PAGE_BUDGET, targetTurns + 1);
	const pages: SessionMessagePage[] = [];
	let turns = 0;
	let before: number | undefined;
	let beforeEntryId: string | undefined;
	let indexVersion: string | undefined;
	for (let index = 0; index < maxPages; index += 1) {
		const page = await deps.readPage(target.sessionId, before, HISTORY_PAGE_TURNS, { unit: "turn", beforeEntryId });
		if (!isStoppedHistoryCurrent(store.get, target, original.revision)) return false;
		if (index > 0 && page.indexVersion !== indexVersion) throw new Error(t("diagnostic.historyLoadFailed"));
		indexVersion = page.indexVersion;
		pages.push(page);
		turns += countUserTurns(page.messages);
		if (page.nextBefore === null || turns >= targetTurns) {
			return store.set(restoreStoppedSessionMessagesAtom, {
				target,
				expectedRevision: original.revision,
				page: { ...page, messages: joinHistoryPages(pages) },
			});
		}
		if (before !== undefined && page.nextBefore >= before || page.nextBeforeEntryId && page.nextBeforeEntryId === beforeEntryId) break;
		before = page.nextBefore;
		beforeEntryId = page.nextBeforeEntryId ?? undefined;
	}
	// Keep the old transcript if a file changes continuously or pagination stalls.
	throw new Error(t("diagnostic.historyLoadFailed"));
}
