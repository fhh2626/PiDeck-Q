import { MarkdownStream } from "../session/MarkdownStream";
import { t } from "../../i18n";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import { Progress } from "../ui-shadcn/progress";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { AppUpdateInfo, AppUpdateDownloadProgress } from "../../../../shared/types";
import type { AppUpdateControllerState } from "../../hooks/useAppUpdateController";

export type AppUpdateOverlayProps = {
	controller: Pick<AppUpdateControllerState, "info" | "error" | "checking" | "downloading" | "progress" | "downloadedPath" | "download" | "openPackage" | "clear">;
	releasesUrl: string;
	openExternal: (url: string, forceSystem?: boolean) => Promise<void> | void;
	upToDateVersion?: string | null;
	onDismissUpToDate?: () => void;
};

function formatBytes(bytes?: number) {
	if (!bytes || bytes < 1024) return `${bytes ?? 0} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes;
	let index = -1;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

function UpdateDialog(props: {
	info: AppUpdateInfo;
	progress: AppUpdateDownloadProgress | null;
	checking: boolean;
	downloading: boolean;
	downloadedPath: string | null;
	onClose: () => void;
	onDownload: () => void;
	onOpenPackage: () => void;
	onBrowserDownload: () => void;
	error?: string | null;
	onOpenRelease: () => void;
}) {
	const percent = props.progress?.percent ?? 0;
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "sm:max-w-[min(620px,calc(100vw-36px))] max-h-[min(720px,calc(100vh-48px))]")}
			>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("update.availableTitle", { version: props.info.latestVersion })}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
			<section className="update-modal update-modal--embedded">
				<div className="update-body">
					<p className="update-version-line">{t("update.currentLatest", { current: props.info.currentVersion, latest: props.info.latestVersion })}</p>
					{props.info.recommendedAsset && <p className="update-asset-line">{t("update.recommendedAsset", { name: props.info.recommendedAsset.name })}</p>}
					{props.progress && (
						<div className="update-download-progress">
							<div className="update-progress-header"><span>{props.progress.assetName}</span><span>{percent ? `${percent.toFixed(1)}%` : t("update.downloading")}</span></div>
							<Progress value={percent} aria-label={t("update.downloadProgress")} className="my-2" />
							<div className="update-progress-meta"><span>{formatBytes(props.progress.receivedBytes)} / {formatBytes(props.progress.totalBytes)}</span><span>{props.progress.bytesPerSecond ? `${formatBytes(props.progress.bytesPerSecond)}/s` : ""}</span></div>
							{props.downloadedPath && <div className="update-downloaded-path">{props.downloadedPath}</div>}
						</div>
					)}
					{props.error && <div className="update-error-detail" role="alert">{t("update.errorInfo", { message: props.error })}</div>}
					<div className="update-notes markdown-body">
						<MarkdownStream
							text={props.info.releaseNotes.trim() || t("update.noReleaseNotes")}
							onOpenExternal={() => undefined}
							remarkPlugins={[]}
						/>
					</div>
				</div>
				<div className="update-actions">
					<Button variant="outline" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" onClick={props.onOpenRelease}>{t("update.openRelease")}</Button>
					<Button variant="outline" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" onClick={props.onBrowserDownload}>{t("update.browserDownload")}</Button>
					{props.downloadedPath ? <Button variant="default" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" onClick={props.onOpenPackage}>{t("update.openDownloaded")}</Button> : <Button variant="default" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" disabled={props.checking || props.downloading || !props.info.recommendedAsset} onClick={props.onDownload}>{props.downloading ? t("update.downloading") : t("update.downloadInApp")}</Button>}
				</div>
			</section>
			</DialogContent>
		</Dialog>
	);
}

export function AppUpdateOverlay({ controller, releasesUrl, openExternal, upToDateVersion, onDismissUpToDate }: AppUpdateOverlayProps) {
	const info = controller.info;
	if (info) {
		return <UpdateDialog info={info} progress={controller.progress} checking={controller.checking} downloading={controller.downloading} downloadedPath={controller.downloadedPath} onClose={controller.clear} onDownload={() => void controller.download()} onOpenPackage={() => void controller.openPackage()} error={controller.error} onBrowserDownload={() => void openExternal(info.recommendedAsset?.url ?? info.releaseUrl, true)} onOpenRelease={() => void openExternal(info.releaseUrl, true)} />;
	}
	if (controller.error) {
		return (
			<Dialog open onOpenChange={(next) => !next && controller.clear()}>
				<DialogContent
					showCloseButton={false}
					className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "sm:max-w-[min(620px,calc(100vw-36px))]")}
				>
					<DialogHeader className="flex-row items-center justify-between px-4 py-3">
						<DialogTitle>{t("update.checkFailedTitle")}</DialogTitle>
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</DialogHeader>
				<section className="update-modal update-modal--embedded update-error-modal">
					<div className="update-body"><p className="update-version-line">{t("update.checkFailedDescription")}</p><div className="update-error-detail">{t("update.errorInfo", { message: controller.error })}</div><p className="update-asset-line">{t("update.manualReleaseHint")}<br /><span>{releasesUrl}</span></p></div>
					<div className="update-actions"><Button variant="outline" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" onClick={controller.clear}>{t("common.close")}</Button><Button variant="default" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" onClick={() => void openExternal(releasesUrl, true)}>{t("update.openReleasePage")}</Button></div>
				</section>
				</DialogContent>
			</Dialog>
		);
	}
	if (upToDateVersion) {
		return (
			<Dialog open onOpenChange={(next) => !next && (onDismissUpToDate ?? (() => undefined))()}>
				<DialogContent
					showCloseButton={false}
					className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "sm:max-w-[min(620px,calc(100vw-36px))]")}
				>
					<DialogHeader className="flex-row items-center justify-between px-4 py-3">
						<DialogTitle>{t("update.upToDateTitle")}</DialogTitle>
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</DialogHeader>
				<section className="update-modal update-modal--embedded update-uptodate-modal">
					<div className="update-body"><p className="update-version-line">{t("update.upToDateMessage", { version: upToDateVersion })}</p></div>
					<div className="update-actions"><Button variant="outline" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" onClick={onDismissUpToDate}>{t("common.close")}</Button><Button variant="outline" size="sm" className="h-auto px-3 py-2 text-[13px] shadow-none" onClick={() => void openExternal(releasesUrl, true)}>{t("update.openReleasePage")}</Button></div>
				</section>
				</DialogContent>
			</Dialog>
		);
	}
	return null;
}
