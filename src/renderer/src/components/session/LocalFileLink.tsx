import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { FileText, Folder } from "lucide-react";
import type { FilePathInfo } from "../../../../shared/types/files";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "../ui-shadcn/context-menu";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { writeClipboard } from "../../utils/clipboard";

type LocalFileLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { path: string; labelClassName?: string };

/** Native local links keep navigation inside the authorized filesystem API. */
export function LocalFileLink({ path, children, labelClassName, onClick, onContextMenu, ...anchorProps }: LocalFileLinkProps) {
	// The native bootstrap publishes the same desktop API on window before React
	// mounts. Static exports and browser previews have no local filesystem host.
	const files = typeof window !== "undefined" ? window.piDesktop?.files : undefined;
	const [metadata, setMetadata] = useState<{ path: string; info: FilePathInfo | null } | null>(null);
	useEffect(() => {
		if (!files?.stat) return;
		let active = true;
		void files.stat(path).then((info) => {
			if (active) setMetadata({ path, info });
		}).catch(() => {
			// Probing a stale transcript link is quiet. An explicit click reports
			// the current authorization or filesystem failure to the user.
		});
		return () => { active = false; };
	}, [files, path]);
	const isDirectory = metadata?.path === path && metadata.info?.type === "directory";
	const Icon = isDirectory ? Folder : FileText;

	const reveal = async () => {
		if (!files?.showInFolder) return;
		try {
			await files.showInFolder(path);
		} catch (error) {
			showNotice(t("app.revealFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000, "error");
		}
	};
	const activate = async (event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		// Browser and preview surfaces still use their normal file callback when
		// they cannot reveal a path through a native file manager.
		if (files?.showInFolder && (event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey)) {
			await reveal();
			return;
		}
		try {
			// Recheck at activation because agents can create, remove or replace a
			// path after it was rendered. Never infer its kind from the extension.
			const info = files?.stat ? await files.stat(path) : null;
			if (info?.type === "directory") await reveal();
			else onClick?.(event);
		} catch (error) {
			showNotice(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000, "error");
		}
	};
	const anchor = (
		<a
			{...anchorProps}
			data-local-kind={isDirectory ? "directory" : "file"}
			onClick={(event) => { void activate(event); }}
			onAuxClick={(event) => {
				if (event.button !== 1) return;
				void activate(event);
			}}
			onContextMenu={(event) => {
				onContextMenu?.(event);
				// Keep the enclosing timeline card's context menu from taking over.
				event.stopPropagation();
			}}
		>
			<Icon size={12} className="markdown-link-file-icon" />
			<span className={labelClassName}>{children}</span>
		</a>
	);
	if (!files?.showInFolder) return anchor;
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onSelect={() => { void reveal(); }}>
					{t(isDirectory ? "menu.openFolder" : "menu.openLinkInNewWindow")}
				</ContextMenuItem>
				<ContextMenuItem onSelect={() => { void writeClipboard(path); }}>
					{t("menu.copyPath")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
