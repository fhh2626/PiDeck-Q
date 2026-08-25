import React from "react";
import ReactDOM from "react-dom/client";
import type { AppLogLevel } from "@shared/types";
import { App } from "./App";
import { AppErrorBoundary } from "./components/app/AppErrorBoundary";
import { TooltipProvider } from "./components/ui-shadcn/tooltip";
import { Toaster } from "./components/ui-shadcn/sonner";
import { t } from "./i18n";
import { showNotice } from "./utils/notice";
import { desktopApi, initializeDesktopRuntime } from "./desktopApi";
import "./styles.css";

function writeStartupLog(level: AppLogLevel, message: string, detail?: unknown) {
  void desktopApi.app.rendererLog(level, "renderer", message, detail).catch(() => undefined);
}

/** 将异常压缩成用户可读的短文案，避免 toast 被超长 stack 淹没。 */
function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// React 将更新深度异常写到 console.error，而不是抛出可带组件信息的 window error。
// 仅捕获该明确错误并限频记录调用栈，便于定位具体 effect；不改写其他 console 行为。
const originalConsoleError = console.error.bind(console);
let lastUpdateDepthDiagnosticAt = 0;
console.error = (...args: unknown[]) => {
  originalConsoleError(...args);
  const message = args.map((arg) => formatRuntimeError(arg)).join(" ");
  if (!message.includes("Maximum update depth exceeded")) return;
  const now = Date.now();
  if (now - lastUpdateDepthDiagnosticAt < 5000) return;
  lastUpdateDepthDiagnosticAt = now;
  writeStartupLog("error", "Renderer React update depth diagnostic", {
    message,
    stack: new Error("React update depth diagnostic").stack,
    url: window.location.href,
  });
};

// 全局运行时异常：写日志 + toast，避免静默失败或整页无反馈。
window.addEventListener("error", (event) => {
  // 资源加载失败（script/img）也会进 error 事件，但 event.error 通常为空；
  // 这类错误不适合弹业务 toast，只记日志。
  const isResourceError = event.target instanceof HTMLElement;
  writeStartupLog("error", "Renderer uncaught error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    isResourceError,
    error: event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error ?? ""),
  });
  if (!isResourceError) {
    const message = formatRuntimeError(event.error ?? event.message);
    // ResizeObserver loop 警告是 Chromium 的良性通知（同一帧内 RO 回调又触发 resize），
    // Streamdown 动画 + resizable panels 组合下常见；只记日志，不弹错误 toast 干扰用户。
    const isBenignResizeObserverLoop = typeof event.message === "string"
      && event.message.includes("ResizeObserver loop");
    if (message && !isBenignResizeObserverLoop) {
      showNotice(`${t("app.runtimeErrorToast")}: ${message}`, 6000, "error");
    }
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  writeStartupLog("error", "Renderer unhandled rejection", {
    reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
  const message = formatRuntimeError(reason);
  if (message) {
    showNotice(`${t("app.unhandledRejectionToast")}: ${message}`, 6000, "error");
  }
});

function dismissBootOverlay() {
  const overlay = document.getElementById("boot-overlay");
  if (!overlay) return;
  if (overlay.dataset.dismissing === "true") return;
  overlay.dataset.dismissing = "true";

  let removed = false;
  const removeOverlay = () => {
    if (removed) return;
    removed = true;
    overlay.remove();
  };

  overlay.classList.add("fade-out");
  // 过渡结束后从 DOM 移除覆盖层，释放层级上下文。
  overlay.addEventListener("transitionend", removeOverlay, { once: true });
  // 兜底：某些环境下 transitionend 可能不触发。
  window.setTimeout(removeOverlay, 700);
}

/**
 * Native runtime must finish its bootstrap handshake before React mounts. Electron,
 * LAN Web and preview runtimes resolve immediately and keep their current behavior.
 */
async function bootstrap() {
  await initializeDesktopRuntime();
  writeStartupLog("info", "Renderer bootstrap started", {
    url: window.location.href,
  });

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    writeStartupLog("error", "Renderer root element missing");
    throw new Error("Renderer root element missing");
  }

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <AppErrorBoundary>
        {/* shadcn Tooltip 必须在 Provider 树内使用（#115 U1） */}
        <TooltipProvider>
          <App />
          {/* 全局 toast 出口（#115）：showNotice 经 sonner 在此渲染 */}
          <Toaster />
        </TooltipProvider>
      </AppErrorBoundary>
    </React.StrictMode>,
  );

  /**
   * React 首次渲染完成后淡出启动遮罩。前台窗口走双 rAF，保证 transition
   * 有独立的布局帧；独立超时不依赖 rAF，因为 Electron 隐藏或后台窗口可将
   * rAF 长时间节流，不能让已挂载的工作台永久被遮挡。
   */
  const isNativeRuntime = new URLSearchParams(window.location.search).get("runtime") === "native";
  if (isNativeRuntime) {
    // Qt WebView can defer requestAnimationFrame/timer callbacks while its
    // native child surface is becoming visible. Do not leave the already
    // mounted React tree behind the boot overlay in that case.
    dismissBootOverlay();
    writeStartupLog("info", "Renderer React tree mounted");
  } else {
    requestAnimationFrame(() => {
      writeStartupLog("info", "Renderer React tree mounted");
      requestAnimationFrame(dismissBootOverlay);
    });
    window.setTimeout(dismissBootOverlay, 1500);
  }
}

void bootstrap().catch((error) => {
  writeStartupLog("error", "Renderer bootstrap failed", error);
  throw error;
});
