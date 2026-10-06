/**
 * web-main — PiDeck Web 服务 React 入口（A2）。
 * 独立于主窗口 renderer；通过 /api/* 与主进程 WebServiceManager 通信。
 *
 * 重构后与桌面端共享同一套样式基座（styles.css → foundation/timeline/surfaces/
 * tailwind token），并按 prefers-color-scheme 设置 data-theme 启用暗色模式。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./web/web.css";
import { setI18nLocale } from "./i18n";
import { resolveLocale } from "./i18n";
import { TooltipProvider } from "./components/ui-shadcn/tooltip";
import { WebChatApp } from "./web/WebChatApp";
import { startInputLatencyMonitor } from "./inputLatencyMonitor";

// 与桌面端一致的 locale 解析：优先浏览器语言，中文走 zh-CN
setI18nLocale(resolveLocale("system"));
document.documentElement.lang = resolveLocale("system") === "zh-CN" ? "zh-CN" : "en-US";

// 暗色模式：跟随系统 prefers-color-scheme，映射到 foundation.css 的 data-theme
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
	document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light";
}
applyTheme();
darkMedia.addEventListener("change", applyTheme);

// 输入延迟诊断：Web 端没有日志通道，慢输入汇总写到浏览器控制台（不含输入内容）。
startInputLatencyMonitor({
  report: (report) => console.warn("[PiDeck] Slow input detected", report),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <WebChatApp />
    </TooltipProvider>
  </StrictMode>,
);
