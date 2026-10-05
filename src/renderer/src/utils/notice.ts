/**
 * 全局通知（#115 U5 收尾）：统一走 sonner（shadcn 官方 toast）。
 * 保留 showNotice(message, duration, kind) 旧 API，调用点零改动；
 * kind 映射 sonner 的 error/warning/info 变体。
 *
 * Toaster 未挂载（App 尚未启动 / 渲染树崩溃）时回退到 DOM toast，
 * 保证全局错误处理仍能给用户可见反馈。
 */

import { toast, type Action as SonnerAction, type ExternalToast } from "sonner";
import { t } from "../i18n";

type NoticeData = {
	message: string;
	duration: number;
	kind?: "info" | "error" | "warning";
};

/** toast 上的可点击按钮（对应 sonner 的 action/cancel）。 */
export type NoticeAction = {
	label: string;
	onClick?: () => void;
};

/** 提示的可选操作按钮：action 为主按钮、cancel 为次按钮（对应 sonner 语义）。 */
export type NoticeActions = {
	action?: NoticeAction;
	cancel?: NoticeAction;
};

let fallbackHost: HTMLDivElement | null = null;
let nextFallbackNoticeId = 0;
export type NoticeId = string | number;

// sonner 2.x 在没有可见 toast 时不会渲染任何 DOM（源码里 `if (!filteredToasts.length) return null`），
// 因此不能用 DOM 查询该属性来探测挂载态——那会在每次首个 toast 前都误判为未挂载，
// 导致所有通知永远走黑色 DOM 兜底。挂载状态改由 Toaster 组件挂载时显式回报。
let toasterReady = false;

export function setToasterReady(ready: boolean) {
	toasterReady = ready;
}

function ensureFallbackHost() {
	if (fallbackHost && document.body.contains(fallbackHost)) return fallbackHost;
	const host = document.createElement("div");
	host.id = "app-notice-fallback-host";
	host.setAttribute("aria-live", "polite");
	// 与 sonner 的 top-right 位置保持一致，并让开标题栏拖拽区，避免兑底与正式 toast 位置跳动
	host.style.cssText = [
		"position:fixed",
		"top:calc(var(--window-drag-height, 0px) + 12px)",
		"right:16px",
		"z-index:2147483000",
		"display:flex",
		"flex-direction:column",
		"align-items:flex-end",
		"gap:8px",
		"pointer-events:none",
		"max-width:min(520px, calc(100vw - 32px))",
		"-webkit-app-region:no-drag"
	].join(";");
	document.body.appendChild(host);
	fallbackHost = host;
	return host;
}

/** 关闭兜底通知并回收宿主节点；持久 Ask 通知只能通过这个按钮结束。 */
function dismissFallbackNotice(item: HTMLDivElement, host: HTMLDivElement) {
	item.remove();
	if (host.childElementCount === 0) {
		host.remove();
		if (fallbackHost === host) fallbackHost = null;
	}
}

