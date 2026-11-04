import React, { useRef, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Provider, createStore } from "jotai";
import { useVirtualTimeline } from "../../src/renderer/src/hooks/useVirtualTimeline";
import { VirtualTimelineRows } from "../../src/renderer/src/components/session/timeline/VirtualTimelineRows";
import type { TimelineRowItem } from "../../src/renderer/src/components/session/timeline/timelineRowModel";
import { SessionMessageTimeline } from "../../src/renderer/src/components/session/SessionMessageTimeline";
import {
  sessionRecordsAtom,
  sessionRuntimeByIdAtom,
  sessionMessagesCacheAtom,
  sessionSendStateByIdAtom,
} from "../../src/renderer/src/atoms";
import type { ChatMessage, SessionRecord } from "../../src/shared/types";

function generateIntegratedMessages(count = 100): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: `u-${i}`,
      agentId: "agent-1",
      role: "user",
      text: `用户问题 #${i}: 真实集成装配长会话压力测试，验证 SessionMessageTimeline 与 MessageScroller 的协同表现。`,
      timestamp: 1700000000000 + i * 2000,
    });
    msgs.push({
      id: `a-${i}`,
      agentId: "agent-1",
      role: "assistant",
      text: `助手回答 #${i}: 真实时间线装配渲染。每轮回答包含 Markdown 与代码块。\n\n\`\`\`ts\nconst turn_${i} = ${i};\n\`\`\``,
      timestamp: 1700000000000 + i * 2000 + 1000,
    });
  }
  return msgs;
}

// 构建 2000 行包含多种结构的消息 fixture
function generate2000Items(): TimelineRowItem[] {
  const items: TimelineRowItem[] = [];
  for (let i = 0; i < 2000; i++) {
    if (i % 2 === 0) {
      items.push({
        kind: "message",
        message: {
          id: `msg-user-${i}`,
          agentId: "agent-1",
          role: "user",
          text: `用户问题 #${i}: 这是一个虚拟列表滚动的压力测试，用于检验长会话流畅度。`,
          timestamp: 1700000000000 + i * 1000,
        },
      });
    } else {
      items.push({
        kind: "agent-run",
        id: `run-${i}`,
        startedAt: 1700000000000 + i * 1000,
        endedAt: 1700000000000 + i * 1000 + 500,
        items: [
          {
            kind: "message",
            message: {
              id: `msg-asst-${i}`,
              agentId: "agent-1",
              role: "assistant",
              text: `助手回答 #${i}: 回答内容具有不同的行高与结构。第 ${i} 行包含了详细的解释与代码片段。\n\n\`\`\`ts\nconst val_${i} = ${i};\n\`\`\``,
              timestamp: 1700000000000 + i * 1000 + 200,
            },
          },
        ],
      });
    }
  }
  return items;
}

function VirtualTimelineTestFixture() {
  const [useIntegrated, setUseIntegrated] = useState(false);
  const [integratedMessages, setIntegratedMessages] = useState<ChatMessage[]>(() => generateIntegratedMessages(100));
  const [items, setItems] = useState<TimelineRowItem[]>(() => generate2000Items());
  const [isFollowing] = useState(false);
  const integratedTimelineRef = useRef<HTMLElement | null>(null);
  const integratedScrollerScrollApiRef = useRef<any>(null);

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
      handleTimelineScroll: () => {},
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

  const integratedStore = useMemo(() => {
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
    return store;
  }, [integratedMessages]);

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
            <span id="integrated-total-turns">集成总轮数: {integratedMessages.length / 2}</span>
          </>
        )}
      </header>
      {useIntegrated ? (
        <Provider store={integratedStore}>
          <div
            id="integrated-viewport-container"
            style={{
              flex: 1,
              position: "relative",
              height: "calc(100% - 60px)",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <SessionMessageTimeline
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
