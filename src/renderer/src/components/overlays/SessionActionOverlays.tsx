import { lazy, Suspense, type ComponentProps } from "react";
const SettingsModal = lazy(() => import("../app/SettingsModal").then((module) => ({ default: module.SettingsModal })));
import { ConfirmDialog } from "./OverlayParts";
import { TrustConfirmModal } from "../app/TrustConfirmModal";
import { t } from "../../i18n";
export type TrustOverlayProps = {
	open: boolean;
	requestId: string;
	cwd: string;
	projectName: string;
	onChoose: (choice: "trust-remember" | "trust-session" | "deny") => void | Promise<void>;
};

export type SessionActionOverlaysProps = {
	settings?: { open: boolean; props: ComponentProps<typeof SettingsModal> };
	confirm?: { open: boolean; props: ComponentProps<typeof ConfirmDialog> };
	trust?: TrustOverlayProps;
	externalProtocol?: {
		open: boolean;
		url: string;
		onConfirm: () => void;
		onCancel: () => void;
	};
};

export function SessionActionOverlays({ settings, confirm, trust, externalProtocol }: SessionActionOverlaysProps) {
	return <>
		{settings?.open && <Suspense fallback={null}><SettingsModal {...settings.props} /></Suspense>}
		{confirm?.open && <ConfirmDialog {...confirm.props} />}
		{trust?.open && <TrustConfirmModal cwd={trust.cwd} projectName={trust.projectName} onChoose={trust.onChoose} />}
		<ExternalProtocolConfirmOverlay request={externalProtocol} />
	</>;
}

/** guest 页面请求外部协议的确认框：主进程推送 → 用户应答才经网关启动。 */
function ExternalProtocolConfirmOverlay({ request }: { request?: NonNullable<SessionActionOverlaysProps["externalProtocol"]> }) {
	if (!request?.open) return null;
	// 必须完整展示 URI（含 query/bcc 等全部内容）：用户看到什么就确认什么——
	// 截断会隐藏 URI 后半部分（如 bcc=hidden@example.com），破坏确认语义。
	// 超长只靠布局解决：可滚动区域 + 强制换行，不修改字符串内容。
	return (
		<ConfirmDialog
			title={t("browser.externalProtocolTitle")}
			message={t("browser.externalProtocolMessage", { url: request.url })}
			messageClassName="break-all max-h-40 overflow-y-auto whitespace-pre-wrap"
			onConfirm={request.onConfirm}
			onCancel={request.onCancel}
		/>
	);
}
