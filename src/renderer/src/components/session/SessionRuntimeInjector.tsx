import React from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ChatMessage, TerminalTarget } from "../../../../shared/types";
import { settingsOpenAtom } from "../../atoms";
import {
  claimSessionRuntimeUiResponseAtom,
  rollbackSessionRuntimeUiResponseAtom,
} from "../../atoms/session-atoms";
import {
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms/session-selectors";
import { useSessionRuntimeController } from "../../hooks/useSessionRuntimeController";
import {
  createSessionRuntimeUiResponder,
  SessionRuntimeUiOverlay,
} from "../overlays/SessionRuntimeUiOverlay";
import type { QueuedPrompt } from "../../hooks/useQueuedPrompt";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import { QueuedPromptPanel } from "./ComposerPanels";
import { SessionView } from "./SessionView";
import { useSessionPaneServices } from "./SessionPaneServices";

export type SessionRuntimeInjectorProps = {
  currentSessionId: string;
  sessionTitle: string;
  sessionTimeline: SessionTimelineController;
  /** 分屏栏加聚焦边框；单栏 Tab 已外置，同样只渲染本栏 Header */
  splitPane?: boolean;
  focused?: boolean;
  onFocusPane?: () => void;
  chatHeaderRef: React.RefObject<HTMLDivElement | null>;
  composerRef: React.RefObject<HTMLElement | null>;
  composerOffsetHeight: number;
  terminalRowHeight: number;
  activeQueuedPrompts: QueuedPrompt[];
  queuedTrackRef: React.MutableRefObject<HTMLDivElement | null>;

  // 终端归属（owner 化：agent:<id> / project:<id>），由 App 层解析后传入
  terminalOwnerKey?: string;
  /** agent 或 project 终端目标（App 层按 owner 解析） */
  terminalTarget?: TerminalTarget;
  setTerminalOpenForOwner: (open: boolean) => void;
  setTerminalCollapsedForOwner: (collapsed: boolean) => void;
  setTerminalHeightByOwner: (updater: (cur: Record<string, number>) => Record<string, number>) => void;
};

/**
 * 绑定本栏 runtime 订阅与 UI overlay，再交给 SessionView。
 * 共享服务从 SessionPaneServices 读取，避免 App 大 props 袋。
 */
export const SessionRuntimeInjector = React.memo(function SessionRuntimeInjector(
  props: SessionRuntimeInjectorProps,
) {
  const {
    currentSessionId,
    sessionTitle,
    sessionTimeline,
    splitPane = false,
    focused = true,
    onFocusPane,
    chatHeaderRef,
    composerRef,
    composerOffsetHeight,
    terminalRowHeight,
    activeQueuedPrompts,
    queuedTrackRef,
    terminalOwnerKey,
    terminalTarget,
    setTerminalOpenForOwner,
    setTerminalCollapsedForOwner,
    setTerminalHeightByOwner,
  } = props;

  const services = useSessionPaneServices();
  const settingsOpen = useAtomValue(settingsOpenAtom);
  const currentSessionRuntime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(currentSessionId));
  const currentSessionRuntimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(currentSessionId));
  const claimSessionUiResponse = useSetAtom(claimSessionRuntimeUiResponseAtom);
  const rollbackSessionUiResponse = useSetAtom(rollbackSessionRuntimeUiResponseAtom);
  const runtimeRef = React.useRef(currentSessionRuntime);
  runtimeRef.current = currentSessionRuntime;

  const runtimeUiResponder = React.useMemo(() => {
    if (!currentSessionRuntime?.agentId) return undefined;
    const binding = {
      sessionId: currentSessionId,
      agentId: currentSessionRuntime.agentId,
      runtimeGeneration: currentSessionRuntime.runtimeGeneration,
    };

    return createSessionRuntimeUiResponder({
      binding,
      readBinding: () => {
        const latest = runtimeRef.current;
        return latest?.agentId
          ? {
              sessionId: currentSessionId,
              agentId: latest.agentId,
              runtimeGeneration: latest.runtimeGeneration,
            }
          : undefined;
      },
      claim: claimSessionUiResponse,
      rollback: rollbackSessionUiResponse,
      send: services.api.sessions.sendUiResponse,
      onError: (error) =>
        services.showToast(error instanceof Error ? error.message : String(error), 4000),
    });
  }, [
    claimSessionUiResponse,
    currentSessionId,
    currentSessionRuntime?.agentId,
    currentSessionRuntime?.runtimeGeneration,
    rollbackSessionUiResponse,
    services.api.sessions.sendUiResponse,
    services.showToast,
  ]);

  const runtime = useSessionRuntimeController({
    sessionId: currentSessionId,
    agents: services.agents,
    queueFlushBySessionRef: services.queueFlushBySessionRef,
    activeQueuedPrompts,
    restartingAgentId: services.restartingAgentId,
    sessionDurationByAgent: services.sessionDurationByAgent,
    activeProjectId: services.activeProjectId,
    showNotice: services.showNotice,
  });

  const activeAgent = runtime.activeAgentId
    ? services.agents.find((a) => a.id === runtime.activeAgentId)
    : undefined;
  const canMutateActiveMessages = runtime.canMutateActiveMessages;
  const messageCommandTarget = runtime.runtimeTarget;
  const canDispatchMessageMutation =
    canMutateActiveMessages && messageCommandTarget !== undefined;

  const messageActions = React.useMemo(() => {
    if (!canDispatchMessageMutation || !messageCommandTarget) {
      return {
        onResendUserMessage: undefined,
        onEditMessage: undefined,
        onDeleteMessage: undefined,
        onForkMessage: undefined,
      };
    }
    return {
      onResendUserMessage: services.resendUserMessage
        ? (message: ChatMessage) =>
            services.resendUserMessage?.(messageCommandTarget, message)
        : undefined,
      onEditMessage: services.editMessage
        ? (messageId: string, newText: string) =>
            services.editMessage?.(messageCommandTarget, messageId, newText)
        : undefined,
      onDeleteMessage: services.deleteMessage
        ? (messageId: string) =>
            services.deleteMessage?.(messageCommandTarget, messageId)
        : undefined,
      onForkMessage: services.forkFromUserMessage
        ? (message: ChatMessage) =>
            services.forkFromUserMessage?.(messageCommandTarget, message)
        : undefined,
    };
  }, [
    canDispatchMessageMutation,
    messageCommandTarget?.sessionId,
    messageCommandTarget?.agentId,
    messageCommandTarget?.runtimeGeneration,
    services.resendUserMessage,
    services.editMessage,
    services.deleteMessage,
    services.forkFromUserMessage,
  ]);

  return (
    <SessionView
      sessionId={currentSessionId}
      sessionTitle={sessionTitle}
      sessionTimeline={sessionTimeline}
      splitPane={splitPane}
      focused={focused}
      onFocusPane={onFocusPane}
      activeAgentId={runtime.activeAgentId ?? undefined}
      activeAgent={activeAgent}
      hasActiveConversation={runtime.hasActiveConversation}
      hasProject={runtime.sessionHasProject}
      chatHeaderRef={chatHeaderRef}
      composerRef={composerRef}
      composerOffsetHeight={composerOffsetHeight}
      terminalRowHeight={terminalRowHeight}
     isAgentStarting={runtime.isAgentStarting}
     isRestarting={runtime.isRestartingThisAgent}
     sessionDuration={runtime.sessionDuration}
      activeRuntimeState={runtime.activeRuntimeState}
     showThinking={services.showThinking}
      validCommandNames={services.validCommandNames}
      validFilePaths={services.validFilePaths}
      onPreviewImage={services.onPreviewImage}
      onOpenFile={services.onOpenFile}
      onDiffFile={services.onDiffFile}
      onResendUserMessage={messageActions.onResendUserMessage}
      onEditMessage={messageActions.onEditMessage}
      onDeleteMessage={messageActions.onDeleteMessage}
      onForkMessage={messageActions.onForkMessage}
      forkingMessageId={services.forkingMessageId}
      onToast={(message: string) => services.showToast(message)}
      onQuickPrompt={(message) => services.insertQuickPrompt(currentSessionId, message)}
      canMutateActiveMessages={canMutateActiveMessages}
      onOpenBranchSession={
        services.activeProjectId && services.openSidebarSessionById
          ? (sessionId: string) => {
              void services.openSidebarSessionById?.(services.activeProjectId!, sessionId);
            }
          : undefined
      }
      enqueueSessionPrompt={services.enqueueSessionPrompt}
      gitInfo={services.gitInfo}
      ensureSessionId={services.ensureSessionId}
      openFilePath={services.onOpenFile}
      runtimeUi={
        runtimeUiResponder ? (
          <SessionRuntimeUiOverlay
            sessionId={currentSessionId}
            runtime={currentSessionRuntime}
            ui={currentSessionRuntimeUi}
            responder={runtimeUiResponder}
            onExpandedChange={(expanded) => {
              if (!expanded) return;
              requestAnimationFrame(() => sessionTimeline.scrollToBottom());
            }}
          />
        ) : null
      }
      queuePanel={
        currentSessionId ? (
          <QueuedPromptPanel
            trackRef={queuedTrackRef}
            sessionId={currentSessionId}
            prompts={activeQueuedPrompts}
            visiblePrompts={activeQueuedPrompts}
            onRetract={services.queueRetract}
            onDiscard={services.queueDiscard}
          />
        ) : undefined
      }
      terminalDockVisible={focused && services.terminalDockVisible}
      terminalOpen={focused && services.terminalOpen}
      terminalDockClosing={focused && services.terminalDockClosing}
      terminalCollapsed={services.terminalCollapsed}
      availableTerminalHeight={services.availableTerminalHeight ?? 120}
      terminalOwnerKey={terminalOwnerKey}
      terminalTarget={terminalTarget}
      setTerminalOpenForOwner={setTerminalOpenForOwner}
      setTerminalCollapsedForOwner={setTerminalCollapsedForOwner}
      setTerminalHeightByOwner={setTerminalHeightByOwner}
      settingsOpen={settingsOpen}
      configOpen={services.configOpen}
      environmentDialog={services.environmentDialog}
      runCreateSessionDraft={services.runCreateSessionDraft}
      abortAgent={services.abortAgent}
    />
  );
});
