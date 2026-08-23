import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { BrowserPanel } from "../app/BrowserPanel";
import { ElectronWebviewHost } from "../../browser/electron/ElectronWebviewHost";

export type BrowserSurfaceProps = {
  fullscreen: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onEnterFullscreen: () => void;
  className?: string;
  children?: ReactNode;
};

/** Provides one BrowserPanel owner while moving it between drawer and fullscreen compositor. */
export function BrowserSurface(props: BrowserSurfaceProps) {
  if (props.fullscreen) {
    // portal 到 body：modal-backdrop 是 absolute 定位，留在抽屉 Panel 内会被
    // 面板的定位上下文限制成“只在侧边栏全屏”；挂到 body 后覆盖整个主界面。
    return createPortal(
      <div className={props.className ?? "modal-backdrop"} onClick={props.onClose}>
        <div className="browser-modal" onClick={(event) => event.stopPropagation()}>
          <BrowserPanel
            isFullscreen
            onClose={props.onClose}
            onMinimize={props.onMinimize}
            hostSurface={ElectronWebviewHost}
          />
          {props.children}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="drawer-content-frame">
      {/* 抽屉模式下关闭改走 Tab 栏活动图标；hideChromeClose 避免与之重复 */}
      <BrowserPanel
        hideChromeClose
        onClose={props.onClose}
        onToggleFullscreen={props.onEnterFullscreen}
        hostSurface={ElectronWebviewHost}
      />
      {props.children}
    </div>
  );
}
