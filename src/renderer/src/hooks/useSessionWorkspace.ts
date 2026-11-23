import { useCallback, useEffect, useRef, useState } from "react";
import type { AppFocusSessionTarget } from "../../../shared/types";
import { useAtomValue, useStore } from "jotai";
import { sessionRecordByIdAtomFamily, sessionRecordsAtom } from "../atoms";
import {
  buildSplitLayoutFromDrop,
  canAcceptSplitDrop,
  edgeToOrientation,
  insertRootPaneFromDrop,
  nestSplitPaneFromDrop,
  pruneSessionSplitLayout,
  replaceSplitPaneFromDrop,
  resolveSplitAfterClose,
  splitLayoutSessionIds,
  type SessionSplitDropTarget,
  type SessionSplitLayout,
} from "../utils/sessionSplitEdge";

export type SessionWorkspaceFocusHandlers = {
  focusSession: (projectId: string, sessionId: string) => void;
  focusProject: (projectId: string) => void;
};

/** Own sidebar drag/split layout and notification focus, independently of session lifetimes. */
export function useSessionWorkspace(options: {
  currentSessionId: string | undefined;
  activeProjectId: string | undefined;
  /** Shared with session actions so pending notifications respect newer navigation. */
  selectionRequestRef: { readonly current: number };
}) {
  const { currentSessionId, activeProjectId, selectionRequestRef } = options;
  const store = useStore();
  const sessionRecords = useAtomValue(sessionRecordsAtom);
  const [splitLayout, setSplitLayout] = useState<SessionSplitLayout | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const focusHandlersRef = useRef<SessionWorkspaceFocusHandlers>({
    focusSession: () => undefined,
    focusProject: () => undefined,
  });
  const latestFocusTargetIdRef = useRef<string | null>(null);
  const snapshotRef = useRef({ splitLayout, currentSessionId, activeProjectId });
  snapshotRef.current = { splitLayout, currentSessionId, activeProjectId };
  const previousSelectionRef = useRef({ currentSessionId, activeProjectId });

  // Update the command snapshot immediately, so consecutive drops cannot overwrite each other.
  const commitLayout = useCallback((layout: SessionSplitLayout | null) => {
    snapshotRef.current.splitLayout = layout;
    setSplitLayout(layout);
  }, []);

  useEffect(() => {
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = { currentSessionId, activeProjectId };
    const layout = snapshotRef.current.splitLayout;
    const layoutIds = layout ? splitLayoutSessionIds(layout) : [];
    const survivors = layoutIds.filter((id) => Boolean(sessionRecords[id]));
    if (layout && survivors.length !== layoutIds.length) {
      commitLayout(pruneSessionSplitLayout(layout, new Set(survivors)));
    }
    // removeSessionState clears selection as well as the record. Keep a surviving split
    // pane focused, but never undo an explicit switch to a different project.
    const removedId = currentSessionId && !sessionRecords[currentSessionId]
      ? currentSessionId
      : !currentSessionId && previous.currentSessionId &&
          previous.activeProjectId === activeProjectId && !sessionRecords[previous.currentSessionId]
        ? previous.currentSessionId : undefined;
    if (!removedId) return;
    const nextId = layoutIds.includes(removedId) ? survivors[0] : undefined;
    const record = nextId ? sessionRecords[nextId] : undefined;
    if (record) focusHandlersRef.current.focusSession(record.projectId, record.id);
    else if (activeProjectId) focusHandlersRef.current.focusProject(activeProjectId);
  }, [sessionRecords, currentSessionId, activeProjectId, commitLayout]);

  useEffect(() => {
    let disposed = false;
    const retries = new Set<ReturnType<typeof setTimeout>>();
    const clearRetries = () => {
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
    };
    let initialPendingPullStarted = false;
    let receivedPushAfterInitialPullStarted = false;
    // A newer notification supersedes every retry scheduled for an older target.
    // Without this gate, a late catalog load could focus an obsolete session after
    // the user has already clicked a second notification.
    const initialSelectionRequest = selectionRequestRef.current;
    const focusByTarget = (target: AppFocusSessionTarget, selectionRequest = selectionRequestRef.current) => {
      clearRetries();
      latestFocusTargetIdRef.current = target.id;
      const tryFocus = (attempt: number) => {
        if (disposed || latestFocusTargetIdRef.current !== target.id) return;
        if (selectionRequest !== selectionRequestRef.current) {
          // Consume only this obsolete target so a reload cannot replay it. The host
          // compares IDs, protecting a newer notification from a delayed ACK.
          void window.piDesktop.app.ackFocusSessionTarget(target.id).catch(() => undefined);
          return;
        }
        const record = store.get(sessionRecordByIdAtomFamily(target.sessionId));
        if (record) {
          if (latestFocusTargetIdRef.current !== target.id) return;
          focusHandlersRef.current.focusSession(record.projectId, record.id);
          // ACK only after the stable SessionRecord was found and focus was dispatched.
          // NativeHost compares the id, so a late ACK cannot clear a newer notification.
          void window.piDesktop.app.ackFocusSessionTarget(target.id).catch(() => undefined);
          return;
        }
        if (attempt < 15) {
          const timer = setTimeout(() => {
            retries.delete(timer);
            tryFocus(attempt + 1);
          }, 200);
          retries.add(timer);
        }
      };
      tryFocus(0);
    };

    const unsubscribe = window.piDesktop.app.onFocusSessionTarget((target) => {
      if (initialPendingPullStarted) receivedPushAfterInitialPullStarted = true;
      focusByTarget(target);
    });
    // The pull snapshots the host's pending target. If a push arrives after that
    // snapshot starts, let the push win rather than replaying the older response.
    initialPendingPullStarted = true;
    void window.piDesktop.app.getPendingFocusTarget?.().then((target) => {
      if (disposed || !target || receivedPushAfterInitialPullStarted) return;
      focusByTarget(target, initialSelectionRequest);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      clearRetries();
      unsubscribe();
    };
  }, [store, selectionRequestRef]);

  /** Selection stays owned by session actions; commands use the currently committed handlers. */
  const bindFocusHandlers = useCallback((handlers: SessionWorkspaceFocusHandlers) => {
    focusHandlersRef.current = handlers;
  }, []);

  const dropSplit = useCallback((draggedSessionId: string, target: SessionSplitDropTarget) => {
    setDraggingSessionId(null);
    const snap = snapshotRef.current;
    const draggedRecord = store.get(sessionRecordByIdAtomFamily(draggedSessionId));
    const hitRecord = store.get(sessionRecordByIdAtomFamily(target.sessionId));
    if (!draggedRecord || !hitRecord || !snap.currentSessionId) return;
    // A remembered layout is hidden while a different sidebar session is selected.
    // Only the visible pane(s) may accept a drop; stale DOM targets cannot mutate it.
    const layout = snap.splitLayout && splitLayoutSessionIds(snap.splitLayout).includes(snap.currentSessionId)
      ? snap.splitLayout : null;
    const targetVisible = layout
      ? splitLayoutSessionIds(layout).includes(target.sessionId)
      : target.sessionId === snap.currentSessionId;
    if (!targetVisible || !canAcceptSplitDrop({
      layout,
      draggedSessionId,
      sessionId: target.sessionId,
      edge: target.kind === "session-edge" ? target.edge : null,
    })) return;
    const next = !layout
      ? target.kind === "session-edge" ? buildSplitLayoutFromDrop({
          hostSessionId: target.sessionId, draggedSessionId, edge: target.edge,
        }) : null
      : target.kind === "session-center"
        ? replaceSplitPaneFromDrop({ layout, draggedSessionId, sessionId: target.sessionId })
        : edgeToOrientation(target.edge) === layout.orientation
          ? insertRootPaneFromDrop({ layout, draggedSessionId, sessionId: target.sessionId, edge: target.edge })
          : nestSplitPaneFromDrop({ layout, draggedSessionId, sessionId: target.sessionId, edge: target.edge });
    if (!next) return;
    commitLayout(next);
    if (target.kind === "session-center" && target.sessionId === snap.currentSessionId) {
      focusHandlersRef.current.focusSession(draggedRecord.projectId, draggedSessionId);
    }
  }, [commitLayout, store]);

  const beginDrag = useCallback((sessionId: string) => setDraggingSessionId(sessionId), []);
  const endDrag = useCallback(() => setDraggingSessionId(null), []);

  /** Expand this session to solo while preserving the remaining panes for sidebar navigation. */
  const exitSplit = useCallback((sessionId: string) => {
    const layout = snapshotRef.current.splitLayout;
    if (!layout || !splitLayoutSessionIds(layout).includes(sessionId)) return;
    const resolved = resolveSplitAfterClose(layout, sessionId);
    commitLayout(resolved && "layout" in resolved ? resolved.layout : null);
    const record = store.get(sessionRecordByIdAtomFamily(sessionId));
    if (record) focusHandlersRef.current.focusSession(record.projectId, sessionId);
  }, [commitLayout, store]);
  const exitAllSplit = useCallback(() => commitLayout(null), [commitLayout]);

  return { splitLayout, draggingSessionId, bindFocusHandlers, dropSplit, beginDrag, endDrag, exitSplit, exitAllSplit };
}
