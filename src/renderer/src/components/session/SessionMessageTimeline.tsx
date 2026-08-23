import { useAtomValue, useSetAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import type { ChatMessage, ImageContent } from "../../../../shared/types";
import { MarkdownStream } from "./MarkdownStream";
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
  sessionSendStateByIdAtom,
} from "../../atoms";
import {
  canLoadSessionTimelineMore,
  deriveSessionSurfaceRuntime,
  isLatestTimelineRunBusy,
  resolveTimelineTopCompensation,
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
import {
  selectTimelineTurnWindow,
  shouldWindowTimelineTurns,
  TIMELINE_MOUNTED_TURN_LIMIT,
  TIMELINE_SCROLLED_MAX_ITEMS,
  countAgentRunItems,
} from "./timeline/turnRenderWindow";

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
function isFloatingFailureMessage(message: ChatMessage): boolean {
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

type TimelineInteractionProps = {
  hasProject: boolean;
  onCreateSession: () => void;
  showThinking: boolean;
  validCommandNames: Set<string>;
  validFilePaths: Set<string>;
  onPreviewImage: (image: ImageContent) => void;
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
  const sendStateSelector = useMemo(
    () => selectAtom(
      sessionSendStateByIdAtom,
      (states) => states[sessionId],
      Object.is,
    ),
    [sessionId],
  );
  const messageLoadState = useAtomValue(messageLoadStateSelector);
  const sendState = useAtomValue(sendStateSelector);
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
    for (const timer of slidingTimersRef.current.values()) {
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
    for (const timer of freshTimersRef.current.values()) window.clearTimeout(timer);
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
  // 渲染窗口（2026-08 黑屏治理）：贴底只挂尾部 3 轮；上滚查看历史也裁剪
  // （controller.scrolledWindowTurns，初始 15 轮 + 「显示更早」逐步扩大）——
  // 历史全量放开挂载是大会话渲染进程内存峰值/黑屏的来源。数据仍在 atoms。
  const followingForTurnWindow = controller.autoScroll;
  const turnWindowTurns = followingForTurnWindow
    ? TIMELINE_MOUNTED_TURN_LIMIT
    : controller.scrolledWindowTurns;
  const displayRuns = useMemo(
    () => selectTimelineTurnWindow(
      reconciledRuns,
      turnWindowTurns,
      followingForTurnWindow ? undefined : TIMELINE_SCROLLED_MAX_ITEMS,
    ),
    [followingForTurnWindow, reconciledRuns, turnWindowTurns],
  );
  // 「最后一个 agent-run」：live 挂载门的判定基准。不能按最后一条显示条目判定：
  // steer 排队期显示数组以用户消息结尾（新轮尚未产生首条消息），最后一条 agent-run
  // 才是真正的流式轮；反过来若门控放宽到任意轮，被 steer 打断的旧轮（尾部是空文本
  // interim）会挂上会话级流式槽，把新一轮正文在旧轮底部再打印一遍（同一中间回复
  // 前后双份，2026-08 回归）。
  // 注意：这个判定只用于 live 挂载门——isLatestRun/busy 仍按「最后一条显示条目」
  // 判定，否则普通发送的激活等待期（用户消息在末尾）会把上一轮已完成、已提升的
  // 最终回答重新降级，导致最终回答暂时消失。
  const lastAgentRunIndex = useMemo(() => {
    for (let index = displayRuns.length - 1; index >= 0; index -= 1) {
      if (displayRuns[index].kind === "agent-run") return index;
    }
    return -1;
  }, [displayRuns]);
  const turnWindowActive = shouldWindowTimelineTurns(
    countAgentRunItems(reconciledRuns),
    turnWindowTurns,
  );
  // 窗口轮数变化（上滚 3→15、点「显示更早」扩大）会在顶部插入内容，需补偿 scrollTop
  // 保持视口内容不动；数据 prepend 的补偿由 controller 的 loadMoreAnchorRef 负责，
  // 两者按「窗口轮数变化 / 数据变化」分工，不会同帧双重补偿。贴底时由引擎接管不补偿。
  const turnWindowStateRef = useRef<{ windowed: boolean; height: number; turns: number }>({
    windowed: false,
    height: 0,
    turns: 0,
  });
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const prev = turnWindowStateRef.current;
    const nextHeight = timeline.scrollHeight;
    if (
      prev.windowed &&
      prev.turns !== turnWindowTurns &&
      nextHeight > prev.height &&
      !followingForTurnWindow
    ) {
      // 顶部（≤HISTORY_AUTO_LOAD_THRESHOLD）不补偿：插入内容在视口上方时
      // 浏览器无滚动锚定（overflow-anchor:none），scrollTop 原位不动即可看到
      // 新展开的内容；补偿会把新内容推出视口上方，表现为「点「显示更早」没反应」。
      // 与数据 prepend 补偿共用 resolveTimelineTopCompensation 决策（2026-02 修复）。
      const nextTop = resolveTimelineTopCompensation(
        timeline.scrollTop,
        nextHeight - prev.height,
      );
      if (nextTop !== null) {
        // 标记程序化滚动：补偿的 scrollTop 位移会派发 scroll 事件，
        // 必须让自动加载监听忽略（补偿后视口可能落在顶部区间）
        controller.markProgrammaticScroll?.();
        timeline.scrollTop = nextTop;
      }
    }
    turnWindowStateRef.current = {
      windowed: turnWindowActive,
      height: nextHeight,
      turns: turnWindowTurns,
    };
  }, [controller, displayRuns, followingForTurnWindow, timelineRef, turnWindowActive, turnWindowTurns]);
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
        const { toBlob } = await loadHtmlToImage();
        const source = timelineRef.current?.querySelector(
          ".message-list",
        ) as HTMLElement | null;
        if (!source) return;

        const captureIds = getMultiSelectImageCaptureIds(reconciledRuns, selectedIds);
        const clone = source.cloneNode(true) as HTMLElement;
        for (const item of Array.from(clone.children)) {
          if (!(item instanceof HTMLElement)) continue;
          const id = item.dataset.messageId;
          if (!id || !captureIds.has(id)) item.remove();
        }
        clone.classList.add("multi-select-image-export");
        clone.style.width = `${Math.max(source.clientWidth, source.scrollWidth)}px`;
        clone.style.padding = "24px";
        clone.style.background =
          getComputedStyle(document.documentElement).getPropertyValue(
            "--color-bg-panel",
          ) || "#fff";
        document.body.appendChild(clone);
        let blob: Blob | null = null;
        try {
          blob = await toBlob(clone, {
            pixelRatio: Math.min(2, window.devicePixelRatio || 1),
            backgroundColor:
              getComputedStyle(document.documentElement).getPropertyValue(
                "--color-bg-panel",
              ) || undefined,
            filter: (node) =>
              !(node instanceof HTMLElement) ||
              (!node.classList.contains("turn-row-actions") &&
                !node.classList.contains("user-turn-actions") &&
                !node.classList.contains("copy-menu-popover")),
          });
        } finally {
          clone.remove();
        }
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
      // 宽度约束落在内层 [role=log] 而非 scroller 宿主：视口撑满整个面板，
      // 原生滚动条贴面板最右侧；内容列仍与 composer 同宽居中（见 chatContentWidth）。
      contentProps={showSurfaceEmptyState ? undefined : { style: chatContentWidthStyle }}
      viewportRef={timelineRef}
      scrollApiRef={controller.scrollerScrollApiRef}
      followOutput={controller.autoScroll}
      followThreshold={56}
      smooth
      // busy 只驱动 aria-busy 和结束后的 150ms instant 窗口；流式增高是否弹簧
      // 由 MessageScroller 的 resize + 28px 阈值决定，不再整段忙碌硬贴底。
      busy={isAgentBusy || isAwaitingAssistant}
      onFollowChange={controller.setAutoScrollFromScroller}
      viewportProps={{
        // 会话切换滚动位置保持：滚动时维护 per-session 锚点（rAF 合并，不触发渲染）
        onScroll: controller.handleTimelineScroll,
      }}
    >
      {(turnWindowActive || (hasMoreMessages && canLoadMoreMessages)) && (
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
              // 窗口裁剪生效时先扩大渲染窗口（显示已加载的更早内容）；
              // 窗口已覆盖全部已加载数据且还有历史时才翻数据页。
              // 数据翻页补偿（loadMoreAnchorRef）与窗口扩大补偿（turnWindowStateRef）
              // 发生在不同帧，不会双重补偿。
              if (turnWindowActive) {
                controller.expandWindow();
              } else if (hasMoreMessages && canLoadMoreMessages) {
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
              // 加载动画：点击后立即出现，真正加载完成（finally 复位 isLoadingMessagePage）才消失
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                {t("timeline.loadingMore")}
              </>
            ) : turnWindowActive
                ? t("timeline.loadEarlierTurns", {
                    count: countAgentRunItems(reconciledRuns) - turnWindowTurns,
                  })
                : controller.nextLoadIsHistory
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

      {/* 长会话渲染治理：
          - 不再使用 content-visibility 估算高度（展开工具会抖）。
          - 学 Proma：总折叠压缩单行 DOM；另在贴底时只挂尾部 N 个 agent-run
            （见 turnRenderWindow），上滚放开。分页仍做数据窗口治理。 */}
      {hasActiveConversation &&
        !isConversationLoading &&
        activeMessages.length > 0 && (
          <div className="message-list min-w-0 w-full mx-auto transition-opacity duration-150">
            {displayRuns.map((item, index) => {
              const isSliding = isItemSlidingOut(item);
              let node: ReactNode = null;
              if (item.kind === "agent-run") {
                // Controls：忙碌中的末行 run 视为 live（isStreaming 补丁可能略滞后于正文 atom）。
                const isRunStreaming = isLatestTimelineRunBusy(
                  isAgentBusy,
                  index,
                  displayRuns.length,
                );
                node = (
                  <TurnRow
                    key={item.id}
                    run={item}
                    sessionId={sessionId}
                    fresh={freshMessageIds.has(item.id)}
                    onPreviewImage={props.onPreviewImage}
                    showThinking={props.showThinking}
                    isStreaming={isRunStreaming}
                    // 始终下发 live id（按 message id 命中）；勿绑 isRunStreaming，
                    // 否则流结束而 History 未到时会提前卸思考步导致 remount dump。
                    liveThinkingId={liveThinkingId}
                    agentRunning={isRunStreaming}
                    isLatestRun={index === displayRuns.length - 1}
                    isLastAgentRun={index === lastAgentRunIndex}
                    onOpenExternal={props.onOpenExternal}
                    onOpenFile={props.onOpenFile}
                    onDiffFile={props.onDiffFile}
                    onEditMessage={props.onEditMessage}
                    onDeleteMessage={props.onDeleteMessage}
                    onEnterMultiSelect={() => setMultiSelectOpen(true)}
                  />
                );
              } else if (item.kind === "message") {
                const message = item.message;
                if (message.role === "user") {
                  node = (
                    <UserBubble
                      key={message.id}
                      message={message}
                      fresh={freshMessageIds.has(message.id)}
                      onPreviewImage={props.onPreviewImage}
                      onOpenFile={props.onOpenFile}
                      onResendUserMessage={props.onResendUserMessage}
                      onEditMessage={props.onEditMessage}
                      onDeleteMessage={props.onDeleteMessage}
                      onForkMessage={props.onForkMessage}
                      forking={props.forkingMessageId === message.id}
                      agentRunning={isAgentBusy}
                      isLastUserMessage={message.id === lastUserMessageId}
                      showResendButton={resendableMessageIds.has(message.id)}
                      validCommandNames={props.validCommandNames}
                      validFilePaths={props.validFilePaths}
                      onEnterMultiSelect={() => setMultiSelectOpen(true)}
                    />
                  );
                } else if (message.role === "error") {
                  // 失败/重试类提示已转 toast（见 FLOATING_FAILURE_KEYS），
                  // 时间线不再渲染卡片；pi 启动失败/运行时诊断仍走诊断卡片。
                  if (isFloatingFailureMessage(message)) return null;
                  node = <DiagnosticMessageCard key={message.id} message={message} />;
                } else if (message.role === "system") {
                  const meta = message.meta as any;
                  if (meta?.type === "askQuestion") {
                    // Pending extension UI is rendered once in the timeline footer.
                    // Legacy in-memory messages may still contain this placeholder.
                    return null;
                  }
                  if (meta?.type === "compaction") {
                    node = <CompactionCard key={message.id} message={message} sessionId={sessionId} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
                  } else {
                    // 自动重试状态（retryScheduled/retrySucceeded/retryFailed 等）
                    // 属于「重试提示」，与失败类一样转 toast、不占时间线。
                    if (isFloatingFailureMessage(message)) return null;
                    node = <DiagnosticMessageCard key={message.id} message={message} />;
                  }
                }
              }

              if (!node) return null;
              if (isSliding) {
                const itemId = item.kind === "message" ? item.message.id : item.id;
                return (
                  <div key={`slideout-${itemId}`} className="timeline-message-slide-out">
                    {node}
                  </div>
                );
              }
              return node;
            })}

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
