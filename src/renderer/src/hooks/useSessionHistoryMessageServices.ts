import { useMemo } from "react";
import { useStore } from "jotai";
import type { SessionHistoryMessageTarget } from "../../../shared/types";
import { bindSessionRuntimeAtom, sessionMessagesCacheAtom } from "../atoms/session-atoms";
import { sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily } from "../atoms/session-selectors";
import { desktopApi as api } from "../desktopApi";
import { activateHistoryMessageRuntime } from "../utils/historyMessageRuntime";
import { toSessionRuntimeTarget } from "../utils/sessionCommands";

/** Resolves saved-message actions from their owning session, independent of pane focus. */
export function useSessionHistoryMessageServices() {
	const store = useStore();
	return useMemo(() => {
		const readContext = (sessionId: string) => {
			const record = store.get(sessionRecordByIdAtomFamily(sessionId));
			if (!record?.filePath) return undefined;
			const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
			return {
				filePath: record.filePath,
				projectId: record.projectId,
				runtimeGeneration: runtime?.runtimeGeneration ?? 0,
				agentId: runtime?.agentId,
				status: runtime?.status,
			};
		};
		return {
			getHistoryCommandContext: readContext,
			getMessageForSession: (sessionId: string, messageId: string) => {
				const cache = store.get(sessionMessagesCacheAtom)[sessionId];
				// Live snapshots and paged file history coexist in the same pane.
				return cache?.messages.find((message) => message.id === messageId)
					?? cache?.history?.messages.find((message) => message.id === messageId);
			},
			activateHistoryRuntime: (target: SessionHistoryMessageTarget) => activateHistoryMessageRuntime(target, {
				readContext,
				activate: api.sessions.activateRuntime,
				bind: (runtime) => store.set(bindSessionRuntimeAtom, runtime),
				readTarget: (sessionId) => toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))),
			}),
		};
	}, [store]);
}
