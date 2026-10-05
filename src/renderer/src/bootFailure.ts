import { t } from "./i18n";
import { getNativeRendererToken, reloadDesktopRenderer } from "./native/initializeNativeDesktop";

const MAX_DETAIL_LENGTH = 240;

/** 原生运行时只有在持有 token 时才能由页面自行重试；否则只能由宿主的 F5 重新认证加载。 */
function canRetryFromPage(): boolean {
	const isNative = new URLSearchParams(window.location.search).get("runtime") === "native";
	return !isNative || getNativeRendererToken() !== null;
}

function describeFailure(error: unknown): string {
	// 按形状收窄而不是 instanceof：跨 realm（iframe / WebView 导航后）的 Error 会让 instanceof 失效。
	const message =
		typeof error === "string"
			? error
			: typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
				? error.message
				: "";
	return message.slice(0, MAX_DETAIL_LENGTH);
}

/**
 * 启动握手失败时，把启动遮罩转成可见的错误状态并提供重试。
 * 没有它，bootstrap 抛错后遮罩永远显示“正在启动工作台”，用户无从判断发生了什么。
 * 这里在 React 挂载之前运行，所以直接操作遮罩 DOM，文案仍走 i18n。
 */
export function showBootFailure(error: unknown): void {
	const overlay = document.getElementById("boot-overlay");
	if (!overlay || overlay.dataset.failed === "true") return;
	overlay.dataset.failed = "true";

	const subtitle = overlay.querySelector<HTMLElement>(".boot-subtitle");
	if (subtitle) subtitle.textContent = t("app.bootFailedTitle");

	const brand = overlay.querySelector<HTMLElement>(".boot-brand");
	if (!brand) return;

	const detail = describeFailure(error);
	if (detail) {
		const detailElement = document.createElement("span");
		detailElement.className = "boot-detail";
		detailElement.textContent = detail;
		brand.appendChild(detailElement);
	}

	if (canRetryFromPage()) {
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "boot-retry";
		retry.textContent = t("app.bootFailedRetry");
		retry.addEventListener("click", () => reloadDesktopRenderer());
		brand.appendChild(retry);
	} else {
		const hint = document.createElement("span");
		hint.className = "boot-detail";
		hint.textContent = t("app.bootFailedPressRefresh");
		brand.appendChild(hint);
	}
}
