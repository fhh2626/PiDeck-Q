import { useSetAtom, useStore } from "jotai";
import { useRef } from "react";
import type {
  ChatMessage,
  ImageContent,
  SendSessionPromptInput,
  SendSessionPromptResult,
  SessionRuntimeTarget,
} from "../../../shared/types";
import {
  bindSessionRuntimeAtom,
  bumpNewTurnCollapseTickAtom,
  cacheSessionMessagesAtom,
  sessionAttachmentsByIdAtom,
  sessionMessagesCacheAtom,
  sessionComposerModeByIdAtom,
  sessionDraftByIdAtom,
  sessionRecordsAtom,
  sessionRuntimeByIdAtom,
  setSessionAttachmentsAtom,
  setSessionDraftAtom,
  setSessionSendStateAtom,
  upsertSessionAtom,
} from "../atoms";
import {
  buildComposerPromptSubmission,
  expandPromptTemplates,
} from "../composerBehavior";
import { exceedsComposerImagePayloadBudget } from "../utils/composerImages";
import { buildOptimisticCacheWrite } from "../utils/optimisticSessionCache";
import { settleOptimisticMessage } from "../utils/optimisticUserReconciliation";
import { t, translateI18nDescriptor } from "../i18n";

export type EnqueuePromptSnapshot = {
  displayText: string;
  message: string;
  images?: ImageContent[];
  agentMode: string;
  /** 排队投递策略，决定在 agent busy/idle 哪个阶段排空。 */
  behavior?: "steer" | "followUp";
};

type PromptTemplate = {
  name: string;
  path: string;
  description: string;
  content: string;
  argumentHint?: string;
};

type SessionPromptApi = (
  input: SendSessionPromptInput,
) => Promise<SendSessionPromptResult>;

export type UseSessionSendOptions = {
  /** Stable public identity for every draft, request, queue entry, and runtime binding. */
  sessionId: string;
  sendPrompt: SessionPromptApi;
  /** Promotes a renderer-only pre-send surface to a persistent Session. */
  ensureSessionId?: (sessionId: string) => Promise<string>;
  templates: PromptTemplate[];
  prepareMessage?: (message: string) => Promise<string>;
  onDraftMutation?: (sessionId: string) => void;
  compact: (target: SessionRuntimeTarget, prompt?: string) => Promise<void>;
  resetComposerUi?: () => void;
  recordPromptHistory?: (sessionId: string, message: string) => void;
  refreshProject?: (projectId: string) => void;
  showError?: (message: string, duration?: number) => void;
  showUnknown?: () => void;
  /** Called when streamingBehavior is "steer" before sending. Returns true if enqueued. */
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
};

export function normalizeComposerDomText(value: string): string {
  return value.replace(/\u200B/g, "");
}

export function mergeRejectedComposerDraft(
  rejectedDraft: string,
  currentDraft: string,
): string {
  return [rejectedDraft, currentDraft]
    .filter((text) => text.trim())
    .join("\n\n");
}

export function mergeRejectedComposerImages(
  rejectedImages: ImageContent[] | undefined,
  currentImages: ImageContent[],
): ImageContent[] {
  return rejectedImages?.length
    ? [...rejectedImages, ...currentImages]
    : currentImages;
}

export function hasComposerSubmission(
  message: string,
  images: ImageContent[] | undefined,
): boolean {
  return Boolean(message.trim() || images?.length);
}

export function classifySessionPromptResult(
  result: SendSessionPromptResult,
): "accepted" | "rejected" | "unknown" {
  if (result.accepted) return "accepted";
  return result.delivery === "unknown" ? "unknown" : "rejected";
}

export function createSessionSendLock() {
  const sessionIds = new Set<string>();
  return {
    has: (sessionId: string) => sessionIds.has(sessionId),
    claim: (sessionId: string) => {
      if (sessionIds.has(sessionId)) return false;
      sessionIds.add(sessionId);
      return true;
    },
    release: (sessionId: string) => {
      sessionIds.delete(sessionId);
    },
  };
}

export { buildOptimisticCacheWrite };