/** Toaster 未挂载时的 DOM 兜底 toast，避免全局异常完全静默。 */
function showFallbackNotice(message: string, duration: number, kind: NoticeData["kind"] = "info", title?: string, actions?: NoticeActions): NoticeId | undefined {
	if (typeof document === "undefined") return;
	const noticeId = `fallback-notice-${++nextFallbackNoticeId}`;
	const host = ensureFallbackHost();
	const item = document.createElement("div");
	// 与 sonner 卡片同一套中性面板样式（走 CSS 变量，主题自动适配）；
	// kind 只保留可访问性语义，不叠加高饱和色竖条，避免 fallback 与正式 toast 视觉分裂。
	item.style.cssText = [
		"position:relative",
		"pointer-events:auto",
		"padding:12px 40px 12px 14px",
		"border-radius:10px",
		"background:var(--color-bg-panel, #ffffff)",
		"color:var(--color-text-primary, #1f2328)",
		"border:1px solid var(--color-border-subtle, rgba(0,0,0,0.08))",
		"box-shadow:var(--shadow-popover, 0 4px 12px rgba(0,0,0,0.12))",
		"font:500 13px/1.4 var(--font-family-base, system-ui,-apple-system,Segoe UI,sans-serif)",
		"word-break:break-word",
	].join(";");
	item.setAttribute("role", kind === "error" ? "alert" : "status");
	item.dataset.noticeId = noticeId;
	if (title) {
		// 有标题时：加粗标题行、正文另起一段，与 sonner 的 title+description 结构对齐
		const titleEl = document.createElement("div");
		titleEl.style.cssText = "font-weight:600;margin-bottom:4px;color:var(--color-text-primary, #1f2328)";
		titleEl.textContent = title;
		item.appendChild(titleEl);
	}
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.setAttribute("aria-label", t("common.close"));
	close.title = t("common.close");
	close.style.cssText = [
		"position:absolute",
		"top:8px",
		"right:8px",
		"width:24px",
		"height:24px",
		"border:0",
		"border-radius:6px",
		"background:transparent",
		"color:var(--color-text-tertiary,#8b8f94)",
		"font:600 18px/1 system-ui,sans-serif",
		"cursor:pointer",
	].join(";");
	close.addEventListener("click", () => dismissFallbackNotice(item, host));
	item.appendChild(document.createTextNode(message));
	if (actions) {
		// 按钮区：次按钮（cancel）在左、主按钮（action）在右，点击后先执行回调再收起 toast
		const buttons = document.createElement("div");
		buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:10px";
		for (const key of ["cancel", "action"] as const) {
			const action = actions[key];
			if (!action) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = action.label;
			button.style.cssText = key === "action"
				? "border:0;border-radius:6px;padding:4px 12px;font:600 12px/1.4 system-ui,sans-serif;background:var(--color-accent,#3b82f6);color:#fff;cursor:pointer"
				: "border:1px solid var(--color-border-subtle,rgba(0,0,0,0.12));border-radius:6px;padding:4px 12px;font:500 12px/1.4 system-ui,sans-serif;background:transparent;color:var(--color-text-secondary,#57606a);cursor:pointer";
			button.addEventListener("click", () => {
				action.onClick?.();
				dismissFallbackNotice(item, host);
			});
			buttons.appendChild(button);
		}
		item.appendChild(buttons);
	}
	item.appendChild(close);
	host.appendChild(item);
	if (Number.isFinite(duration)) {
		window.setTimeout(() => dismissFallbackNotice(item, host), Math.max(1200, duration));
	}
	return noticeId;
}

/** 将项目的可选 onClick 语义转换为 sonner 需要的必填 Action（未提供回调时传空函数）。 */
function toSonnerAction(action: NoticeAction): SonnerAction {
	return { label: action.label, onClick: () => action.onClick?.() };
}

/**
 * sonner 的 toast() 在 Toaster 未挂载（启动早期/渲染树崩溃）时静默丢弃，
 * 此时走 DOM 兜底，保证全局异常仍能给用户可见反馈。
 */
function toasterMounted() {
	return toasterReady;
}

export function showNotice(message: string, duration?: number, kind?: NoticeData["kind"], title?: string, actions?: NoticeActions): NoticeId | undefined {
	const resolvedDuration = duration ?? (kind === "error" || kind === "warning" ? 3000 : 1500);
	const text = String(message ?? "").trim();
	if (!text) return;
	if (!toasterMounted()) {
		return showFallbackNotice(text, resolvedDuration, kind, title, actions);
	}
	// 带标题/操作按钮的提示：sonner 以 title 为主文案、正文放 description，视觉层级更清晰
	const options: ExternalToast = {
		duration: resolvedDuration,
		description: text,
	};
	if (actions?.action) options.action = toSonnerAction(actions.action);
	if (actions?.cancel) options.cancel = toSonnerAction(actions.cancel);
	if (title) {
		if (kind === "error") return toast.error(title, options);
		if (kind === "warning") return toast.warning(title, options);
		if (kind === "info") return toast.info(title, options);
		return toast(title, options);
	}
	// 无标题：保持历史行为，整段作为主文案
	const plainOptions: ExternalToast = {
		duration: resolvedDuration,
	};
	if (actions?.action) plainOptions.action = toSonnerAction(actions.action);
	if (actions?.cancel) plainOptions.cancel = toSonnerAction(actions.cancel);
	if (kind === "error") return toast.error(text, plainOptions);
	if (kind === "warning") return toast.warning(text, plainOptions);
	if (kind === "info") return toast.info(text, plainOptions);
	return toast(text, plainOptions);
}

/**
 * 精准关闭由 showNotice 返回的通知，不影响其他全局 toast。
 * 按通知实际所在的位置关闭，而不是按“当前 Toaster 是否已挂载”：
 * 挂载前弹出的兜底通知在挂载后关闭时仍在兜底容器里，交给 sonner 只会是空操作，
 * 不自动消失的通知就会永久残留。
 */
export function dismissNotice(id: NoticeId | undefined) {
	if (id === undefined) return;
	const item = fallbackHost?.querySelector<HTMLDivElement>(`[data-notice-id="${CSS.escape(String(id))}"]`);
	if (item && fallbackHost) {
		dismissFallbackNotice(item, fallbackHost);
		return;
	}
	if (toasterMounted()) toast.dismiss(id);
}
