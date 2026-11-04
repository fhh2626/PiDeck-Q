import { useAtomValue, useSetAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import type { ChatMessage, ImageContent } from "../../../../shared/types";
import {
  CompactionCard,
  DiagnosticMessageCard,
  EmptyState,
  MultiSelectModal,
  RespondingIndicator,
  TurnRow,
  UserBubble,
  stripMarkdown,
} from "./SurfaceParts";
import {
  getMultiSelectImageCaptureIds,
  groupToolMessages,
  reconcileRuns,
  type RenderMessage,
} from "../app/AppUtils";
import {
  liveThinkingIdBySessionIdAtomFamily,
  removeSessionSlidingOutMessagesAtom,
  sessionMessageCacheBySessionIdAtomFamily,
  sessionMessageLoadStateAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionSendStateAtomFamily,
} from "../../atoms";
import {
  canLoadSessionTimelineMore,
  deriveSessionSurfaceRuntime,
  isLatestTimelineRunBusy,
  useSessionTimelineController,
  type SessionTimelineController,
} from "../../hooks/useSessionTimelineController";
import { t, translateI18nDescriptor } from "../../i18n";
import { cn } from "../../lib/utils";
import { Loader2 } from "lucide-react";
import { showNotice } from "../../utils/notice";
import { loadHtmlToImage } from "../../utils/htmlToImage";
import { stripAnsi } from "./TimelineFormat";
import { SessionStartSurface } from "./SessionStartSurface";
import { MessageScroller } from "../agents/message-scroller";
import { resolveFreshTailIds } from "../../lib/pinTurnScroll";
import { chatContentWidthStyle } from "./chatContentWidth";
import { useVirtualTimeline } from "../../hooks/useVirtualTimeline";
import { useTimelineInteractionPins } from "../../hooks/useTimelineInteractionPins";
import type { TimelineViewportAdapter } from "./timeline/TimelineViewportAdapter";
import { TimelineMessageRow } from "./timeline/TimelineMessageRow";
import { VirtualTimelineRows } from "./timeline/VirtualTimelineRows";
import { exportSelectedMessagesToImage } from "./timeline/TimelineImageExport";

type TurnRowProps = ComponentProps<typeof TurnRow>;
type UserBubbleProps = ComponentProps<typeof UserBubble>;

// ── 失败/重试提示：时间线不再渲染卡片，改为 toast ──
// 主进程以 role=error / role=system 消息携带这些 i18nKey（见 AgentManager 的
// addLocalizedMessage / upsertRetryStatusMessage）。它们在时间线里的诊断卡片
// 视觉过重且打断阅读流，改为首次出现时弹 toast；pi 启动失败
// （diagnostic.agentStartFailed）与携带完整排查诊断的 runtimeError 保留卡片。
const FLOATING_FAILURE_KEYS = new Set([
	"diagnostic.requestFailed",
	"diagnostic.requestFailedAfterRetries",
	"diagnostic.requestFailedUnknown",
	"diagnostic.requestFailedUnknownAfterRetries",
	"diagnostic.agentStopped",
	"diagnostic.promptRejected",
	"diagnostic.promptDeliveryUnknown",
	"diagnostic.commandFailed",
	"diagnostic.commandDeliveryUnknown",
	"diagnostic.commandCancelled",
	"diagnostic.processReconnectFailed",
	"diagnostic.historyLoadFailed",
	"diagnostic.extensionError",
	"diagnostic.retryScheduled",
	"diagnostic.retryScheduledAfterDelay",
	"diagnostic.retrySucceeded",
	"diagnostic.retryFailed",
]);

// 已弹过 toast 的消息 id：模块级去重，分屏多栏同一条消息只弹一次，
// 也避免消息重发（re-emit）或重新渲染时重复打扰。
// 上限裁剪：失败类消息 id 全局唯一且无删除路径，长期运行会无界增长（2026-10）。
const toastedFailureIds = new Set<string>();
const TOASTED_FAILURE_IDS_LIMIT = 500;
function markFailureToastShown(messageId: string) {
	toastedFailureIds.add(messageId);
	if (toastedFailureIds.size <= TOASTED_FAILURE_IDS_LIMIT) return;
	// 超限：清空重建（Set 无 FIFO；失败 toast 是低频事件，偶发重复提醒可接受）
	toastedFailureIds.clear();
	toastedFailureIds.add(messageId);
}

/** 判断消息是否为「失败/重试类」提示（时间线不渲染、改 toast）。 */
export function isFloatingFailureMessage(message: ChatMessage): boolean {
	const key = (message.meta as Record<string, unknown> | undefined)?.i18nKey;
	return typeof key === "string" && FLOATING_FAILURE_KEYS.has(key);
}

/** 弹失败/重试 toast：重试类用中性标题，失败类用错误变体。 */
function showFailureToast(message: ChatMessage): void {
	const meta = message.meta as Record<string, unknown> | undefined;
	const key = typeof meta?.i18nKey === "string" ? meta.i18nKey : "";
	const isRetry = key.startsWith("diagnostic.retry");
	// translateI18nDescriptor 优先取 meta.i18nKey 的本地化文案，
	// 取不到时回退消息原文（主进程写的中文/占位文本）。
	const text = translateI18nDescriptor(meta, message.text) || message.text;
	showNotice(
		stripAnsi(text),
		isRetry ? 4000 : 6000,
		isRetry ? "info" : "error",
		t(isRetry ? "diagnostic.retryToastTitle" : "diagnostic.failureToastTitle"),
	);
}

function isItemSlidingOut(item: RenderMessage): boolean {
  if (item.kind === "agent-run") {
    return item.items.some((sub) => {
      if (sub.kind === "message") return sub.message.meta?.slidingOut === true;
      if (sub.kind === "thinking-group") return sub.messages.some((m) => m.meta?.slidingOut === true);
      if (sub.kind === "tool-group") return sub.messages.some((m) => m.meta?.slidingOut === true);
      return false;
    });
  }
  if (item.kind === "message") {
    return item.message.meta?.slidingOut === true;
  }
  return false;
}

function findPinnedRowElement(viewport: HTMLElement | null, rowKey: string | undefined): HTMLElement | null {
  if (!viewport || !rowKey || typeof CSS === "undefined" || typeof CSS.escape !== "function") return null;
  const node = viewport.querySelector(`[data-timeline-row-key="${CSS.escape(rowKey)}"]`);
  return node instanceof HTMLElement ? node : null;
}

type TimelineInteractionProps = {
  hasProject: boolean;
  onCreateSession: () => void;
  showThinking: boolean;
  validCommandNames: Set<string>;
  validFilePaths: Set<string>;
  onPreviewImage: (image: ImageContent, images?: ImageContent[]) => void;
  onOpenExternal: (url: string, forceSystem?: boolean) => void;
  onOpenFile?: (path: string) => void;
  onDiffFile?: TurnRowProps["onDiffFile"];
  onResendUserMessage?: UserBubbleProps["onResendUserMessage"];
  onEditMessage?: TurnRowProps["onEditMessage"];
  onDeleteMessage?: TurnRowProps["onDeleteMessage"];
  onForkMessage?: UserBubbleProps["onForkMessage"];
  forkingMessageId?: string | null;
  onToast: (message: string) => void;
  /** 新建 Agent 的空时间线快捷操作：只写入 composer，不自动投递。 */
  onQuickPrompt?: (prompt: string) => void;
  /** 当前会话的阻塞式交互（如 ask_question），由时间线统一承载滚动与底部定位。 */
  runtimeUi?: ReactNode;
};

export type SessionMessageTimelineProps = TimelineInteractionProps & {
  sessionId: string;
  controller?: SessionTimelineController;
  timelineRef?: RefObject<HTMLElement | null>;
};

export function SessionMessageTimeline(props: SessionMessageTimelineProps) {
  const sessionId = props.sessionId;
  const session = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const messageLoadStateSelector = useMemo(
    () => selectAtom(
      sessionMessageLoadStateAtom,
      (states) => states[sessionId],
      Object.is,
    ),
    [sessionId],
  );
  // 与 SessionHeader / ContextControllerSwitches / ComposerArea 共用同一个按会话选择器。
  const sendState = useAtomValue(sessionSendStateAtomFamily(sessionId));
  const messageLoadState = useAtomValue(messageLoadStateSelector);
  const internalController = useSessionTimelineController({
    // An injected controller already owns loading and scroll effects; omit the
    // session identity so this inert hook cannot start a second disk load.
    sessionId: props.controller ? undefined : sessionId,
  });
  const controller = props.controller ?? internalController;
  const timelineRef = props.timelineRef ?? controller.timelineRef;
  const activeMessages = controller.messages;
  const paginatedMessages = controller.visibleMessages;
	const totalMessageCount = controller.totalMessageCount;
  const hasMoreMessages = controller.hasMoreMessages;
  const isLoadingMoreMessages = controller.isLoadingMoreMessages;
  const hasActiveConversation = Boolean(session);
  // disk 读取无论空/非空都会创建缓存条目：「条目是否存在」用于区分
  // 读取未到达（无条目→钉骨架屏）与读取已返回（有条目→起始页合法）。
  const surfaceCachedEntry = useAtomValue(
    sessionMessageCacheBySessionIdAtomFamily(sessionId ?? ""),
  );
  const modernSurfaceState = deriveSessionSurfaceRuntime(
    activeMessages.length,
    messageLoadState?.status,
    sendState?.status,
    runtime?.status,
    runtime?.state,
    // 缓存条目存在性（disk 读取无论空/非空都会创建条目）：ready 且无条目 =
    // 读取结果未到达 → 钉骨架屏；有条目（即使空）＝读取已返回，空会话起始页合法。
    // 不依赖 catalog messageCount（摘要缺失时兑底为 0，不可靠）。
    Boolean(surfaceCachedEntry),
  );
  const listRef = useRef<HTMLDivElement | null>(null);

  // 接入交互 Pin（输入焦点 / 文本选区 / 编辑）
  const { pinnedKeys, pinAnimationByMessageId } = useTimelineInteractionPins({
    viewportRef: timelineRef,
    sessionId,
  });

  const isConversationLoading = modernSurfaceState.isLoading;
  // 空态时起始页走原来的杂志式快捷入口，不再在时间线里挂第二套输入框。
  const showSurfaceEmptyState =
    !hasActiveConversation ||
    (!isConversationLoading && activeMessages.length === 0);
  const canLoadMoreMessages = canLoadSessionTimelineMore(
    modernSurfaceState.isStarting,
    activeMessages.length,
  );
  const activeRuntimeState = runtime?.state;
  const activeConversationStatus = modernSurfaceState.status;
  // 只订 live id：思考正文由 ThinkingStep 叶子订阅，避免 50ms 戳醒整条 timeline。
  const liveThinkingId = useAtomValue(liveThinkingIdBySessionIdAtomFamily(sessionId ?? ""));
  const isAgentBusy = modernSurfaceState.isBusy;
  const cancellingUi = false;
  const loadMoreMessages = controller.loadMoreMessages;

  // ── 被压缩旧消息 slide-out 退出动画与生命周期清理 ──
  const removeSlidingOut = useSetAtom(removeSessionSlidingOutMessagesAtom);
  const slidingTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const slidingIds: string[] = [];
    for (const msg of activeMessages) {
      if (msg.meta?.slidingOut === true) {
        slidingIds.push(msg.id);
      }
    }
    if (slidingIds.length === 0) return;

    for (const id of slidingIds) {
      if (!slidingTimersRef.current.has(id)) {
        const timer = window.setTimeout(() => {
          slidingTimersRef.current.delete(id);
          removeSlidingOut({ sessionId, messageIds: [id] });
        }, 280);
        slidingTimersRef.current.set(id, timer);
      }
    }
  }, [activeMessages, removeSlidingOut, sessionId]);

  useEffect(() => () => {
    for (const [, timer] of slidingTimersRef.current.entries()) {
      window.clearTimeout(timer);
    }
    slidingTimersRef.current.clear();
  }, [sessionId]);
  // ── 滚动接近顶部自动加载历史（2026-11 轮次模型）──
  // 监听器已迁移到 useSessionTimelineController（程序化滚动抑制在同一 owner）：
  // 用户上滚到距顶部 240px 内即按轮补历史，prepend 补偿不会连锁触发下一页。
  // 新增消息入场动画跟踪 ──
  // 只对「时间线尾部新增」的消息播放一次入场动画：历史加载/分页前插不算，
  // 避免整屏消息同时闪烁。乐观上屏的用户消息与流式替换后的权威消息都会触发。
  const [multiSelectOpen, setMultiSelectOpen] = useState(false);
  // Shared by all memoized rows; a fresh arrow here defeats their shallow prop comparison.
  const enterMultiSelect = useCallback(() => setMultiSelectOpen(true), []);
  const [freshMessageIds, setFreshMessageIds] = useState<ReadonlySet<string>>(() => new Set());
  const seenTailMessageIdRef = useRef<string | undefined>(undefined);
  const freshTimersRef = useRef<Map<string, number>>(new Map());
  // 会话内容就绪淡入：isConversationLoading true→false（切会话历史加载完成）时，
  // 给 MessageScroller 挂一次 160ms 淡入动画类，与骨架屏消失衔接，避免整块瞬间出现。
  // 触发必须用 useLayoutEffect（paint 前同步）：若用 useEffect，内容会先以正常透明度
  // 绘制一帧，再被动画类重置到 opacity:0 重新淡入——视觉上就是「闪一下再淡入」。
  const [contentEntering, setContentEntering] = useState(false);
  const prevConversationLoadingRef = useRef(isConversationLoading);
  useLayoutEffect(() => {
    if (prevConversationLoadingRef.current && !isConversationLoading) {
      setContentEntering(true);
    }
    prevConversationLoadingRef.current = isConversationLoading;
  }, [isConversationLoading]);
  // 动画播完清理类（非视觉关键路径，放 useEffect 避免 layout 阶段多一次重渲染）
  useEffect(() => {
    if (!contentEntering) return;
    const timer = window.setTimeout(() => setContentEntering(false), 180);
    return () => window.clearTimeout(timer);
  }, [contentEntering]);

  useEffect(() => {
    // 会话切换时重置：新会话的首帧（历史加载）不播动画
    seenTailMessageIdRef.current = undefined;
    setFreshMessageIds(new Set());
    for (const timer of freshTimersRef.current.values()) window.clearTimeout(timer);
    freshTimersRef.current.clear();
  }, [sessionId]);

  // ── 失败/重试 toast：只对「加载完成后新增」的消息弹，历史回放不打扰 ──
  // 加载中（loading=true）直接返回；加载完成瞬间把已存在的失败消息静默记为基线；
  // 之后新增的失败/重试消息才弹 toast（模块级 Set 跨栏/跨渲染去重）。
  const failureBaselineRef = useRef<string[] | null>(null);
  useEffect(() => {
    if (isConversationLoading) {
      failureBaselineRef.current = null;
      return;
    }
    const floating = activeMessages.filter(isFloatingFailureMessage);
    if (failureBaselineRef.current === null) {
      // 加载完成基线：本次会话已有的失败消息不弹（历史回放/attach 重连）
      failureBaselineRef.current = floating.map((message) => message.id);
      return;
    }
    for (const message of floating) {
      if (failureBaselineRef.current.includes(message.id)) continue;
      if (toastedFailureIds.has(message.id)) continue;
      markFailureToastShown(message.id);
      showFailureToast(message);
    }
  }, [activeMessages, isConversationLoading]);

  useEffect(() => {
    const previousTail = seenTailMessageIdRef.current;
    const lastMessage = activeMessages[activeMessages.length - 1];
    const nextTail = lastMessage?.id;
    seenTailMessageIdRef.current = nextTail;
    if (!nextTail) return;
    const fresh = resolveFreshTailIds(
      activeMessages,
      previousTail,
      nextTail,
      sendState?.requestId,
    );
    if (fresh.length === 0) return;
    setFreshMessageIds((current) => {
      const next = new Set(current);
      for (const id of fresh) next.add(id);
      return next;
    });
    for (const id of fresh) {
      const timer = window.setTimeout(() => {
        freshTimersRef.current.delete(id);
        setFreshMessageIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }, 1200);
      freshTimersRef.current.set(id, timer);
    }
  }, [
    activeMessages,
    controller.autoScroll,
    sendState?.requestId,
  ]);

  useEffect(() => () => {
    for (const [, timer] of freshTimersRef.current.entries()) {
      window.clearTimeout(timer);
    }
    freshTimersRef.current.clear();
  }, []);

  const renderedRuns = useMemo(
    () => groupToolMessages(paginatedMessages),
    [paginatedMessages],
  );
  // 阶段0补强：对未变化的 run 复用旧对象引用，历史 run 的 memo 比较退化为 O(1)
  const prevRenderedRunsRef = useRef<RenderMessage[] | undefined>(undefined);
  const reconciledRuns = useMemo(() => {
    const next = reconcileRuns(prevRenderedRunsRef.current, renderedRuns);
    prevRenderedRunsRef.current = next;
    return next;
  }, [renderedRuns]);
  const adapterRef = useRef<TimelineViewportAdapter | null>(null);

  // 稳定阅读位置纠偏回调（只调用当前 engine 的 restoreAt，未挂上时不写原生 DOM）
  const applyReaderScrollTop = useCallback((top: number) => {
    const api = controller.scrollerScrollApiRef.current;
    if (api?.restoreAt) {
      api.restoreAt(top);
    }
  }, [controller.scrollerScrollApiRef]);

  // 接入虚拟列表
  const virtualTimeline = useVirtualTimeline({
    items: reconciledRuns,
    viewportRef: timelineRef,
    listRef,
    isFollowing: controller.autoScroll,
    applyReaderScrollTop,
    sessionId,
    adapterRef,
    pinnedKeys,
  });

  // 把已实例化的 adapter 在 layout 阶段稳定注册给 controller
  const registerAdapter = controller.registerViewportAdapter;
  useLayoutEffect(() => {
    if (adapterRef.current && registerAdapter) {
      return registerAdapter(adapterRef.current);
    }
  }, [registerAdapter, sessionId]);

  // 统一动效 Pin 注册（将 slide-out 与 fresh 新增消息顶层行 pin 住，防止虚拟滚动卸载中断动画）
  const animationPinCleanupRef = useRef<Map<string, () => void>>(new Map());
  useEffect(() => {
    const activeTokens = new Set<string>();

    for (const msg of activeMessages) {
      if (msg.meta?.slidingOut === true) {
        const token = `slide:${msg.id}`;
        activeTokens.add(token);
        if (!animationPinCleanupRef.current.has(token)) {
          const rowKey = virtualTimeline.rowModel.rowKeyByMessageId.get(msg.id);
          const el = findPinnedRowElement(timelineRef.current, rowKey);
          const cleanup = pinAnimationByMessageId(
            msg.id,
            virtualTimeline.rowModel.rowKeyByMessageId,
            el,
          );
          animationPinCleanupRef.current.set(token, cleanup);
        }
      }
    }

    for (const id of freshMessageIds) {
      const token = `fresh:${id}`;
      activeTokens.add(token);
      if (!animationPinCleanupRef.current.has(token)) {
        const rowKey = virtualTimeline.rowModel.rowKeyByMessageId.get(id);
        const el = findPinnedRowElement(timelineRef.current, rowKey);
        const cleanup = pinAnimationByMessageId(
          id,
          virtualTimeline.rowModel.rowKeyByMessageId,
          el,
        );
        animationPinCleanupRef.current.set(token, cleanup);
      }
    }

    // 清理不再活跃的 token
    for (const [token, cleanup] of animationPinCleanupRef.current.entries()) {
      if (!activeTokens.has(token)) {
        cleanup();
        animationPinCleanupRef.current.delete(token);
      }
    }
  }, [
    activeMessages,
    freshMessageIds,
    virtualTimeline.rowModel,
    pinAnimationByMessageId,
    timelineRef,
  ]);

  useEffect(() => () => {
    for (const cleanup of animationPinCleanupRef.current.values()) {
      cleanup();
    }
    animationPinCleanupRef.current.clear();
  }, []);
  // 文件修改展示已下沉到每轮 TurnRow 底部（TurnFileChanges），此处不再做全局汇总
  const lastUserMessageId = useMemo(() => {
    for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
      if (activeMessages[index].role === "user") {
        return activeMessages[index].id;
      }
    }
    return undefined;
  }, [activeMessages]);

  // Only show resend when last user message is followed by error/abort (not normal assistant)
  const resendableMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const msg = activeMessages[i];
      if (msg.role !== "user") continue;
      let hasAbortOrError = false;
      for (let j = i + 1; j < activeMessages.length; j++) {
        const next = activeMessages[j];
        if (next.role === "user") break;
        if (next.role === "error") { hasAbortOrError = true; break; }
        if (next.role === "system") {
          const meta = next.meta as Record<string, unknown> | undefined;
          if (meta?.i18nKey === "app.abortRequested") { hasAbortOrError = true; break; }
        }
        if (next.role === "assistant" && next.text?.trim()) {
          // Only block if assistant completed normally (done marker); partial output may precede error
          const am = next.meta as Record<string, unknown> | undefined;
          if (am?.done === true || am?.stopReason) break;
          continue;
        }
      }
      if (hasAbortOrError) ids.add(msg.id);
      break;
    }
    return ids;
  }, [activeMessages]);

  const isAwaitingAssistant = Boolean(
    hasActiveConversation &&
      !cancellingUi &&
      isAgentBusy &&
      activeMessages.at(-1)?.role !== "assistant",
  );

  async function copySelectedMessages(
    selectedIds: Set<string>,
    kind: "text" | "markdown" | "image",
  ) {
    if (kind === "image") {
      try {
        const source = timelineRef.current?.querySelector(
          ".message-list",
        ) as HTMLElement | null;
        const width = source ? Math.max(source.clientWidth, source.scrollWidth) : 600;

        const blob = await exportSelectedMessagesToImage({
          reconciledRuns,
          selectedIds,
          width,
          sessionId,
          onPreviewImage: props.onPreviewImage,
          onOpenExternal: props.onOpenExternal,
          onOpenFile: props.onOpenFile,
          showThinking: props.showThinking,
        });

        if (blob) {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob }),
          ]);
          props.onToast(t("copy.asImageCopied"));
        }
      } catch {
        props.onToast(t("copy.failed"));
      }
      setMultiSelectOpen(false);
      return;
    }

    const selected = activeMessages
      .filter((message) => selectedIds.has(message.id))
      .sort((left, right) => left.timestamp - right.timestamp);
    if (!selected.length) return;

    const separator = "\n\n---\n\n";
    const content = kind === "text"
      ? selected
          .map((message) => {
            let text = message.text;
            text = text.replace(
              /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
              "",
            );
            text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
            text = text.replace(
              /<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/gi,
              "",
            );
            return stripMarkdown(text);
          })
          .join(separator)
      : selected.map((message) => message.text).join(separator);

    await navigator.clipboard.writeText(content);
    props.onToast(
      kind === "text" ? t("copy.asTextCopied") : t("copy.asMarkdownCopied"),
    );
    setMultiSelectOpen(false);
  }

  return (
    <MessageScroller
      className={cn(
        "message-timeline-host h-full min-h-0",
        contentEntering && "timeline-content-enter",
      )}
      viewportClassName="message-timeline"
      contentProps={showSurfaceEmptyState ? undefined : { style: chatContentWidthStyle }}
      viewportRef={timelineRef}
      scrollApiRef={controller.scrollerScrollApiRef}
      initialFollowOutput={controller.autoScroll}
      followThreshold={56}
      smooth
      busy={isAgentBusy || isAwaitingAssistant}
      onFollowChange={controller.setAutoScrollFromScroller}
      viewportProps={{
        onScroll: controller.handleTimelineScroll,
      }}
    >
      {hasMoreMessages && canLoadMoreMessages && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "12px 0",
            borderBottom: "1px solid var(--border-color)",
          }}
        >
          <button
            onClick={() => {
              if (hasMoreMessages && canLoadMoreMessages) {
                loadMoreMessages();
              }
            }}
            disabled={isLoadingMoreMessages}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 16px",
              border: "1px solid var(--border-color)",
              borderRadius: "6px",
              background: "var(--bg-secondary)",
              color: "var(--text-primary)",
              fontSize: "13px",
              cursor: isLoadingMoreMessages ? "not-allowed" : "pointer",
              opacity: isLoadingMoreMessages ? 0.6 : 1,
              transition: "all 0.2s",
            }}
          >
            {isLoadingMoreMessages ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("timeline.loadingMore")}
              </>
            ) : controller.nextLoadIsHistory
              ? t("timeline.loadMoreTurns")
              : t("timeline.loadMoreHistory", {
                  count: totalMessageCount - paginatedMessages.length,
                })}
          </button>
        </div>
      )}

      {isConversationLoading && (
        <div className="history-loading">
          <div className="history-loading-placeholder">
            <div className="skeleton-bubble" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
          <div className="history-loading-placeholder">
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
          <div className="history-loading-placeholder">
            <div className="skeleton-line" />
            <div className="skeleton-line" />
          </div>
          <span
            style={{
              paddingTop: "16px",
              alignSelf: "center",
              fontSize: "var(--font-size-small)",
            }}
          >
            {t("app.agentStarting")}
          </span>
        </div>
      )}

      {!hasActiveConversation && (
        <EmptyState
          hasProject={props.hasProject}
          onCreate={props.onCreateSession}
        />
      )}

      {hasActiveConversation &&
        !isConversationLoading &&
        activeMessages.length === 0 && (
          <SessionStartSurface onQuickPrompt={props.onQuickPrompt} />
        )}

      {/* 虚拟化顶层行渲染列表 */}
      {hasActiveConversation &&
        !isConversationLoading &&
        activeMessages.length > 0 && (
          <div
            ref={(node) => {
              listRef.current = node;
              virtualTimeline.registerListNode?.(node);
            }}
            data-virtualized="true"
            className="message-list min-w-0 w-full mx-auto transition-opacity duration-150"
          >
            <VirtualTimelineRows
              renderPlan={virtualTimeline.renderPlan}
              registerRowNode={virtualTimeline.registerRowNode}
              renderRow={(virtualRow) => {
                const item = virtualRow.item;
                const isSliding = isItemSlidingOut(item);
                // 唯一以 virtualTimeline.rowModel.lastAgentRunKey 为基准，避免原 lastAgentRunIndex 双重判定导致多个 agent-run 被标为最后轮
                const isLastAgentRun = virtualRow.key === virtualTimeline.rowModel.lastAgentRunKey;
                return (
                  <TimelineMessageRow
                    key={virtualRow.key}
                    item={item}
                    index={virtualRow.sourceIndex}
                    totalItems={reconciledRuns.length}
                    sessionId={sessionId}
                    fresh={freshMessageIds.has(virtualRow.anchorId)}
                    showThinking={props.showThinking}
                    liveThinkingId={liveThinkingId}
                    isAgentBusy={isAgentBusy}
                    isLastAgentRun={isLastAgentRun}
                    lastUserMessageId={lastUserMessageId}
                    resendableMessageIds={resendableMessageIds}
                    forkingMessageId={props.forkingMessageId ?? undefined}
                    validCommandNames={props.validCommandNames}
                    validFilePaths={props.validFilePaths}
                    isSliding={isSliding}
                    onPreviewImage={props.onPreviewImage}
                    onOpenExternal={props.onOpenExternal}
                    onOpenFile={props.onOpenFile}
                    onDiffFile={props.onDiffFile}
                    onResendUserMessage={props.onResendUserMessage}
                    onEditMessage={props.onEditMessage}
                    onDeleteMessage={props.onDeleteMessage}
                    onForkMessage={props.onForkMessage}
                    onEnterMultiSelect={enterMultiSelect}
                  />
                );
              }}
            />

            {hasActiveConversation &&
              !cancellingUi &&
              isAgentBusy && (
                <RespondingIndicator
                  // 有 live 思考段即可；不订正文 atom，避免 50ms 重渲 timeline。
                  thinking={liveThinkingId ? "." : undefined}
                  showThinking={props.showThinking}
                  isStarting={activeConversationStatus === "starting"}
                  isExecutingTool={activeRuntimeState?.isExecutingTool}
                  isStreaming={activeRuntimeState?.isStreaming}
                />
              )}

          </div>
        )}

      {/* Ask 是阻塞式会话步骤，必须参与时间线的正常布局；这样它展开时会推动正文高度，
          而不是靠 sticky/z-index 覆盖最后一条工具调用或回答。 */}
      {props.runtimeUi ? (
        <div className="session-runtime-ui mx-auto w-full min-w-0 empty:hidden">
          {props.runtimeUi}
        </div>
      ) : null}

      {/* 发送清屏垫片（pin-to-top）已于 2026 移除：其与流式跟随有冲突、偶发页面抖动。 */}

      {multiSelectOpen && (
        <MultiSelectModal
          renderedRuns={reconciledRuns}
          onClose={() => setMultiSelectOpen(false)}
          onCopy={copySelectedMessages}
        />
      )}
    </MessageScroller>
  );
}