export function useSessionSend(options: UseSessionSendOptions) {
  const store = useStore();
  const setDraft = useSetAtom(setSessionDraftAtom);
  const setAttachments = useSetAtom(setSessionAttachmentsAtom);
  const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);
  const setSendState = useSetAtom(setSessionSendStateAtom);
  const bindRuntime = useSetAtom(bindSessionRuntimeAtom);
  const upsertSession = useSetAtom(upsertSessionAtom);
  const sendingSessionIdsRef = useRef<Set<string>>(new Set());

  /** 写入乐观消息时保留窗口/历史字段；runtime 全量写入缺省会清除它们。 */
  function writeOptimisticCache(
    targetSessionId: string,
    messages: ChatMessage[],
    options?: { allowPendingRemoval?: boolean },
  ) {
    const current = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
    setCacheMessages(buildOptimisticCacheWrite(targetSessionId, messages, current, options));
  }

  /** 队列/压缩等“不会直接发给 host”的路径要收回本地气泡，避免留下永久 pending。 */
  function discardOptimisticBubble(targetSessionId: string, targetRequestId: string) {
    const current = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
    // 只删本地乐观行；若投影恰好复用了同一个 id，权威行不能被当成气泡删掉。
    if (!current?.messages.some((item) =>
      item.id === targetRequestId && item.meta?.optimistic === true
    )) return;
    writeOptimisticCache(
      targetSessionId,
      current.messages.filter((item) =>
        !(item.id === targetRequestId && item.meta?.optimistic === true)
      ),
      { allowPendingRemoval: true },
    );
  }

  /**
   * 把实际提交给主进程的正文补到本地气泡上。
   * 模板/技能展开后正文与用户输入不同；主进程权威消息使用展开正文，
   * 仅靠原始输入无法在请求 id 缺失时配对。
   */
  function updateOptimisticMatchText(
    targetSessionId: string,
    targetRequestId: string,
    matchText: string,
  ) {
    const current = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
    if (!current) return;
    let found = false;
    const messages = current.messages.map((item) => {
      if (item.id !== targetRequestId || item.meta?.optimistic !== true) return item;
      found = true;
      return { ...item, meta: { ...item.meta, optimisticMatchText: matchText } };
    });
    if (!found) return;
    writeOptimisticCache(targetSessionId, messages);
  }

  function clearSnapshot(targetSessionId: string) {
    options.onDraftMutation?.(targetSessionId);
    setDraft({ sessionId: targetSessionId, value: "" });
    setAttachments({ sessionId: targetSessionId, value: [] });
  }

  function restoreRejectedSnapshot(
    targetSessionId: string,
    message: string,
    imageSnapshot?: ImageContent[],
  ) {
    options.onDraftMutation?.(targetSessionId);
    setDraft({
      sessionId: targetSessionId,
      value: (current) => [message, current]
        .filter((text) => text.trim())
        .join("\n\n"),
    });
    if (imageSnapshot) {
      setAttachments({
        sessionId: targetSessionId,
        value: (current) => [...imageSnapshot, ...current],
      });
    }
  }

  /** 模板正文为空时统一的拦截提示：error 状态 + toast（带模板名，便于定位编辑）。 */
  function rejectEmptyTemplate(templateName: string) {
    const message = t("app.promptTemplateEmptyBody", { name: templateName });
    setSendState({
      sessionId: options.sessionId,
      state: { status: "error", error: message },
    });
    options.showError?.(message, 4500);
  }

  return async function sendSessionPrompt(
    streamingBehavior?: "steer" | "followUp",
  ) {
    const sourceSessionId = options.sessionId;
    if (sendingSessionIdsRef.current.has(sourceSessionId)) return;

    const message = store.get(sessionDraftByIdAtom)[sourceSessionId] ?? "";
    const attachmentSnapshot = store.get(sessionAttachmentsByIdAtom)[sourceSessionId] ?? [];
    const imageSnapshot = attachmentSnapshot.length
      ? [...attachmentSnapshot]
      : undefined;
    if (!hasComposerSubmission(message, imageSnapshot)) return;
    if (exceedsComposerImagePayloadBudget(imageSnapshot)) {
      const errorMessage = t("app.imagesTotalTooLarge");
      setSendState({
        sessionId: sourceSessionId,
        state: { status: "error", error: errorMessage },
      });
      options.showError?.(errorMessage, 4500);
      return;
    }

    sendingSessionIdsRef.current.add(sourceSessionId);
    const requestId = crypto.randomUUID();
    const trimmedMessage = message.trim();
    const isCompactCommand = /^\/compact(?:\s|$)/.test(trimmedMessage);
    const usesLocalQueue = Boolean(
      options.enqueue &&
      (streamingBehavior === "steer" || streamingBehavior === "followUp"),
    );

    // 首次发送的运行时启动可能包含 spawn/get_state/会话绑定；先发布用户可见状态，
    // 让输入反馈与后台准备解耦，避免用户把冷启动时间误判成点击无效。
    // 队列和 /compact 保留原路径，因为它们分别需要排队快照或运行时命令语义。
    const publishOptimisticSubmission = (targetSessionId: string) => {
      setSendState({
        sessionId: targetSessionId,
        state: { status: "activating", requestId },
      });
      clearSnapshot(targetSessionId);
      const cacheEntry = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
      const previousMessages = cacheEntry?.messages ?? [];
      writeOptimisticCache(targetSessionId, [...previousMessages, {
        id: requestId,
        agentId: "",
        role: "user" as const,
        text: message,
        timestamp: Date.now(),
        images: imageSnapshot,
        // 本地先显示的气泡；权威快照到达后由 reconcileOptimisticUserMessages 配对替换。
        // pending=true 期间旧快照不能把它滑出（见 mergeCanonicalSnapshotWithSlidingOut）。
        meta: { optimistic: true, optimisticRequestId: requestId, optimisticPending: true },
      }]);
      options.resetComposerUi?.();
    };

    const publishBeforeActivation = !usesLocalQueue && !isCompactCommand;
    if (publishBeforeActivation) publishOptimisticSubmission(sourceSessionId);

    let sessionId = sourceSessionId;
    // accepted/unknown 只代表主进程已受理或无法判断，不代表权威 user 行已经
    // 到达 renderer。此时清掉 pending 会让随后一条旧增量/全量快照把本地气泡
    // 截掉或滑出，重新触发 scrollHeight 收缩回弹；只有明确 rejected 才 settle。
    let keepOptimisticPending = false;
    /**
     * 明确失败/不需要 host 确认的路径清掉本地气泡的 pending 标记。
     * accepted/unknown 不调用：旧快照可能只是上一轮终态，清掉后会把尚未
     * 被权威消息确认的气泡滑出，重新触发底部回弹。
     */
    const settleOptimisticBubbles = () => {
      for (const targetSessionId of new Set([sourceSessionId, sessionId])) {
        const current = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
        if (!current) continue;
        const settled = settleOptimisticMessage(current.messages, requestId);
        if (settled.changed) writeOptimisticCache(targetSessionId, settled.messages);
      }
    };
    try {
      sessionId = options.ensureSessionId
        ? await options.ensureSessionId(sourceSessionId)
        : sourceSessionId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // ensure 失败时本地气泡是唯一记录；发布路径已清空草稿，必须还回去。
      if (publishBeforeActivation) {
        restoreRejectedSnapshot(sourceSessionId, message, imageSnapshot);
      }
      discardOptimisticBubble(sourceSessionId, requestId);
      setSendState({
        sessionId: sourceSessionId,
        state: { status: "error", error: errorMessage },
      });
      options.showError?.(errorMessage, 4000);
      sendingSessionIdsRef.current.delete(sourceSessionId);
      return;
    }

    // 旧 Chat 前哨可能把 sourceSessionId 提升为真实 catalog session；本地气泡
    // 是先发布在 source 的，若不迁移，新会话的权威 user 无法与它配对，旧会话
    // 还会残留一条幽灵消息。只迁移本次 request，保留两边的窗口/历史字段。
    if (publishBeforeActivation && sessionId !== sourceSessionId) {
      const sourceCache = store.get(sessionMessagesCacheAtom)?.[sourceSessionId];
      const sourceMessages = sourceCache?.messages ?? [];
      const localMessages = sourceMessages.filter(
        (item) => item.id === requestId && item.meta?.optimistic === true,
      );
      if (localMessages.length > 0) {
        const targetMessages = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? [];
        if (!targetMessages.some((item) => item.id === requestId)) {
          writeOptimisticCache(sessionId, [...targetMessages, ...localMessages]);
        }
        writeOptimisticCache(
          sourceSessionId,
          sourceMessages.filter((item) =>
            !(item.id === requestId && item.meta?.optimistic === true)
          ),
          { allowPendingRemoval: true },
        );
      }
    }

    const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
    const runtimeTarget = runtime?.agentId
      ? {
          sessionId,
          agentId: runtime.agentId,
          runtimeGeneration: runtime.runtimeGeneration,
        }
      : undefined;
    const runtimeAgentId = runtimeTarget?.agentId;
    if (publishBeforeActivation && runtimeAgentId) {
      setSendState({
        sessionId,
        state: { status: "sending", requestId },
      });
      const optimisticMessages = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages;
      // 会话提升可能返回新的 sessionId；只有本地气泡确实在该缓存里时才重写，
      // 避免用空数组覆盖另一个会话已加载的窗口元数据，也避免把复用同一 id 的
      // 权威投影行当成气泡重写并触发一次无意义的 disk revision 递增。
      if (optimisticMessages?.some((item) =>
        item.id === requestId && item.meta?.optimistic === true
      )) {
        writeOptimisticCache(
          sessionId,
          optimisticMessages.map((item) =>
            item.id === requestId && item.meta?.optimistic === true
              ? { ...item, agentId: runtimeAgentId }
              : item,
          ),
        );
      }
    }
    if (isCompactCommand) {
      if (!runtimeAgentId) {
        // No Agent yet — let normal send path start Agent first;
        // pi will handle /compact command once active.
      } else {
        const compactPrompt = trimmedMessage.replace(/^\/compact\s*/, "").trim();
        discardOptimisticBubble(sessionId, requestId);
        clearSnapshot(sessionId);
        options.resetComposerUi?.();
        try {
          await options.compact(runtimeTarget, compactPrompt || undefined);
        } finally {
          // /compact exits before the normal send finally block; release the
          // session guard here so a failed/finished compaction cannot freeze
          // every later submission for this session.
          settleOptimisticBubbles();
          sendingSessionIdsRef.current.delete(sourceSessionId);
        }
        return;
      }
    }

    // Queue shortcut: when the agent is busy, enqueue locally instead of sending through
    // the session API. The queue panel shows the pending item and drain dispatches it
    // through the appropriate flush path based on behavior:
    //   steer    → flushQueuedSteerPrompts (while agent is busy)
    //   followUp → flushNextQueuedPrompt (when agent becomes idle)
    if (options.enqueue && (streamingBehavior === "steer" || streamingBehavior === "followUp")) {
      const { message: expandedMessage, emptyTemplateName } = expandPromptTemplates(
        message,
        options.templates,
      );
      if (!expandedMessage.trim() && emptyTemplateName) {
        // 模板正文为空：拦截排队，提示用户先补正文（否则入队的是空白消息）
        discardOptimisticBubble(sessionId, requestId);
        sendingSessionIdsRef.current.delete(sourceSessionId);
        rejectEmptyTemplate(emptyTemplateName);
        return;
      }
      const enqueued = options.enqueue(sessionId, {
        displayText: message,
        message: expandedMessage,
        images: imageSnapshot,
        agentMode: store.get(sessionComposerModeByIdAtom)[sessionId] ?? "normal",
        behavior: streamingBehavior,
      });
      if (enqueued) {
        // 队列面板是这一轮的展示来源；时间线不再保留一条永远不会收到 host 确认的气泡。
        discardOptimisticBubble(sessionId, requestId);
        clearSnapshot(sessionId);
        options.resetComposerUi?.();
        sendingSessionIdsRef.current.delete(sourceSessionId);
        return;
      }
      // Queue full: fall through to direct send.
    }

    if (!publishBeforeActivation) {
      setSendState({
        sessionId,
        state: {
          status: runtimeAgentId ? "sending" : "activating",
          requestId,
        },
      });
      clearSnapshot(sessionId);

      // /compact 是运行时命令，不是对话消息；冷启动落到正常发送路径时也不能
      // 发布本地 user 气泡，否则 host 不会返回对应权威行，气泡会永久 pending。
      if (!isCompactCommand) {
        const cacheEntry = store.get(sessionMessagesCacheAtom)?.[sessionId];
        const previousMessages = cacheEntry?.messages ?? [];
        writeOptimisticCache(sessionId, [...previousMessages, {
          id: requestId,
          agentId: runtimeAgentId ?? "",
          role: "user" as const,
          text: message,
          timestamp: Date.now(),
          images: imageSnapshot,
          // 本地先显示的气泡；权威快照到达后由 reconcileOptimisticUserMessages 配对替换。
          meta: { optimistic: true, optimisticRequestId: requestId, optimisticPending: true },
        }]);
      }
      options.resetComposerUi?.();
    }

    let preparedMessage = message;
    try {
      preparedMessage = options.prepareMessage
        ? await options.prepareMessage(message)
        : message;
    } catch (error) {
      restoreRejectedSnapshot(sessionId, message, imageSnapshot);
      const errorMessage = error instanceof Error ? error.message : String(error);
      discardOptimisticBubble(sessionId, requestId);
      setSendState({
        sessionId,
        state: { status: "error", requestId, error: errorMessage },
      });
      options.showError?.(errorMessage, 4000);
      sendingSessionIdsRef.current.delete(sourceSessionId);
      return;
    }

    const { message: expandedMessage, description, emptyTemplateName } =
      expandPromptTemplates(
        preparedMessage,
        options.templates,
      );
    if (!expandedMessage.trim() && emptyTemplateName) {
      // 模板正文为空（UI 新建模板只写 frontmatter 未填正文）：拦截发送，
      // 给明确提示而不是把空白消息发到主进程被拒为“消息不能为空”。
      restoreRejectedSnapshot(sessionId, message, imageSnapshot);
      rejectEmptyTemplate(emptyTemplateName);
      discardOptimisticBubble(sessionId, requestId);
      sendingSessionIdsRef.current.delete(sourceSessionId);
      return;
    }
    const submission = buildComposerPromptSubmission(
      expandedMessage,
      store.get(sessionComposerModeByIdAtom)[sessionId] ?? "normal",
    );
    // 主进程的乐观 user 消息使用实际提交正文；本地气泡展示的是用户原始输入。
    // 发送前记录一份可用于内容兜底配对的正文，避免模板/技能展开造成重复气泡。
    const submittedText = submission.message.trim();
    if (submittedText && submittedText !== message.trim()) {
      updateOptimisticMatchText(sessionId, requestId, submittedText);
    }

    try {
      const result = await options.sendPrompt({
        sessionId,
        requestId,
        message: submission.message,
        ...(imageSnapshot ? { images: imageSnapshot } : {}),
        ...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
        ...(description ? { description } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      // 新一轮开始：bump 本会话 tick，timeline 侧非最新轮据此收起（设置②）。
      // sendPrompt resolve = pi 已接受消息，旧轮即将/已经结束，此时收掉最省资源。
      store.set(bumpNewTurnCollapseTickAtom, sessionId);
      if (result.agentId) {
        bindRuntime({
          sessionId,
          agentId: result.agentId,
          runtimeGeneration: result.runtimeGeneration,
          status: result.accepted ? "running" : undefined,
        });
      }

      const record = store.get(sessionRecordsAtom)[sessionId];
      if (record && result.sessionPath) {
        upsertSession({
          ...record,
          filePath: result.sessionPath,
          status: "active",
          updatedAt: Date.now(),
        });
      }

      const outcome = classifySessionPromptResult(result);
      // toast 文案 = 本地化提示 + 具体原因：translateI18nDescriptor 命中通用 key 时
      // 只返回“消息发送失败。”这类概括，debugDetails（RPC 超时/pi 拒绝原文）必须带出，
      // 否则用户无从知道失败根因；同值去重、截断防 toast 过长。
      let deliveryError = "Prompt was not accepted";
      let toastMessage = deliveryError;
      if ("error" in result) {
        deliveryError = translateI18nDescriptor(result, result.error);
        const details = result.debugDetails && result.debugDetails !== deliveryError
          ? `（${result.debugDetails.length > 140 ? `${result.debugDetails.slice(0, 140)}…` : result.debugDetails}）`
          : "";
        toastMessage = `${deliveryError}${details}`;
      }
      if (outcome === "accepted") {
        keepOptimisticPending = true;
        options.recordPromptHistory?.(sessionId, message);
        setSendState({ sessionId, state: { status: "idle" } });
        if (record) options.refreshProject?.(record.projectId);
      } else if (outcome === "unknown") {
        // unknown 可能已经落库；保留 pending，等到权威 user 行配对或后续
        // rejected 清理，不能用未确认的旧快照替用户“撤回”消息。
        keepOptimisticPending = true;
        setSendState({
          sessionId,
          state: {
            status: "unknown",
            requestId,
            error: deliveryError,
            unknownSnapshot: {
              message,
              ...(imageSnapshot ? { images: imageSnapshot } : {}),
            },
          },
        });
        options.showUnknown?.();
      } else {
        restoreRejectedSnapshot(sessionId, message, imageSnapshot);
        setSendState({
          sessionId,
          state: { status: "error", requestId, error: deliveryError },
        });
        options.showError?.(toastMessage, 4000);
      }
    } catch (error) {
      // 抛异常同样属于投递结果未知：保留本地气泡，避免旧快照把它滑出。
      keepOptimisticPending = true;
      setSendState({
        sessionId,
        state: {
          status: "unknown",
          requestId,
          error: error instanceof Error ? error.message : String(error),
          unknownSnapshot: {
            message,
            ...(imageSnapshot ? { images: imageSnapshot } : {}),
          },
        },
      });
      options.showUnknown?.();
    } finally {
      if (!keepOptimisticPending) settleOptimisticBubbles();
      sendingSessionIdsRef.current.delete(sourceSessionId);
    }
  };
}
