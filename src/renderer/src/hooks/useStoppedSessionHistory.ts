import { useEffect, useRef } from "react";
import { useAtomValue, useStore } from "jotai";
import type { SessionMessageCommandTarget } from "../../../shared/types";
import { sessionMessageCacheBySessionIdAtomFamily } from "../atoms/session-atoms";
import { isStoppedHistoryCurrent } from "../atoms/stopped-session-history";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { refreshStoppedSessionHistory } from "../utils/stoppedSessionHistory";

/** File-backed rows remain actionable after their old process and UUID cache disappear. */
export function useStoppedSessionHistory(
	target: SessionMessageCommandTarget | undefined,
	showToast: (message: string, duration?: number) => void,
): boolean {
	const store = useStore();
	const toastRef = useRef(showToast);
	toastRef.current = showToast;
	const historyTarget = target && "kind" in target ? target : undefined;
	// A live pane's streaming cache belongs to the timeline, not this injector-level hook.
	const cache = useAtomValue(sessionMessageCacheBySessionIdAtomFamily(historyTarget?.sessionId ?? ""));
	const needsRefresh = Boolean(historyTarget && cache && isStoppedHistoryCurrent(store.get, historyTarget, cache.revision));
	useEffect(() => {
		if (!historyTarget || !needsRefresh) return;
		let cancelled = false;
		void refreshStoppedSessionHistory(historyTarget, { store, readPage: api.sessions.readRecordMessagePage }).catch(() => {
			if (!cancelled) toastRef.current(t("diagnostic.historyLoadFailed"), 5000);
		});
		return () => { cancelled = true; };
	}, [store, historyTarget?.sessionId, historyTarget?.filePath, historyTarget?.runtimeGeneration, cache?.revision, needsRefresh]);
	// A row without a persistent identity must be replaced before editing it.
	return !needsRefresh;
}
