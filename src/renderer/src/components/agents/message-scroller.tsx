"use client";
// 基于 beui.dev/components/agents/message-scroller
// 滚动引擎替换为 use-stick-to-bottom（MIT，StackBlitz，src/lib/stick-to-bottom 本地移植）
// 注：beUI 原版的右侧消息导航 rail（PreviewRail）已移除——本项目从未挂载过
// navigation="rail"，属死代码；如未来需要导航轴，用 `npx shadcn add @beui/...` 重装。

import { useReducedMotion } from "motion/react";
import {
  type ComponentPropsWithRef,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import {
  useStickToBottom,
  type ScrollToBottom,
  type StopScroll,
} from "@/lib/stick-to-bottom";

/** 供时间线 controller 调用的引擎滚动 API（回底弹簧 / 原子恢复位置）。 */
export type MessageScrollerScrollApi = {
  scrollToBottom: ScrollToBottom;
  /** 原子恢复历史位置：定位 + 解锁锁底 + 取消在途动画（见引擎 restoreAt）。 */
  restoreAt: (scrollTop: number) => void;
  /** 解锁锁底并取消在途弹簧，发送置顶动画插入垫片前必须先调，否则 RO 会瞬间贴底。 */
  stopScroll: StopScroll;
};

export interface MessageScrollerProps extends ComponentPropsWithRef<"div"> {
  /** 初始是否跟底。优先使用此显式初始化语义，避免受镜像回写干扰。 */
  initialFollowOutput?: boolean;
  /** Keep streamed output pinned while the reader remains near the end. */
  followOutput?: boolean;
  /** Distance from the end that still counts as following the output. */
  followThreshold?: number;
  /** Smoothly follow growing content. */
  smooth?: boolean;
  /** Reports when the reader leaves or returns to the live edge. */
  onFollowChange?: (following: boolean) => void;
  /** Accessible label for the scrollable transcript. */
  label?: string;
  /** Marks the transcript as waiting for more streamed content. */
  busy?: boolean;
  viewportClassName?: string;
  contentClassName?: string;
  viewportRef?: Ref<HTMLElement>;
  /**
   * 向时间线 controller 暴露 stick-to-bottom 引擎 API。
   * 回底按钮应走弹簧 smooth，而不是原生 timeline.scrollTo。
   */
  scrollApiRef?: Ref<MessageScrollerScrollApi | null>;
  viewportProps?: Omit<
    ComponentPropsWithRef<"section">,
    "children" | "className" | "ref"
  >;
  contentProps?: Omit<
    ComponentPropsWithRef<"div">,
    "children" | "className" | "ref"
  >;
}

export function MessageScroller({
  initialFollowOutput,
  followOutput = true,
  followThreshold = 56,
  smooth = true,
  onFollowChange,
  label = "Conversation",
  busy,
  viewportClassName,
  contentClassName,
  viewportRef: externalViewportRef,
  scrollApiRef,
  viewportProps,
  contentProps,
  className,
  children,
  ...props
}: MessageScrollerProps) {
  const reduce = useReducedMotion() ?? false;
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // 初始跟随语义：initialFollowOutput 优先，次选 followOutput
  const initialFollow = initialFollowOutput ?? followOutput ?? true;

  // 流式结束过渡（needsInstant）：busy（等待流式输出）true→false 后的窗口期内，
  // 内容增长追底用 instant 而非 smooth，避免最终文本长高触发平滑滚动动画造成跳屏。
  const [busyEnding, setBusyEnding] = useState(false);
  const busyEndingTimerRef = useRef<number | undefined>(undefined);
  const {
    onScroll: onViewportScroll,
    onWheel: onViewportWheel,
    onTouchStart: onViewportTouchStart,
    onKeyDown: onViewportKeyDown,
    ...restViewportProps
  } = viewportProps ?? {};

  // ── 滚动引擎：use-stick-to-bottom ──
  const stick = useStickToBottom({
    initial: initialFollow ? "instant" : false,
    resize: busyEnding || reduce || !smooth ? "instant" : "smooth",
    instantResizeThreshold: 28,
  });
  const engineScrollRef = stick.scrollRef;
  const engineContentRef = stick.contentRef;
  const engineScrollToBottom = stick.scrollToBottom;
  const engineIsAtBottom = stick.isAtBottom;
  const engineRestoreAt = stick.restoreAt;
  const engineStopScroll = stick.stopScroll;

  // 在 layout effect 中同步发布 engine API 给外部，避免首帧恢复时拿不到或被异步打乱
  const currentApiRef = useRef<MessageScrollerScrollApi | null>(null);
  useLayoutEffect(() => {
    if (!scrollApiRef) return;
    const api: MessageScrollerScrollApi = {
      scrollToBottom: engineScrollToBottom,
      restoreAt: engineRestoreAt,
      stopScroll: engineStopScroll,
    };
    currentApiRef.current = api;
    if (typeof scrollApiRef === "function") {
      scrollApiRef(api);
      return () => {
        scrollApiRef(null);
      };
    }
    scrollApiRef.current = api;
    return () => {
      if (scrollApiRef.current === api) {
        scrollApiRef.current = null;
      }
    };
  }, [scrollApiRef, engineScrollToBottom, engineRestoreAt, engineStopScroll]);

  const setViewportRef = useCallback(
    (node: HTMLElement | null) => {
      viewportRef.current = node;
      engineScrollRef(node);
      if (typeof externalViewportRef === "function") {
        externalViewportRef(node);
      } else if (externalViewportRef) {
        externalViewportRef.current = node;
      }
    },
    [engineScrollRef, externalViewportRef],
  );

  const setContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      engineContentRef(node);
    },
    [engineContentRef],
  );

  // ── followOutput / onFollowChange 桥接 ──
  // engineIsAtBottom 即跟随状态；外部 followOutput 仅作为兼容的显式输入控制口
  const isFollowing = engineIsAtBottom;

  // 监听显式 followOutput 的边沿变化（仅当外部值发生真实 boolean 翻转时响应，不依赖 isFollowing 造成循环）
  const prevFollowOutputRef = useRef(followOutput);
  useLayoutEffect(() => {
    const prev = prevFollowOutputRef.current;
    prevFollowOutputRef.current = followOutput;

    if (prev === followOutput) {
      return;
    }

    if (!followOutput) {
      engineStopScroll();
      return;
    }

    // 从 false 变更为 true（显式要求回底跟随）
    const scroll = viewportRef.current;
    const distance = scroll
      ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
      : 0;
    const animation =
      reduce || distance <= followThreshold ? "instant" : "smooth";
    engineScrollToBottom({ animation });
  }, [followOutput, followThreshold, reduce, engineScrollToBottom, engineStopScroll]);

  // 回报引擎跟随状态变化
  useEffect(() => {
    onFollowChange?.(isFollowing);
  }, [isFollowing, onFollowChange]);

  // 流式结束瞬间：busy true→false，开启 150ms 过渡窗口（期间追底用 instant）。
  useEffect(() => {
    if (busy) return;
    if (busyEndingTimerRef.current) window.clearTimeout(busyEndingTimerRef.current);
    setBusyEnding(true);
    busyEndingTimerRef.current = window.setTimeout(() => {
      setBusyEnding(false);
    }, 150);
    return () => {
      if (busyEndingTimerRef.current) window.clearTimeout(busyEndingTimerRef.current);
    };
  }, [busy]);

  useEffect(
    () => () => {
      if (busyEndingTimerRef.current) window.clearTimeout(busyEndingTimerRef.current);
    },
    [],
  );

  const viewport = (
    <section
      ref={setViewportRef}
      aria-label={label}
      {...restViewportProps}
      onScroll={(event) => {
        onViewportScroll?.(event);
      }}
      onWheel={(event) => {
        onViewportWheel?.(event);
      }}
      onTouchStart={(event) => {
        onViewportTouchStart?.(event);
      }}
      onKeyDown={(event) => {
        onViewportKeyDown?.(event);
      }}
      className={cn(
        "h-full overflow-y-auto overscroll-contain outline-none [overflow-anchor:none] [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        viewportClassName,
      )}
    >
      <div
        ref={setContentRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={busy}
        className={contentClassName}
        {...contentProps}
      >
        {children}
      </div>
    </section>
  );

  return (
    <div
      data-slot="message-scroller"
      className={cn("min-h-0", className)}
      {...props}
    >
      {viewport}
    </div>
  );
}
