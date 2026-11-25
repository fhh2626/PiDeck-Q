import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { nativeWindowVisibleAtom } from "../atoms/window-visibility";
import type { PiDesktopApi } from "../../../shared/desktop/createPiDesktopApi";
import { NATIVE_EVENT_SNAPSHOT_INVALIDATED } from "../native/initializeNativeDesktop";

const RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

/** Keep the polling gate in sync with Qt, including after event-channel recovery. */
export function useNativeWindowVisibility(native: boolean, app: PiDesktopApi["app"]) {
  const setVisible = useSetAtom(nativeWindowVisibleAtom);
  useEffect(() => {
    if (!native) {
      setVisible(true);
      return;
    }
    let active = true;
    let known = false;
    let pending = false;
    let dirty = false;
    let failures = 0;
    let retryTimer: number | undefined;
    const stopRetry = () => {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const read = async () => {
      if (!active) return;
      dirty = true;
      if (pending) return;
      pending = true;
      try {
        while (active && dirty) {
          dirty = false;
          try {
            const visible = await app.isWindowVisible();
            if (!active || dirty) continue;
            if (typeof visible !== "boolean") throw new Error("Invalid native window visibility");
            known = true;
            failures = 0;
            setVisible(visible);
          } catch {
            if (!active || dirty) continue;
            // Once Qt has answered, do not stay at a stale hidden/visible state
            // forever after a prolonged outage. Older hosts still get a bounded probe.
            if (known || failures < RETRY_DELAYS_MS.length) {
              const delay = RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)];
              retryTimer = window.setTimeout(() => {
                retryTimer = undefined;
                void read();
              }, delay);
            } else {
              // Older hosts that cannot answer still have browser visibility.
              setVisible(true);
            }
          }
        }
      } finally {
        pending = false;
      }
    };
    const invalidate = () => {
      stopRetry();
      failures = 0;
      void read();
    };
    // A replayed show can be followed by a hide or a gap. Read the current Qt
    // state before allowing any polls to resume, regardless of the frame value.
    const unsubscribe = app.onWindowVisibilityChange(invalidate);
    window.addEventListener(NATIVE_EVENT_SNAPSHOT_INVALIDATED, invalidate);
    window.addEventListener("focus", invalidate);
    invalidate();
    return () => {
      active = false;
      stopRetry();
      unsubscribe();
      window.removeEventListener(NATIVE_EVENT_SNAPSHOT_INVALIDATED, invalidate);
      window.removeEventListener("focus", invalidate);
    };
  }, [native, app, setVisible]);
}
