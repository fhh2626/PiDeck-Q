import { useContext, useEffect, useState, type ImgHTMLAttributes } from "react";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
import { getMimeTypeFromExtension } from "../../hooks/useImagePreviewController";
import { isAbsoluteFilePath, resolveLocalFileTarget } from "../../utils/fileLinks";
import { isLocalPathRef } from "./MarkdownLinkCore";
import { MarkdownLinkContext } from "./MarkdownLink";

type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & {
	basePath?: string;
	onOpenFile?: (path: string) => void;
	"data-local-path"?: string;
	dataLocalPath?: string;
	/** Parser metadata is consumed by the Markdown renderer, not a DOM attribute. */
	node?: unknown;
};

/** Load local Markdown images through the authorized file API, never the app HTTP root. */
export function MarkdownImage(props: MarkdownImageProps) {
	const isLinked = useContext(MarkdownLinkContext);
	const { basePath, onOpenFile, "data-local-path": rawPath, dataLocalPath, node: _node, ...imageProps } = props;
	const opensImage = Boolean(onOpenFile) && !isLinked;
	const source = rawPath ?? dataLocalPath ?? (typeof props.src === "string" ? props.src : "");
	const isLocal = Boolean(source) && (isLocalPathRef(source) || /^file:/i.test(source));
	const detected = typeof navigator === "undefined" ? "win32" : detectRendererPlatform(navigator.userAgent);
	const platform = detected === "linux" || detected === "darwin" ? detected : "win32";
	const target = isLocal ? resolveLocalFileTarget(source, basePath, platform) : null;
	const path = target?.ok ? target.path : null;
	const [loaded, setLoaded] = useState<{ path: string; source: string } | null>(null);
	const [failedPath, setFailedPath] = useState<string | null>(null);

	useEffect(() => {
		if (!isLocal || !path || !isAbsoluteFilePath(path)) return;
		let cancelled = false;
		setFailedPath(null);
		void Promise.resolve().then(() => desktopApi.files.readBase64(path, 10 * 1024 * 1024)).then((data) => {
			if (cancelled) return;
			if (!data) {
				setFailedPath(path);
				return;
			}
			const extension = path.split(".").pop() ?? "";
			setLoaded({ path, source: `data:${getMimeTypeFromExtension(extension)};base64,${data}` });
		}).catch(() => {
			if (!cancelled) setFailedPath(path);
		});
		return () => { cancelled = true; };
	}, [isLocal, path]);

	if (!isLocal) return <img {...imageProps} />;
	if (!path || !isAbsoluteFilePath(path) || failedPath === path) {
		return <span role="alert" title={path ?? source} className="text-caption text-text-secondary">{t("app.imageReadFailed")}</span>;
	}
	if (loaded?.path !== path) {
		return <span aria-busy="true" title={path} className="text-caption text-text-secondary">{props.alt ?? ""}</span>;
	}
	return (
		<img
			{...imageProps}
			src={loaded.source}
			title={path}
			role={opensImage ? "button" : imageProps.role}
			tabIndex={opensImage ? 0 : imageProps.tabIndex}
			onError={() => setFailedPath(path)}
			onKeyDown={(event) => {
				if (opensImage && onOpenFile && !event.currentTarget.closest("a") && (event.key === "Enter" || event.key === " ")) {
					event.preventDefault();
					event.stopPropagation();
					onOpenFile(path);
				} else props.onKeyDown?.(event);
			}}
			onClick={(event) => {
				// Custom Markdown anchor renderers may not provide our context. Keep
				// their enclosing link in charge as well, including thumbnail links.
				if (opensImage && onOpenFile && !event.currentTarget.closest("a")) {
					event.preventDefault();
					event.stopPropagation();
					onOpenFile(path);
				} else props.onClick?.(event);
			}}
		/>
	);
}
