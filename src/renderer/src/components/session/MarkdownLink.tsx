import type React from "react";
import { FileText } from "lucide-react";
import {
	isLocalPathRef,
	remarkLinkifyPaths,
} from "./MarkdownLinkCore";
import { normalizeLocalFileTarget } from "../../utils/fileLinks";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
import { showNotice } from "../../utils/notice";
import { t } from "../../i18n";
export {
	isLocalPathRef,
	markdownUrlTransform,
	remarkLinkifyPaths,
} from "./MarkdownLinkCore";

/**
 * 链接渲染：file:// 前缀为 remarkLinkifyPaths 生成的文件路径链接，其余为普通外链。
 * 无协议 href（[text](path) 形式）识别为本地路径引用，点击走 onOpenFile。
 */
export function MarkdownLink(
	props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		onOpenExternal: (url: string, forceSystem?: boolean) => void;
		onOpenFile?: (path: string) => void;
		"data-local-path"?: string;
		dataLocalPath?: string;
	},
) {
	const { onOpenExternal, onOpenFile, children, className, title, "data-local-path": dataLocalPathDash, dataLocalPath, ...anchorProps } = props;
	const rawLocalPath = dataLocalPathDash ?? dataLocalPath;
	const originalLocalPath = rawLocalPath && isLocalPathRef(rawLocalPath) ? rawLocalPath : undefined;
	// remarkLinkifyPaths 生成的文件路径链接走 file:// 协议或携带 data-local-path，与普通外链区分展示；
	// 无协议 href（[text](path) 形式）也是本地路径引用，同样走 onOpenFile
	const isFileLink = props.href?.startsWith("file://") ?? false;
	const isLocalRef = Boolean(originalLocalPath) || (!isFileLink && isLocalPathRef(props.href ?? ""));
	const detectedPlatform = typeof navigator !== "undefined" ? detectRendererPlatform(navigator.userAgent) : "win32";
	const platform = detectedPlatform === "linux" || detectedPlatform === "darwin" ? detectedPlatform : "win32";

	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (!props.href && !originalLocalPath) return;

		// 1. 若为自动链接且携带有原始本地路径：直接使用原始路径（保留字面量 %20 与中文、反斜杠等，免受 URL 转义破坏）
		if (originalLocalPath) {
			if (onOpenFile) void onOpenFile(originalLocalPath);
			return;
		}

		// 2. 处理标准 file:// 协议
		if (props.href?.startsWith("file://")) {
			const target = normalizeLocalFileTarget(props.href, platform);
			if (target.ok) {
				if (onOpenFile) void onOpenFile(target.path);
			} else {
				showNotice(t("app.fileLinkFormatInvalid"), 3000, "error");
			}
		} else if (props.href && isLocalPathRef(props.href)) {
			// [text](docs/guide.md) 这类 markdown 手写本地文档链接：按相对 cwd 解析打开
			if (onOpenFile) {
				void onOpenFile(props.href);
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
		if (originalLocalPath) return originalLocalPath;
		if (isFileLink && props.href) {
			const target = normalizeLocalFileTarget(props.href, platform);
			return target.ok ? target.path : props.href;
		}
		return title;
	})();

	return (
		<a
			{...anchorProps}
			className={linkClass}
			onClick={handleClick}
			title={hoverTitle}
		>
			{isFileLink || originalLocalPath ? (
				<>
					<FileText size={12} className="markdown-link-file-icon" />
					<span>{children}</span>
				</>
			) : (
				children
			)}
		</a>
	);
}
