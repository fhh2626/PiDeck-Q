import { useEffect, useRef, useState } from "react";
import type { AvailableModel, SessionRuntimeTarget } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import type { ModelPending } from "../utils/modelPendingDisplay";
import { pendingModelRetryDelay } from "../utils/pendingModelRetry";
import {
  SessionCommandFailure,
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../utils/sessionCommands";

type RuntimeLike = {
  agentId?: string;
  runtimeGeneration?: number;
  status?: string;
  state?: { isStreaming?: boolean };
} | undefined;

/**
 * 生成结束后把「待生效」模型套到仍活着的 Agent。
 * 只写 catalog 不够：applyPreferences 只在启动/重启时跑，同一会话继续聊会仍用旧模型。
 */
export function usePendingModelApply(input: {
  sessionId: string;
  runtime: RuntimeLike;
  modelPending: ModelPending | undefined;
  applyRuntimeModelState: (state: {
    provider?: string;
    modelId?: string;
    modelName?: string;
    thinkingLevel?: string;
  }) => void;
  clearPending: () => void;
  offerRestart: (handle: SessionRuntimeTarget, model: AvailableModel) => void;
}) {
  const applyingRef = useRef(false);
  const retryCountRef = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);
  // 套模型若需重启，只弹一次；取消后也不要跟着 runtime 刷新再弹。
  const blockedRef = useRef(false);
  const callbacksRef = useRef(input);
  callbacksRef.current = input;

  useEffect(() => {
    blockedRef.current = false;
    retryCountRef.current = 0;
  }, [input.modelPending, input.sessionId]);

  const inFlight =
    input.runtime?.status === "running" || Boolean(input.runtime?.state?.isStreaming);
  const agentId = input.runtime?.agentId;
  const runtimeGeneration = input.runtime?.runtimeGeneration;

  useEffect(() => {
    const current = callbacksRef.current;
    if (!current.modelPending || applyingRef.current || blockedRef.current) return;
    if (inFlight) return;
    const handle = toSessionRuntimeTarget(current.sessionId, current.runtime);
    if (!handle) {
      current.clearPending();
      return;
    }
    const pending = current.modelPending;
    applyingRef.current = true;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const result = requireSessionCommand(
          await desktopApi.sessions.setRuntimeModel(
            handle,
            pending.to.provider,
            pending.to.modelId,
          ),
        );
        if (cancelled) return;
        current.applyRuntimeModelState(result.value);
        retryCountRef.current = 0;
        current.clearPending();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof SessionCommandFailure && error.needsRestart) {
          blockedRef.current = true;
          current.offerRestart(handle, {
            provider: pending.to.provider,
            id: pending.to.modelId,
            name: pending.to.modelName,
          });
          return;
        }
        if (
          error instanceof SessionCommandFailure &&
          (error.code === "SESSION_RUNTIME_UNAVAILABLE" || error.code === "SESSION_RUNTIME_CHANGED")
        ) {
          current.clearPending();
          return;
        }
        const retryDelay = pendingModelRetryDelay(retryCountRef.current);
        if (retryDelay === undefined) {
          // 连续瞬时失败后转入已有的重启确认，避免 catalog 与活跃 runtime 永久分裂。
          blockedRef.current = true;
          current.offerRestart(handle, {
            provider: pending.to.provider,
            id: pending.to.modelId,
            name: pending.to.modelName,
          });
          return;
        }
        retryCountRef.current += 1;
        showNotice(error instanceof Error ? error.message : String(error), 4000);
        retryTimer = setTimeout(() => {
          if (!cancelled) setRetryRevision((revision) => revision + 1);
        }, retryDelay);
      } finally {
        if (!cancelled) applyingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      applyingRef.current = false;
    };
  }, [input.modelPending, input.sessionId, inFlight, agentId, runtimeGeneration, retryRevision]);
}
