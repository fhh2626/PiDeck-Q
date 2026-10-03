import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { SessionPaneActions } from "../components/session/SessionPaneServices";

/** Stable UI command identity with the latest committed implementation, not a frozen default target. */
export function useLatestPaneCommand<Args extends unknown[], Result>(command: (...args: Args) => Result): (...args: Args) => Result;
export function useLatestPaneCommand<Args extends unknown[], Result>(command: ((...args: Args) => Result) | undefined): ((...args: Args) => Result) | undefined;
export function useLatestPaneCommand<Args extends unknown[], Result>(command: ((...args: Args) => Result) | undefined) {
  const latest = useRef(command);
  useLayoutEffect(() => {
    latest.current = command;
    return () => { latest.current = undefined; };
  }, [command]);
  const invoke = useCallback((...args: Args): Result => {
    const current = latest.current;
    // Capability disappearance/unmount must not dispatch through a stale owner's closure.
    if (!current) throw new Error("SESSION_PANE_COMMAND_UNAVAILABLE");
    return current(...args);
  }, []);
  return command ? invoke : undefined;
}

/** Own the actions projection; state updates and render-local closures cannot invalidate it. */
export function useStableSessionPaneActions(value: SessionPaneActions): SessionPaneActions {
  // Hook order is explicit and fixed, including optional capabilities.
  const commands = {
    promoteSessionToPermanent: useLatestPaneCommand(value.promoteSessionToPermanent),
    showToast: useLatestPaneCommand(value.showToast),
    onOpenFile: useLatestPaneCommand(value.onOpenFile),
    onDiffFile: useLatestPaneCommand(value.onDiffFile),
    onPreviewImage: useLatestPaneCommand(value.onPreviewImage),
    abortAgent: useLatestPaneCommand(value.abortAgent),
    restartActiveAgent: useLatestPaneCommand(value.restartActiveAgent),
    runCreateSessionDraft: useLatestPaneCommand(value.runCreateSessionDraft),
    enqueueSessionPrompt: useLatestPaneCommand(value.enqueueSessionPrompt),
    insertQuickPrompt: useLatestPaneCommand(value.insertQuickPrompt),
    ensureSessionId: useLatestPaneCommand(value.ensureSessionId),
    resendUserMessage: useLatestPaneCommand(value.resendUserMessage),
    editMessage: useLatestPaneCommand(value.editMessage),
    deleteMessage: useLatestPaneCommand(value.deleteMessage),
    forkFromUserMessage: useLatestPaneCommand(value.forkFromUserMessage),
    openSidebarSessionById: useLatestPaneCommand(value.openSidebarSessionById),
    queueRetract: useLatestPaneCommand(value.queueRetract),
    queueDiscard: useLatestPaneCommand(value.queueDiscard),
    setTerminalOpenForOwner: useLatestPaneCommand(value.setTerminalOpenForOwner),
    setTerminalCollapsedForOwner: useLatestPaneCommand(value.setTerminalCollapsedForOwner),
    setTerminalHeightByOwner: useLatestPaneCommand(value.setTerminalHeightByOwner),
    changeChatPath: useLatestPaneCommand(value.changeChatPath),
    showNotice: useLatestPaneCommand(value.showNotice),
    exitSessionSplit: useLatestPaneCommand(value.exitSessionSplit),
  };
  return useMemo(() => ({ ...commands, queueFlushBySessionRef: value.queueFlushBySessionRef,
    api: value.api, jumpToMessageRef: value.jumpToMessageRef }), [
    commands.promoteSessionToPermanent, commands.showToast, commands.onOpenFile, commands.onDiffFile,
    commands.onPreviewImage, commands.abortAgent, commands.restartActiveAgent, commands.runCreateSessionDraft,
    commands.enqueueSessionPrompt, commands.insertQuickPrompt, commands.ensureSessionId, commands.resendUserMessage,
    commands.editMessage, commands.deleteMessage, commands.forkFromUserMessage, commands.openSidebarSessionById,
    commands.queueRetract, commands.queueDiscard, commands.setTerminalOpenForOwner, commands.setTerminalCollapsedForOwner,
    commands.setTerminalHeightByOwner, commands.changeChatPath, commands.showNotice, commands.exitSessionSplit,
    value.queueFlushBySessionRef, value.api, value.jumpToMessageRef,
  ]);
}
