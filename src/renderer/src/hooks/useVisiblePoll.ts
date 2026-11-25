import { useStore } from "jotai";
import { useEffect, useRef } from "react";
import { nativeWindowVisibleAtom } from "../atoms/window-visibility";

type PollCause = "mount" | "visible" | "interval";

/** Pause hidden work without losing the first load or an upcoming remote fetch deadline. */
export function useVisiblePoll(
  scope: string | undefined,
  intervalMs: number,
  onTick: (cause: PollCause, whenVisible: () => boolean) => void,
  immediate = true,
  refreshOnRestore = true,
) {
  const store = useStore();
  const tickRef = useRef(onTick);
  useEffect(() => { tickRef.current = onTick; }, [onTick]);

  useEffect(() => {
    if (!scope) return;
    const isVisible = () => store.get(nativeWindowVisibleAtom) === true && document.visibilityState !== "hidden";
    let timer: number | undefined;
    let active = true;
    let visible = false;
    let sawHidden = false;
    let visibilityEpoch = 0;
    let firstLoad = immediate;
    let due = performance.now() + intervalMs;
    const stop = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      timer = window.setTimeout(() => {
        timer = undefined;
        if (isVisible()) tick("interval");
      }, Math.max(0, due - performance.now()));
    };
    const tick = (cause: PollCause) => {
      firstLoad = false;
      due = performance.now() + intervalMs;
      schedule();
      const epoch = visibilityEpoch;
      // A queued read belongs to this project scope and this visible period.
      tickRef.current(cause, () => active && epoch === visibilityEpoch && isVisible());
    };
    const syncVisibility = () => {
      const nativeVisible = store.get(nativeWindowVisibleAtom);
      const pageHidden = document.visibilityState === "hidden";
      if (nativeVisible === false || pageHidden) sawHidden = true;
      const next = nativeVisible === true && !pageHidden;
      if (next === visible) return;
      visible = next;
      ++visibilityEpoch;
      if (!visible) {
        stop();
        return;
      }
      // Resolving an unknown native snapshot at boot is not an actual restore.
      const restored = sawHidden;
      sawHidden = false;
      if (firstLoad) tick("mount");
      else if ((restored && refreshOnRestore) || performance.now() >= due) tick("visible");
      else schedule();
    };
    document.addEventListener("visibilitychange", syncVisibility);
    const unsubscribe = store.sub(nativeWindowVisibleAtom, syncVisibility);
    syncVisibility();
    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", syncVisibility);
      stop();
    };
  }, [scope, intervalMs, immediate, refreshOnRestore, store]);
}
