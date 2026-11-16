import type React from "react";
import { createContext } from "react";
import { FileText } from "lucide-react";
import {
	isLocalPathRef,
} from "./MarkdownLinkCore";
import { filePathToUri, isAbsoluteFilePath, resolveLocalFileTarget } from "../../utils/fileLinks";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
import { showNotice } from "../../utils/notice";
import { t } from "../../i18n";
export {
	isLocalPathRef,
	markdownUrlTransform,
	remarkLinkifyPaths,
} from "./MarkdownLinkCore";

/** Linked images inherit their anchor's target and keyboard interaction. */
export const MarkdownLinkContext = createContext(false);

/**
 * 链接渲染：file:// 前缀为 remarkLinkifyPaths 生成的文件路径链接，其余为普通外链。
 * 无协议 href（[text](path) 形式）识别为本地路径引用，点击走 onOpenFile。
 */
export function MarkdownLink(
	props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		onOpenExternal: (url: string, forceSystem?: boolean) => void;
		onOpenFile?: (path: string) => void;
		basePath?: string;
		"data-local-path"?: string;
		dataLocalPath?: string;
	},
) {
	const { onOpenExternal, onOpenFile, basePath, children, className, title, "data-local-path": dataLocalPathDash, dataLocalPath, ...anchorProps } = props;
	const rawLocalPath = dataLocalPathDash ?? dataLocalPath;
	const originalLocalPath = rawLocalPath && isLocalPathRef(rawLocalPath) ? rawLocalPath : undefined;
	// remarkLinkifyPaths 生成的文件路径链接走 file:// 协议或携带 data-local-path，与普通外链区分展示；
	// 无协议 href（[text](path) 形式）也是本地路径引用，同样走 onOpenFile
	const isFileLink = /^file:/i.test(props.href ?? "");
	const isLocalRef = Boolean(originalLocalPath) || (!isFileLink && isLocalPathRef(props.href ?? ""));
	const detectedPlatform = typeof navigator !== "undefined" ? detectRendererPlatform(navigator.userAgent) : "win32";
	const platform = detectedPlatform === "linux" || detectedPlatform === "darwin" ? detectedPlatform : "win32";
	const localTarget = isFileLink || isLocalRef
		? resolveLocalFileTarget(originalLocalPath ?? props.href ?? "", basePath, platform)
		: null;

	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (!props.href && !originalLocalPath) return;

		// Use the same normalized disk target for raw paths and file URLs. Raw
		// percent signs stay literal; only the file URL branch decodes them.
		if (localTarget) {
			if (localTarget.ok) {
				if (onOpenFile) void onOpenFile(localTarget.path);
			} else {
				showNotice(t("app.fileLinkFormatInvalid"), 3000, "error");
			}
		} else if (props.href) {
			// 普通 URL 链接统一交给受控的 system-browser API；保留修饰键参数
			// 以兼容现有调用者，但不再改变打开目的地。
			void onOpenExternal(props.href, e.ctrlKey || e.metaKey || undefined);
		}
	};
	const linkClass =
		[className, isFileLink || isLocalRef ? "markdown-link-file" : undefined]
			.filter(Boolean)
			.join(" ") || undefined;

	const hoverTitle = (() => {
		if (localTarget) return localTarget.ok ? localTarget.path : props.href;
		return title;
	})();

	return (
		<a
			{...anchorProps}
			href={localTarget?.ok && isAbsoluteFilePath(localTarget.path) ? filePathToUri(localTarget.path, platform) : props.href}
			className={linkClass}
			onClick={handleClick}
			title={hoverTitle}
		>
			<MarkdownLinkContext.Provider value={true}>
			{isFileLink || originalLocalPath ? (
				<>
					<FileText size={12} className="markdown-link-file-icon" />
					<span>{children}</span>
				</>
			) : (
				children
			)}
			</MarkdownLinkContext.Provider>
		</a>
	);
}
