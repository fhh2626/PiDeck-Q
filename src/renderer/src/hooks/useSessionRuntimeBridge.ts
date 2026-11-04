import { useEffect, useRef } from "react";
import { useStore } from "jotai";
import { ipcChannels } from "../../../shared/ipc";
import type { AgentRuntimeState } from "../../../shared/types";
import {
  applySessionRuntimeEventAtom,
  applySubagentLiveSnapshotAtom,
  clearSubagentLiveRunsAtom,
  replaceSessionRuntimesAtom,
  removeSessionComposerStateAtom,
  sessionRecordsAtom,
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

    // 子代理快照最后一帧（按 agent）+ 已 detach 待回放的 agent 集合。
    // 会话替换（克隆/切换）会发 detach 清掉投影，但同一个 pi 进程还活着、子代理还在跑；
    // detach 之后该 agent 再来任何事件，就回放最后一帧，避免黄点要等下一次工具更新帧才回来。
    // 只在 detach 之后回放：替换开始时 binding 已解绑，detach 帧之前可能先到 state/message 事件，
    // 那些事件不能提前消耗缓存帧。空快照（回合结束/进程停止）会删掉对应条目；卸载即丢。
    const lastSubagentSnapshotByAgent = new Map<string, unknown[]>();
    const detachedSubagentAgents = new Set<string>();

    const offRuntimeEvents = desktopApi.sessions.onRuntimeEvent((event) => {
      // 子代理运行态是独立投影：pi 内建子代理没有 PiDeck runtime，进不了
      // sessionRuntimeByIdAtom（进了会改坏父会话 runtime），只能写到子代理专用 atom。
      // 放在 hook 边界与 agents:notice 同层：跨域清理不引 atom 模块循环。
      if (event.sourceChannel === ipcChannels.agentsSubagentStatus) {
        // 与 applySessionRuntimeEventAtom 同一套代际门禁：旧 runtime 的迟到帧不能写进新代的投影，
        // 否则 detach 已先到、之后没人再清，会留下无法自愈的状态点。
        const runtime = store.get(sessionRuntimeByIdAtom)[event.sessionId];
        if (runtime && runtime.runtimeGeneration > event.runtimeGeneration) return;
        if (
          runtime &&
          runtime.runtimeGeneration === event.runtimeGeneration &&
          runtime.agentId &&
          runtime.agentId !== event.agentId
        ) {
          return;
        }
        const payload = event.payload && typeof event.payload === "object"
          ? event.payload as { runs?: unknown }
          : undefined;
        const runs = Array.isArray(payload?.runs) ? payload.runs : [];
        // 空快照是清理信号（回合结束/进程停止），删掉缓存帧；非空帧留作替换回放。
        if (runs.length === 0) lastSubagentSnapshotByAgent.delete(event.agentId);
        else lastSubagentSnapshotByAgent.set(event.agentId, runs);
        store.set(applySubagentLiveSnapshotAtom, {
          agentId: event.agentId,
          runs,
        });
        return;
      }
      // detach 清掉该 agent 的投影（按 agentId 存储，旧代 detach 不会误伤替换后的新 agent），
      // 并标记待回放：会话替换后同一个 pi 进程还活着，下一条事件到达时回放缓存帧。
      if (event.kind === "detach") {
        store.set(clearSubagentLiveRunsAtom, event.agentId);
        if (lastSubagentSnapshotByAgent.has(event.agentId)) detachedSubagentAgents.add(event.agentId);
      } else if (detachedSubagentAgents.delete(event.agentId)) {
        const snapshot = lastSubagentSnapshotByAgent.get(event.agentId);
        lastSubagentSnapshotByAgent.delete(event.agentId);
        if (snapshot && snapshot.length > 0) {
          store.set(applySubagentLiveSnapshotAtom, { agentId: event.agentId, runs: snapshot });
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
      const wasAnonymous = event.kind === "detach" && store.get(sessionRecordsAtom)[event.sessionId]?.noSession === true;
      store.set(applySessionRuntimeEventAtom, event);
      const currentRuntime = store.get(sessionRuntimeByIdAtom)[event.sessionId];
      // Backend canonical events carry one AgentTab, not an inventory array.
      // Only an accepted reducer transition can reclaim an agent: stale closed/detach
      // events must never remove the replacement's subscriptions.
      if (previousRuntime !== currentRuntime) {
        if (previousRuntime?.agentId && previousRuntime.agentId !== currentRuntime?.agentId) {
          store.set(agentExitedAtom, previousRuntime.agentId);
        }
        if (currentRuntime?.agentId === event.agentId && currentRuntime.status === "closed") {
          store.set(agentExitedAtom, event.agentId);
        }
      }
      // Clean composer only after the canonical reducer accepted detach and removed the
      // transient record. A stale generation must never wipe the replacement's draft.
      // This boundary owns the cross-domain cleanup without introducing atom-module cycles.
      if (event.kind === "detach" && wasAnonymous && !store.get(sessionRecordsAtom)[event.sessionId]) {
        store.set(removeSessionComposerStateAtom, event.sessionId);
      }
      if (event.sourceChannel !== "agents:runtime-state") return;
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
