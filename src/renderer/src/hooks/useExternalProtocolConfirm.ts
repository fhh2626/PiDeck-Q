import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";

/**
 * 内置浏览器 guest 页面请求打开 mailto/tel/sms 等系统协议的确认流。
 *
 * 主进程 guest 导航/弹窗策略拦截到白名单内请求后，经
 * appConfirmExternalProtocol 推送 { id, url }（URL 权威值在主进程 pending
 * 注册表）；用户应答时本 hook 只回传 id——主进程按自己保存的 targetUrl 执行。
 *
 * 独立于 useOverlayActions：后者是既有 confirm/trust 域（有范围收敛门禁），
 * 浏览器外部协议确认属于 browser feature 域，不并入通用 overlay 状态。
 */
export function useExternalProtocolConfirm(): {
	/** 当前待确认请求（主进程去重：同一 guest 同时至多一条）。 */
	pending: { id: string; url: string } | null;
	confirm: () => void;
	dismiss: () => void;
} {
	const [pending, setPending] = useState<{ id: string; url: string } | null>(null);

	// 主进程已做同 guest 去重 + cancel cooldown，渲染层直接以最新推送为准。
	const acceptRequest = useCallback((next: { id: string; url: string }) => {
		setPending(next);
	}, []);

	useEffect(() => {
		const off = desktopApi.app.onConfirmExternalProtocol?.(acceptRequest);
		return () => off?.();
	}, [acceptRequest]);

	// 副作用不放进 setState updater：StrictMode 开发模式下 updater 会被刻意
	// 双调用（暴露非纯函数），会把应答 IPC 发两次。闭包捕获当前 pending，
	// 应答按钮仅在 pending != null 时可点。
	const respond = useCallback(
		(action: "confirm" | "cancel") => {
			// 只回传 id；主进程按自己保存的 URL 执行打开（TOCTOU：渲染层
			// 无法在确认瞬间替换目标）。无 pending 时静默幂等。
			if (pending) void desktopApi.app.respondExternalProtocol(pending.id, action);
			setPending(null);
		},
		[pending],
	);
	const confirm = useCallback(() => respond("confirm"), [respond]);
	const dismiss = useCallback(() => respond("cancel"), [respond]);

	return { pending, confirm, dismiss };
}
