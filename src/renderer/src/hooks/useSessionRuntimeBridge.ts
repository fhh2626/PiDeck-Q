import { useEffect, useRef } from "react";
import { useStore } from "jotai";
import type { AgentRuntimeState } from "../../../shared/types";
import {
  applySessionRuntimeEventAtom,
  replaceSessionRuntimesAtom,
  sessionRuntimeByIdAtom,
} from "../atoms";
import { agentExitedAtom } from "../atoms/runtime-atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";
import { showNotice } from "../utils/notice";

type RuntimeBridgeCallbacks = {
  onRuntimeCapabilityChanged?: (input: {
    sessionId: string;
    agentId: string;
    previous?: AgentRuntimeState;
    current: AgentRuntimeState;
    patch: AgentRuntimeState;
  }) => void;
};

export function useSessionRuntimeBridge(callbacks: RuntimeBridgeCallbacks = {}): void {
  const store = useStore();
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    let disposed = false;
    void desktopApi.sessions.listRuntimes().then((runtimes) => {
      if (!disposed) store.set(replaceSessionRuntimesAtom, runtimes);
    }).catch(() => undefined);

    const offRuntimeEvents = desktopApi.sessions.onRuntimeEvent((event) => {
      // agents:state 是全量 AgentTab[] 推送：对已退出（closed）的 agent 释放
      // agentId 维度 atomFamily 缓存（agentId 每次新 UUID，只增不清是慢泄漏）。
      if (event.sourceChannel === "agents:state" && Array.isArray(event.payload)) {
        for (const tab of event.payload as Array<{ id?: string; status?: string }>) {
          if (typeof tab.id === "string" && tab.status === "closed") {
            store.set(agentExitedAtom, tab.id);
          }
        }
      }
      if (event.sourceChannel === "sessions:message-delivery-status") {
        showNotice(t("session.messageDeliveryTooLarge"), Number.POSITIVE_INFINITY, "error");
        return;
      }
      // 主进程瞬时状态反馈（如 abort 已请求停止）走 toast，不进会话时间线：
      // 系统卡片太抢眼，且插在 assistant 中间会打断 agent-run 分组。
      if (event.sourceChannel === "agents:notice" && event.payload && typeof event.payload === "object") {
        const notice = event.payload as {
          message?: string;
          i18nKey?: string;
          kind?: "info" | "warning" | "error";
          duration?: number;
        };
        const text = notice.i18nKey ? t(notice.i18nKey as TranslationKey) : notice.message;
        if (text) {
          // 异常（error）常驻不自动消失；info/warning 保持主进程指定的短时反馈
          const kind = notice.kind ?? "info";
          showNotice(text, kind === "error" ? Number.POSITIVE_INFINITY : (notice.duration ?? 2500), kind);
        }
        return;
      }
      const previousRuntime = store.get(sessionRuntimeByIdAtom)[event.sessionId];
      store.set(applySessionRuntimeEventAtom, event);
      if (event.sourceChannel !== "agents:runtime-state") return;
      const currentRuntime = store.get(sessionRuntimeByIdAtom)[event.sessionId];
      if (
        currentRuntime?.agentId !== event.agentId ||
        currentRuntime.runtimeGeneration !== event.runtimeGeneration ||
        !currentRuntime.state ||
        !event.payload ||
        typeof event.payload !== "object"
      ) {
        return;
      }
      const patch = (event.payload as { state?: AgentRuntimeState }).state;
      if (!patch) return;
      callbacksRef.current.onRuntimeCapabilityChanged?.({
        sessionId: event.sessionId,
        agentId: event.agentId,
        previous: previousRuntime?.agentId === event.agentId &&
          previousRuntime.runtimeGeneration === event.runtimeGeneration
          ? previousRuntime.state
          : undefined,
        current: currentRuntime.state,
        patch,
      });
    });
    return () => {
      disposed = true;
      offRuntimeEvents();
    };
  }, [store]);
}
