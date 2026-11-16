import React, { useRef, useState, useMemo, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { useVirtualTimeline } from "../../src/renderer/src/hooks/useVirtualTimeline";
import { VirtualTimelineRows } from "../../src/renderer/src/components/session/timeline/VirtualTimelineRows";
import type { TimelineRowItem } from "../../src/renderer/src/components/session/timeline/timelineRowModel";
import type { TimelineViewportAdapter } from "../../src/renderer/src/components/session/timeline/TimelineViewportAdapter";
import { SessionMessageTimeline } from "../../src/renderer/src/components/session/SessionMessageTimeline";
import {
  sessionRecordsAtom,
  sessionRuntimeByIdAtom,
  sessionMessagesCacheAtom,
  sessionSendStateByIdAtom,
} from "../../src/renderer/src/atoms";
import { getUserBubblePresentationAtom } from "../../src/renderer/src/atoms/timeline-presentation";
import { generate2000Items, generateIntegratedMessages } from "./desktopVirtualTimeline.data";
import type { ChatMessage, SessionRecord } from "../../src/shared/types";

function VirtualTimelineTestFixture() {
  const [useIntegrated, setUseIntegrated] = useState(false);
  const longRows = new URLSearchParams(location.search).has("longRows");
  const identityTakeover = new URLSearchParams(location.search).has("identityTakeover");
  const [timelineMount, setTimelineMount] = useState(0);
  const [narrow, setNarrow] = useState(false);
  // Stable long rows exercise remounting without any incoming model output.
  const [integratedMessages, setIntegratedMessages] = useState<ChatMessage[]>(() =>
    generateIntegratedMessages(100, new URLSearchParams(location.search).has("longCode") ? 40 : 1, longRows)
      .map((message) => identityTakeover && message.id === "u-70"
        ? { ...message, id: "request-user-70", meta: { optimistic: true, optimisticRequestId: "request-user-70" } }
        : message));
  const [items, setItems] = useState<TimelineRowItem[]>(() => generate2000Items());
  const [isFollowing] = useState(false);
  const integratedTimelineRef = useRef<HTMLElement | null>(null);
  const integratedScrollerScrollApiRef = useRef<any>(null);
  const integratedAdapterRef = useRef<TimelineViewportAdapter | null>(null);
  const snapshotFrameRef = useRef<number | null>(null);
  const snapshotCountRef = useRef(0);
  useEffect(() => () => {
    if (snapshotFrameRef.current !== null) cancelAnimationFrame(snapshotFrameRef.current);
  }, []);

  const integratedController = useMemo<any>(() => {
    return {
      timelineRef: integratedTimelineRef,
      messages: integratedMessages,
      visibleMessages: integratedMessages,
      totalMessageCount: integratedMessages.length,
      hasMoreMessages: false,
      nextLoadIsHistory: false,
      isLoadingMoreMessages: false,
      loadMoreMessages: () => {},
      autoScroll: false,
      showScrollToBottom: false,
      setAutoScrollFromScroller: () => {},
      // Exercise the production controller's deferred snapshot timing as well
      // as the virtualizer's native scroll listener, instead of a no-op stub.
      handleTimelineScroll: () => {
        if (snapshotFrameRef.current !== null) return;
        snapshotFrameRef.current = requestAnimationFrame(() => {
          snapshotFrameRef.current = null;
          integratedAdapterRef.current?.captureReadingAnchor();
          snapshotCountRef.current += 1;
          integratedTimelineRef.current?.setAttribute("data-passive-anchor-reads", String(snapshotCountRef.current));
        });
      },
      registerViewportAdapter: (adapter: TimelineViewportAdapter) => {
        integratedAdapterRef.current = adapter;
        return () => {
          if (integratedAdapterRef.current === adapter) integratedAdapterRef.current = null;
        };
      },
      scrollerScrollApiRef: integratedScrollerScrollApiRef,
      scrolledWindowTurns: 0,
      scrolledWindowItems: 0,
      expandWindow: () => {},
      hasPendingLoadMoreAnchor: () => false,
      refreshLoadMoreAnchorBaseline: () => {},
      markProgrammaticScroll: () => {},
      peekViewportAnchor: () => ({ status: "unresolved" }),
      jumpToMessage: () => {},
      scrollToBottom: () => {},
      captureHistoryMutationRefresh: () => null,
      refreshHistoryAfterMutation: async () => {},
    };
  }, [integratedMessages]);
  const [pinnedKeys, setPinnedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // One store survives timeline remounts and all message updates.
  const [integratedStore] = useState(() => {
    const store = createStore();
    const sessionId = "fixture-integrated-100";
    store.set(sessionRecordsAtom, {
      [sessionId]: {
        id: sessionId,
        title: "Integrated Test Session",
        projectId: "proj-1",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        status: "active",
        source: "pi",
        environment: "native",
        messageCount: integratedMessages.length,
      } as SessionRecord,
    });

    store.set(sessionRuntimeByIdAtom, {
      [sessionId]: {
        sessionId,
        agentId: "agent-1",
        state: "idle",
        hasActiveConversation: false,
        sessionHasProject: true,
        activeAgentId: "agent-1",
      } as unknown as any,
    });

    store.set(sessionSendStateByIdAtom, {
      [sessionId]: {
        status: "idle",
      },
    });

    store.set(sessionMessagesCacheAtom, {
      [sessionId]: {
        messages: integratedMessages,
        revision: 1,
        source: "disk",
        updatedAt: Date.now(),
      },
    });
    if (longRows) {
      for (const message of integratedMessages) {
        if (message.role !== "user" || message.id === "request-user-70") continue;
        store.set(getUserBubblePresentationAtom(sessionId, `message:${message.id}`), { messageExpanded: true, visionDetailOpen: false });
      }
    }
    return store;
  });
  useEffect(() => {
    const sessionId = "fixture-integrated-100";
    integratedStore.set(sessionMessagesCacheAtom, (cache) => ({
      ...cache,
      [sessionId]: { ...cache[sessionId], messages: integratedMessages, revision: (cache[sessionId]?.revision ?? 0) + 1, source: "disk", updatedAt: Date.now() },
    }));
  }, [integratedMessages, integratedStore]);

  const virtualTimeline = useVirtualTimeline({
    items,
    viewportRef,
    listRef,
    isFollowing,
    applyReaderScrollTop: (top) => {
      if (viewportRef.current) {
        viewportRef.current.scrollTop = top;
      }
    },
    sessionId: "fixture-session-2000",
    pinnedKeys,
  });

  const rowCount = virtualTimeline.renderPlan.filter((p) => p.kind === "row").length;
  const totalHeight = virtualTimeline.geometry.totalHeight;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      <header
        style={{
          padding: "8px 16px",
          background: "#27272a",
          borderBottom: "1px solid #3f3f46",
          display: "flex",
          gap: "12px",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button
          id="btn-toggle-integrated"
          onClick={() => setUseIntegrated((prev) => !prev)}
        >
          {useIntegrated ? "切换为底层虚拟列表" : "切换为真实 SessionMessageTimeline 装配"}
        </button>
        {!useIntegrated ? (
          <>
            <button
              id="btn-scroll-middle"
              onClick={() => {
                if (viewportRef.current) {
                  viewportRef.current.scrollTop = 25000;
                }
              }}
            >
              滚动到中间 (25000px)
            </button>
            <button
              id="btn-pin-item-10"
              onClick={() => {
                setPinnedKeys(new Set(["message:msg-user-10"]));
              }}
            >
              Pin Row msg-user-10
            </button>
            <button
              id="btn-append-stream"
              onClick={() => {
                const nextIdx = items.length;
                setItems((prev) => [
                  ...prev,
                  {
                    kind: "message",
                    message: {
                      id: `stream-msg-${nextIdx}`,
                      agentId: "agent-1",
                      role: "user",
                      text: `新增流式尾部消息 #${nextIdx}`,
                      timestamp: Date.now(),
                    },
                  },
                ]);
              }}
            >
              新增尾部流式消息
            </button>
            <span id="rendered-count">渲染条数: {rowCount}</span>
            <span id="total-rows">总行数: {items.length}</span>
            <span id="total-height">测量高度: {totalHeight}</span>
          </>
        ) : (
          <>
            <button
              id="btn-integrated-append"
              onClick={() => {
                const nextTurn = integratedMessages.length / 2;
                setIntegratedMessages((prev) => [
                  ...prev,
                  {
                    id: `u-dyn-${nextTurn}`,
                    agentId: "agent-1",
                    role: "user",
                    text: `动态追加新问题 #${nextTurn}`,
                    timestamp: Date.now(),
                  },
                  {
                    id: `a-dyn-${nextTurn}`,
                    agentId: "agent-1",
                    role: "assistant",
                    text: `动态追加新回答 #${nextTurn}`,
                    timestamp: Date.now() + 500,
                  },
                ]);
              }}
            >
              追加真实新轮次
            </button>
            <button id="btn-integrated-reader" onClick={() => {
              const target = identityTakeover
                ? integratedMessages.some((message) => message.id === "accepted-user-70") ? "accepted-user-70" : "request-user-70"
                : "a-70";
              integratedAdapterRef.current?.jumpToMessage(target);
            }}>
              定位长历史消息
            </button>
            <button id="btn-integrated-user-reader" onClick={() => integratedAdapterRef.current?.jumpToMessage("u-70")}>
              定位长用户消息
            </button>
            <button id="btn-integrated-narrow" onClick={() => setNarrow((value) => !value)}>
              切换阅读宽度
            </button>
            <button id="btn-integrated-remount" onClick={() => setTimelineMount((value) => value + 1)}>
              重挂同一会话
            </button>
            {identityTakeover && <>
              <button id="btn-integrated-accept" onClick={() => setIntegratedMessages((messages) => messages.map((message) => message.id === "request-user-70"
                ? { ...message, id: "accepted-user-70", meta: { optimisticRequestId: "request-user-70" } } : message))}>
                接管正式消息 ID
              </button>
              <button id="btn-integrated-drop-request" onClick={() => setIntegratedMessages((messages) => messages.map((message) => message.id === "accepted-user-70"
                ? { ...message, meta: undefined } : message))}>
                更新正式消息
              </button>
            </>}
            <span id="integrated-total-turns">集成总轮数: {integratedMessages.length / 2}</span>
          </>
        )}
      </header>
      {useIntegrated ? (
        <Provider store={integratedStore}>
          <div
            id="integrated-viewport-container"
            data-timeline-mount={timelineMount}
            style={{
              flex: 1,
              position: "relative",
              height: "calc(100% - 60px)",
              width: narrow ? "68%" : "100%",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <SessionMessageTimeline
              key={timelineMount}
              sessionId="fixture-integrated-100"
              controller={integratedController}
              hasProject={true}
              onCreateSession={() => {}}
              showThinking={true}
              validCommandNames={new Set()}
              validFilePaths={new Set()}
              onPreviewImage={() => {}}
              onOpenExternal={() => {}}
              onToast={() => {}}
            />
          </div>
        </Provider>
      ) : (
        <div
          id="scroll-viewport"
          ref={viewportRef}
          style={{
            flex: 1,
            overflowY: "auto",
            position: "relative",
            width: "100%",
          }}
        >
          <VirtualTimelineRows
            renderPlan={virtualTimeline.renderPlan}
            registerRowNode={virtualTimeline.registerRowNode}
            renderRow={(row) => (
              <div
                className="timeline-item"
                data-message-id={row.anchorId}
                style={{
                  padding: "16px",
                  borderBottom: "1px solid #3f3f46",
                  background: row.item.kind === "message" ? "#1e1e24" : "#24242e",
                }}
              >
                <strong>{row.key}</strong>:{" "}
                {row.item.kind === "message"
                  ? row.item.message.text
                  : row.item.items[0]?.kind === "message"
                    ? row.item.items[0].message.text
                    : "agent run"}
              </div>
            )}
          />
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<VirtualTimelineTestFixture />);
}
