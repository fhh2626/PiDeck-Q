import { atom, type Getter } from "jotai";
import type { SessionHistoryMessageTarget, SessionMessagePage } from "../../../shared/types";
import { sessionMessagesCacheAtom, sessionRecordsAtom, sessionRuntimeByIdAtom } from "./session-atoms";

/** A file page can replace a live transcript only while that exact runtime stays stopped. */
export function isStoppedHistoryCurrent(get: Getter, target: SessionHistoryMessageTarget, revision: number): boolean {
	const runtime = get(sessionRuntimeByIdAtom)[target.sessionId];
	const cache = get(sessionMessagesCacheAtom)[target.sessionId];
	return get(sessionRecordsAtom)[target.sessionId]?.filePath === target.filePath
		&& (runtime?.runtimeGeneration ?? 0) === target.runtimeGeneration
		&& (!runtime?.agentId || runtime.status === "closed" || runtime.status === "detached")
		&& cache?.source === "runtime" && cache.revision === revision;
}

/** Commits a complete stopped-session reload in one write, with no partial pages. */
export const restoreStoppedSessionMessagesAtom = atom(null, (get, set, input: {
	target: SessionHistoryMessageTarget;
	expectedRevision: number;
	page: SessionMessagePage;
}) => {
	if (!isStoppedHistoryCurrent(get, input.target, input.expectedRevision)) return false;
	const cache = get(sessionMessagesCacheAtom);
	set(sessionMessagesCacheAtom, {
		...cache,
		[input.target.sessionId]: {
			messages: input.page.messages,
			source: "disk",
			revision: input.expectedRevision + 1,
			updatedAt: Date.now(),
			page: { total: input.page.total, nextBefore: input.page.nextBefore },
		},
	});
	return true;
});
