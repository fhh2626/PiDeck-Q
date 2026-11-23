import { useEffect, useRef } from "react";
import type { createStore } from "jotai";
import { sessionRuntimeByIdAtom, type SessionRuntimeViewState } from "../atoms";

type PendingSettlement = {
  agentId: string | undefined;
  runtimeGeneration: number;
  observedRunning: boolean;
};

/** An accepted prompt must observe its run before idle can release the next queued task. */
export function useQueuedPromptSettlement(
  store: ReturnType<typeof createStore>,
  onSettled: (sessionId: string) => void,
) {
  const pendingRef = useRef(new Map<string, PendingSettlement>());
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useEffect(() => {
    const unsubscribe = store.sub(sessionRuntimeByIdAtom, () => {
      const runtimes = store.get(sessionRuntimeByIdAtom);
      for (const [sessionId, pending] of pendingRef.current) {
        const runtime = runtimes[sessionId];
        if (!runtime?.agentId || runtime.agentId !== pending.agentId
          || runtime.runtimeGeneration !== pending.runtimeGeneration) {
          // A stopped/replaced process cannot settle the old request. Its queue belongs
          // to the session and may resume when a new runtime is explicitly activated.
          pendingRef.current.delete(sessionId);
        } else if (runtimeIsRunning(runtime)) {
          pending.observedRunning = true;
        } else if (pending.observedRunning && runtime.status === "idle") {
          pendingRef.current.delete(sessionId);
          settledRef.current(sessionId);
        }
      }
    });
    return () => {
      unsubscribe();
      pendingRef.current.clear();
    };
  }, [store]);

  return {
    begin(sessionId: string) {
      const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
      if (!runtime) return;
      pendingRef.current.set(sessionId, {
        agentId: runtime.agentId,
        runtimeGeneration: runtime.runtimeGeneration,
        observedRunning: runtimeIsRunning(runtime),
      });
    },
    cancel: (sessionId: string) => pendingRef.current.delete(sessionId),
    isWaiting: (sessionId: string) => pendingRef.current.has(sessionId),
  };
}

/** Runtime status is authoritative, including when older streaming flags remain cached. */
function runtimeIsRunning(runtime: SessionRuntimeViewState): boolean {
  return runtime.status === "running" || runtime.status === "starting";
}
