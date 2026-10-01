import { useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "jotai";
import { sessionRecordByIdAtomFamily } from "../../atoms";
import { useSessionTimelineController } from "../../hooks/useSessionTimelineController";
import { SessionRuntimeInjector } from "./SessionRuntimeInjector";
import { useSessionPaneServices } from "./SessionPaneServices";
import { t } from "../../i18n";

export type ChatSessionPaneProps = {
  sessionId: string;
  focused: boolean;
  onFocusPane: () => void;
  /** 分屏双栏时为 true（边框高亮）；单栏 Tab 外置时为 false */
  splitPane?: boolean;
};

/**
 * 单个会话聊天栏：自持 timeline + runtime 注入。
 * 共享服务来自 SessionPaneServices；Tab 栏由 App 外置统一挂载。
 */
export function ChatSessionPane(props: ChatSessionPaneProps) {
  const { sessionId, focused, onFocusPane, splitPane = false } = props;
  const services = useSessionPaneServices();

  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const sessionTitle = record?.title?.trim() || t("app.chatProject");

  const sessionTimeline = useSessionTimelineController({ sessionId });

  const localHeaderRef = useRef<HTMLDivElement | null>(null);
  const localComposerRef = useRef<HTMLElement | null>(null);
  const localQueuedTrackRef = useRef<HTMLDivElement | null>(null);

  const layoutRefs = services.layoutRefs;
  const chatHeaderRef = focused ? layoutRefs.chatHeaderRef : localHeaderRef;
  const composerRef = focused ? layoutRefs.composerRef : localComposerRef;

  const activeQueuedPrompts = services.queuedPromptsBySession[sessionId] ?? [];

  useEffect(() => {
    if (!focused) return;
    services.jumpToMessageRef.current = sessionTimeline.jumpToMessage;
    return () => {
      if (services.jumpToMessageRef.current === sessionTimeline.jumpToMessage) {
        services.jumpToMessageRef.current = null;
      }
    };
  }, [focused, services.jumpToMessageRef, sessionTimeline.jumpToMessage]);

  const layout = useMemo(
    () => ({
      chatHeaderRef,
      composerRef,
      composerOffsetHeight: focused ? layoutRefs.composerOffsetHeight : 0,
      terminalRowHeight: layoutRefs.terminalRowHeight,
    }),
    [chatHeaderRef, composerRef, focused, layoutRefs],
  );

  return (
    <SessionRuntimeInjector
      currentSessionId={sessionId}
      sessionTitle={sessionTitle}
      sessionTimeline={sessionTimeline}
      splitPane={splitPane}
      focused={focused}
      onFocusPane={onFocusPane}
      chatHeaderRef={layout.chatHeaderRef}
      composerRef={layout.composerRef}
      composerOffsetHeight={layout.composerOffsetHeight}
      terminalRowHeight={layout.terminalRowHeight}
      activeQueuedPrompts={activeQueuedPrompts}
      queuedTrackRef={localQueuedTrackRef}
      terminalOwnerKey={services.terminalOwnerKey}
      terminalTarget={services.terminalTarget}
      setTerminalOpenForOwner={services.setTerminalOpenForOwner}
      setTerminalCollapsedForOwner={services.setTerminalCollapsedForOwner}
      setTerminalHeightByOwner={services.setTerminalHeightByOwner}
    />
  );
}
