import { useEffect, useState } from "react";
import { Pin, Minus, Square, X } from "lucide-react";
import type { WindowResizeEdge } from "../../../shared/desktop/NativeHostTypes";
import { t } from "../i18n";

type Props = {
  useNativeTitleBar: boolean;
  /** macOS native runtime uses system traffic lights and native resizing. */
  platform: NodeJS.Platform;
  toggleAlwaysOnTop: () => Promise<boolean>;
  minimizeWindow: () => void;
  /** 切换最大化并返回切换后是否最大化 */
  toggleMaximizeWindow: () => Promise<boolean>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  closeWindow: () => void;
  beginWindowDrag: () => void;
  beginWindowResize: (edge: WindowResizeEdge) => void;
  enableNativeResize: boolean;
};

const RESIZE_HANDLES: ReadonlyArray<{
  edge: WindowResizeEdge;
  className: string;
}> = [
  { edge: "top", className: "fixed inset-x-2 top-0 h-1.5 cursor-n-resize" },
  { edge: "bottom", className: "fixed inset-x-2 bottom-0 h-1.5 cursor-s-resize" },
  { edge: "left", className: "fixed inset-y-2 left-0 w-1.5 cursor-w-resize" },
  { edge: "right", className: "fixed inset-y-2 right-0 w-1.5 cursor-e-resize" },
  { edge: "top-left", className: "fixed left-0 top-0 h-2 w-2 cursor-nw-resize" },
  { edge: "top-right", className: "fixed right-0 top-0 h-2 w-2 cursor-ne-resize" },
  { edge: "bottom-left", className: "fixed bottom-0 left-0 h-2 w-2 cursor-sw-resize" },
  { edge: "bottom-right", className: "fixed bottom-0 right-0 h-2 w-2 cursor-se-resize" },
];

/** Custom titlebar restore icon: overlapping windows while maximized. */
function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="none">
      <rect x="3.25" y="1.75" width="6.5" height="6.5" stroke="currentColor" strokeWidth="1.35" />
      <rect x="1.75" y="3.75" width="6.5" height="6.5" stroke="currentColor" strokeWidth="1.35" fill="var(--color-bg-sidebar, #fff)" />
    </svg>
  );
}

export function AppHeader({
  useNativeTitleBar,
  platform,
  toggleAlwaysOnTop,
  minimizeWindow,
  toggleMaximizeWindow,
  isWindowMaximized,
  onWindowMaximizedChange,
  closeWindow,
  beginWindowDrag,
  beginWindowResize,
  enableNativeResize,
}: Props) {
  const [windowAlwaysOnTop, setWindowAlwaysOnTop] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (useNativeTitleBar) return;
    let alive = true;
    void isWindowMaximized().then((value) => {
      if (alive) setMaximized(value);
    });
    const unsubscribe = onWindowMaximizedChange((value) => {
      if (alive) setMaximized(value);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [useNativeTitleBar, isWindowMaximized, onWindowMaximizedChange]);

  if (useNativeTitleBar) return null;

  // macOS native runtime never reaches this branch; keep the guard for the
  // Electron hidden-inset host so it cannot render duplicate traffic lights.
  const showCustomWindowControls = platform !== "darwin";

  return (
    <>
      {enableNativeResize && !maximized ? RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.edge}
          aria-hidden="true"
          className={`${handle.className} z-[1000]`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            beginWindowResize(handle.edge);
          }}
        />
      )) : null}
      <div
        className="window-drag-layer"
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          beginWindowDrag();
        }}
        onDoubleClick={() => { void toggleMaximizeWindow(); }}
      />
      {showCustomWindowControls ? (
        <div className="window-controls" aria-label={t("app.windowControls")}>
          <button
            type="button"
            className={`window-control pin${windowAlwaysOnTop ? " active" : ""}`}
            aria-label={windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")}
            title={windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")}
            onClick={async () => {
              const next = await toggleAlwaysOnTop();
              setWindowAlwaysOnTop(next);
            }}
          >
            <Pin size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button type="button" className="window-control" aria-label={t("app.windowMinimize")} title={t("app.windowMinimize")} onClick={() => minimizeWindow()}>
            <Minus size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? t("app.windowRestore") : t("app.windowMaximize")}
            title={maximized ? t("app.windowRestore") : t("app.windowMaximize")}
            onClick={() => {
              // 只采信主进程返回的意图态；maximize/unmaximize 事件用事件名推送，
              // 不再乐观翻转（否则会与迟到/过期的 isMaximized 读数互踩成「要点两次」）。
              void toggleMaximizeWindow().then((next) => setMaximized(next));
            }}
          >
            {maximized ? <RestoreIcon /> : <Square size={11} strokeWidth={2} aria-hidden="true" />}
          </button>
          <button type="button" className="window-control close" aria-label={t("app.windowClose")} title={t("app.windowClose")} onClick={() => closeWindow()}>
            <X size={13} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </>
  );
}
