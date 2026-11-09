import { useState, useRef, useEffect } from "react";
import type { MutableRefObject } from "react";
import type { createStore } from "jotai";
import type {
  AgentTab,
  ComposerAgentMode,
  ImageContent,
} from "../../../shared/types";
import {
	currentSessionIdAtom,
	sessionRuntimeByIdAtom,
} from "../atoms";
import {
  acknowledgeUnknownPrompt,
  claimIdleHead,
  claimNextSteerPrompt,
  enqueuePrompt,
  QUEUED_PROMPT_LIMIT,
  replaceSessionQueue,
  resolveClaimedPrompt,
  retractPrompt,
  type QueuedPromptSnapshot,
} from "../utils/queuedPromptQueue";
import {
  sessionDraftByIdAtom,
  setSessionDraftAtom,
  setSessionAttachmentsAtom,
  setSessionComposerModeAtom,
} from "../atoms/composer-atoms";
import { PromptDeliveryUnknownError } from "../utils/promptErrors";
import { t } from "../i18n";

export type QueuedPrompt = QueuedPromptSnapshot;

export interface UseQueuedPromptOptions {
  displayAgentsRef: MutableRefObject<AgentTab[]>;
  queueFlushBySessionRef: MutableRefObject<Set<string>>;
  composerTextareaRef: MutableRefObject<HTMLDivElement | null>;
  pendingComposerCaretRef: MutableRefObject<number | null>;

  /** Jotai store for restoring Session composer state in retract-to-edit. */
  store: ReturnType<typeof createStore>;

  setComposerCursor: (value: React.SetStateAction<number>) => void;
  showToast: (message: string, duration?: number) => void;
  /** i18n-aware message shown when delivery result is unknown. */
  unknownDeliveryMessage?: string;

  dispatchPromptSnapshot: (
    sessionId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
    agentMode?: ComposerAgentMode,
    templateDescription?: string,
  ) => Promise<void>;
}

/** 队列发送超时：防止 dispatchPromptSnapshot 长时间挂起导致队列项永久卡在 sending。 */
const QUEUED_SEND_TIMEOUT_MS = 30_000;

function withSendTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = QUEUED_SEND_TIMEOUT_MS,
): Promise<{ ok: true; value: T } | { ok: false }> {
  // 定时器必须在任一方落定时清掉：否则每次发送都会留下一个 30s 的悬挂 timer，
  // 在测试里会把事件循环拖到超时，在渲染层也是无意义的常驻计时。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  const settled = Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
  return settled.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function useQueuedPrompt(options: UseQueuedPromptOptions) {
  const {
    displayAgentsRef,
    queueFlushBySessionRef,
    composerTextareaRef,
    pendingComposerCaretRef,
    store,
    setComposerCursor,
    showToast,
    unknownDeliveryMessage = t("app.queuedDeliveryUnknown"),
    dispatchPromptSnapshot,
  } = options;

  const [queuedPrompts, setQueuedPrompts] = useState<Record<string, QueuedPrompt[]>>({});
  const queuedPromptsRef = useRef<Record<string, QueuedPrompt[]>>({});
  // 使用 ref 跟踪组件是否挂载，但必须在 effect 中显式置 true，
  // 避免 StrictMode double-mount 导致 mountedRef 永远为 false。
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  function updateQueuedPrompts(
    updater: (current: Record<string, QueuedPrompt[]>) => Record<string, QueuedPrompt[]>,
  ) {
    const next = updater(queuedPromptsRef.current);
    queuedPromptsRef.current = next;
    if (mountedRef.current) setQueuedPrompts(next);
  }

  function setSessionQueuedPrompts(
    sessionId: string,
    updater: (current: QueuedPrompt[]) => QueuedPrompt[],
  ) {
    updateQueuedPrompts((current) => replaceSessionQueue(current, sessionId, updater));
  }

  /** 入队；满员时返回 false，调用方应保留输入框内容并 toast。 */
  function enqueueQueuedPrompt(sessionId: string, queuedPrompt: QueuedPrompt): boolean {
    const before = queuedPromptsRef.current[sessionId]?.length ?? 0;
    if (before >= QUEUED_PROMPT_LIMIT) return false;
    updateQueuedPrompts((current) => enqueuePrompt(current, sessionId, queuedPrompt));
    return (queuedPromptsRef.current[sessionId]?.length ?? 0) > before;
  }

  function appendUnknownQueuedPrompt(
    sessionId: string,
    queuedPrompt: QueuedPrompt,
    error?: string,
  ) {
    setSessionQueuedPrompts(sessionId, (current) => {
      if (current.length >= QUEUED_PROMPT_LIMIT) return current;
      return [
        ...current,
        { ...queuedPrompt, status: "unknown", error },
      ];
    });
  }

  function retractQueuedPrompt(sessionId: string, promptId: string) {
    updateQueuedPrompts((current) => retractPrompt(current, sessionId, promptId));
  }

  /** 丢弃：pending/failed 走 retract；unknown 仅移除提示（不重发）。sending 不可丢弃。 */
  function discardQueuedPrompt(sessionId: string, promptId: string) {
    const live = queuedPromptsRef.current[sessionId]?.find((item) => item.id === promptId);
    if (!live || live.status === "sending") return;
    if (live.status === "unknown") {
      updateQueuedPrompts((current) =>
        acknowledgeUnknownPrompt(current, sessionId, promptId),
      );
      return;
    }
    retractQueuedPrompt(sessionId, promptId);
  }

  function retractQueuedPromptForEdit(sessionId: string, queuedPrompt: QueuedPrompt) {
    const livePrompt = queuedPromptsRef.current[sessionId]?.find(
      (promptItem) => promptItem.id === queuedPrompt.id,
    );
    if (
      !livePrompt ||
      livePrompt.status === "sending" ||
      livePrompt.status === "unknown"
    ) return;
    retractQueuedPrompt(sessionId, livePrompt.id);

    // Resolve Session binding; if found, restore through Session atoms so the modern
    // ComposerArea (which reads sessionDraftByIdAtom / sessionAttachmentsByIdAtom /
    // sessionComposerModeByIdAtom) sees the restored content immediately.
    const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
    const restoredPrompt = [livePrompt.displayText, currentDraft]
      .filter((text) => text.trim())
      .join("\n\n");
    store.set(setSessionDraftAtom, { sessionId, value: restoredPrompt });
    if (livePrompt.images?.length) {
      store.set(setSessionAttachmentsAtom, {
        sessionId,
        value: (current: ImageContent[]) => [...livePrompt.images!, ...current],
      });
    }
    store.set(setSessionComposerModeAtom, { sessionId, mode: livePrompt.agentMode });
    if (store.get(currentSessionIdAtom) === sessionId) {
      setComposerCursor(restoredPrompt.length);
      pendingComposerCaretRef.current = restoredPrompt.length;
      requestAnimationFrame(() => {
        const editor = composerTextareaRef.current;
        editor?.focus();
        if (editor) editor.scrollTop = editor.scrollHeight;
      });
    }
  }

  function isSessionRuntimeBusy(sessionId: string) {
    const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
    const runtimeAgentId = runtime?.agentId;
    const agent = displayAgentsRef.current.find((item) => item.id === runtimeAgentId);
    const runtimeState = runtime?.state;
    return Boolean(
      agent?.status === "starting" ||
      agent?.status === "running" ||
      runtimeState?.isStreaming ||
      runtimeState?.isExecutingTool,
    );
  }

  function canFlushQueuedPrompt(sessionId: string) {
    const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
    return runtime?.status === "idle" && !isSessionRuntimeBusy(sessionId);
  }

  /**
   * 忙碌期间的 steer 投递：每个 tool-end 窗口只投递队首一条。
   *
   * 把整批排队消息一次性塞给 pi 会同时踩两个坑：
   * 1. pi 的 steering 队列按回合逐条 drain，一次交出去的多条消息要跨多个回合才陆续
   *    进入上下文；而本地队列此时已经清空——用户看到「一次性全发出去」，却只有
   *    第一条立刻生效，其余既无法撤回也看不到进度。
   * 2. run 收尾阶段（最后一次 drain 之后、agent_end 之前）到达的 steer 仍会被 accept，
   *    但 agent loop 已退出，这些消息要等下一次 run 才被消费，看起来就像被吞了。
   * 串行投递让其余消息留在本地队列（仍可撤回/编辑），agent 空闲时再由
   * flushNextQueuedPrompt 逐条补发，保证每条消息都拿到自己的回合与回复。
   */
  async function flushQueuedSteerPrompts(sessionId: string) {
    if (queueFlushBySessionRef.current.has(sessionId) || !isSessionRuntimeBusy(sessionId)) return;
    queueFlushBySessionRef.current.add(sessionId);
    // 只有真的交出去一条时才需要在 finally 里补一次空闲检查；空队列的 tool-end
    // 不应该每次都排一个空转的定时器。
    let dispatched = false;
    try {
      const claimed = claimNextSteerPrompt(queuedPromptsRef.current, sessionId);
      if (!claimed.prompt) return;
      const queuedPrompt = claimed.prompt;
      dispatched = true;
      queuedPromptsRef.current = claimed.queues;
      setQueuedPrompts(claimed.queues);

      try {
        const outcome = await withSendTimeout(
          dispatchPromptSnapshot(
            sessionId,
            queuedPrompt.message,
            queuedPrompt.images,
            "steer",
            queuedPrompt.agentMode,
            queuedPrompt.templateDescription,
          ),
        );
        if (!outcome.ok) {
          updateQueuedPrompts((current) =>
            resolveClaimedPrompt(current, sessionId, queuedPrompt.id, {
              type: "unknown",
              error: "Send timed out",
            }),
          );
          showToast(unknownDeliveryMessage, 6000);
          return;
        }
        updateQueuedPrompts((current) =>
          resolveClaimedPrompt(current, sessionId, queuedPrompt.id, {
            type: "accepted",
          }),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const deliveryUnknown = error instanceof PromptDeliveryUnknownError;
        updateQueuedPrompts((current) =>
          resolveClaimedPrompt(current, sessionId, queuedPrompt.id, {
            type: deliveryUnknown ? "unknown" : "failed",
            error: errorMessage,
          }),
        );
        showToast(
          deliveryUnknown ? unknownDeliveryMessage : errorMessage,
          deliveryUnknown ? 6000 : 4000,
        );
      }
    } finally {
      queueFlushBySessionRef.current.delete(sessionId);
      // 与 flushNextQueuedPrompt 一致：等运行态回流后再判断空闲。刚发完 steer 时
      // 渲染层的 runtime 可能还是陈旧的 idle，立即补发会把下一条又当成普通 prompt
      // 推给 pi，重新变成“一批消息一起发出”。
      // 同时覆盖一种卡死：agent 已经 idle 时 App 的 drain effect 正好被本函数的锁
      // 挡回，之后不再有状态变化，只能靠这里补一次。
      if (dispatched) {
        window.setTimeout(() => {
          if (canFlushQueuedPrompt(sessionId)) {
            void flushNextQueuedPrompt(sessionId);
          }
        }, 150);
      }
    }
  }

  /** 串行策略：agent 每次空闲只发送队首，其余消息继续可撤回。 */
  async function flushNextQueuedPrompt(sessionId: string) {
    if (queueFlushBySessionRef.current.has(sessionId) || !canFlushQueuedPrompt(sessionId)) return;
    const claimed = claimIdleHead(queuedPromptsRef.current, sessionId);
    if (!claimed.prompt) return;
    const queuedPrompt = claimed.prompt;

    queuedPromptsRef.current = claimed.queues;
    setQueuedPrompts(claimed.queues);
    queueFlushBySessionRef.current.add(sessionId);
    try {
      const outcome = await withSendTimeout(
        dispatchPromptSnapshot(
          sessionId,
          queuedPrompt.message,
          queuedPrompt.images,
          queuedPrompt.behavior === "direct" ? undefined : queuedPrompt.behavior,
          queuedPrompt.agentMode,
          queuedPrompt.templateDescription,
        ),
      );
      if (!outcome.ok) {
        updateQueuedPrompts((current) =>
          resolveClaimedPrompt(current, sessionId, queuedPrompt.id, {
            type: "unknown",
            error: "Send timed out",
          }),
        );
        showToast(unknownDeliveryMessage, 6000);
        return;
      }
      updateQueuedPrompts((current) =>
        resolveClaimedPrompt(current, sessionId, queuedPrompt.id, {
          type: "accepted",
        }),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const deliveryUnknown = error instanceof PromptDeliveryUnknownError;
      updateQueuedPrompts((current) =>
        resolveClaimedPrompt(current, sessionId, queuedPrompt.id, {
          type: deliveryUnknown ? "unknown" : "failed",
          error: errorMessage,
        }),
      );
      showToast(
        deliveryUnknown ? unknownDeliveryMessage : errorMessage,
        deliveryUnknown ? 6000 : 4000,
      );
    } finally {
      queueFlushBySessionRef.current.delete(sessionId);
      window.setTimeout(() => {
        if (canFlushQueuedPrompt(sessionId)) {
          void flushNextQueuedPrompt(sessionId);
        }
      }, 150);
    }
  }

  return {
    queuedPrompts,
    setQueuedPrompts,
    queuedPromptsRef,
    updateQueuedPrompts,
    setSessionQueuedPrompts,
    enqueueQueuedPrompt,
    appendUnknownQueuedPrompt,
    retractQueuedPrompt,
    discardQueuedPrompt,
    retractQueuedPromptForEdit,
    isSessionRuntimeBusy,
    canFlushQueuedPrompt,
    flushQueuedSteerPrompts,
    flushNextQueuedPrompt,
  };
}
