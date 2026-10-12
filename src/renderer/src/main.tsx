import React from "react";
import ReactDOM from "react-dom/client";
import type { AppLogLevel } from "@shared/types";
import { App } from "./App";
import { AppErrorBoundary } from "./components/app/AppErrorBoundary";
import { TooltipProvider } from "./components/ui-shadcn/tooltip";
import { Toaster } from "./components/ui-shadcn/sonner";
import { t } from "./i18n";
import { dismissNotice, showNotice } from "./utils/notice";
import { desktopApi, initializeDesktopRuntime } from "./desktopApi";
import { showBootFailure } from "./bootFailure";
import { startInputLatencyMonitor } from "./inputLatencyMonitor";
import {
  NATIVE_EVENT_CHANNEL_HEALTH_EVENT,
  type NativeEventChannelHealthDetail,
} from "./native/initializeNativeDesktop";
import "./styles.css";

function redactRendererUrl(): string {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    return url.toString();
  } catch {
    return "renderer://unknown";
  }
}

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
    url: redactRendererUrl(),
  });
};

// 全局运行时异常：写日志 + toast，避免静默失败或整页无反馈。
window.addEventListener("error", (event) => {
  // 资源加载失败（script/img）也会进 error 事件，但 event.error 通常为空；
  // 这类错误不适合弹业务 toast，只记日志。
  const isResourceError = event.target instanceof HTMLElement;
  // ResizeObserver loop 是 Chromium 的良性通知，不应以 error 级别污染日志。
  const isBenignResizeObserverLoop = typeof event.message === "string"
    && event.message.includes("ResizeObserver loop");
  writeStartupLog(isBenignResizeObserverLoop ? "debug" : "error", "Renderer uncaught error", {
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

// 原生事件通道持续连不上：页面仍可操作但实时更新已停，要让用户看见。
// 日志由 initializeNativeDesktop 经 RPC 直接写入（启动期 desktopApi 尚未就绪）。
let eventChannelNoticeId: ReturnType<typeof showNotice> | undefined;
window.addEventListener(NATIVE_EVENT_CHANNEL_HEALTH_EVENT, (event) => {
  const detail = (event as CustomEvent<NativeEventChannelHealthDetail>).detail;
  if (!detail) return;
  if (!detail.healthy) {
    // 不自动消失：状态只在翻转时上报一次，提示一旦过期，持续断连就又变回静默。
    // 恢复时由下方显式关闭；用户也可以手动关掉。
    dismissNotice(eventChannelNoticeId);
    eventChannelNoticeId = showNotice(t("app.eventChannelLost"), Number.POSITIVE_INFINITY, "warning");
    return;
  }
  dismissNotice(eventChannelNoticeId);
  eventChannelNoticeId = undefined;
  showNotice(t("app.eventChannelRestored"), 3_000, "info");
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
    url: redactRendererUrl(),
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

  // 输入延迟诊断：键盘/输入法事件到绘制超过 100ms 时按 10 秒窗口汇总写日志（不含输入内容）。
  startInputLatencyMonitor({
    report: (report) => writeStartupLog("warn", "Slow input detected", report),
  });

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
  // 遮罩不会自行消失：显式展示失败原因和重试入口，而不是永远停在“正在启动”。
  showBootFailure(error);
  throw error;
});
