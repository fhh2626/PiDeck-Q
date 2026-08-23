import { cn } from "../../lib/utils";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { normalizeSessionPathForCompare } from "../../agentListDisplay";
import { SessionSourceBadge } from "./SessionSourceBadge";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import type { FileTreeNode, Project, SessionSummary } from "../../../../shared/types";
import { Input } from "../ui-shadcn/input";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

// Button 收口状态（P0 UI 统一）：抽屉头部/文件工具行图标按钮已换 shadcn Button（ghost + 原 tailwind class 保留）。
// 保留原生 button（内容排版/折叠区块语义 + 自定义 CSS 驱动，P2 CSS 收口时迁移）：
// session-file-summary-header / -row / -toggle（会话文件摘要）、session-card-inner（会话卡片整卡）、
// session-card-expand-btn（子会话折叠）。

type DiffFileHandler = (path: string, originalContent?: string, content?: string) => void;

type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	originalContent?: string;
	content?: string;
};

const SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX =
	"pid:session-file-summary-collapsed:";
const SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX =
	"pid:session-file-summary-file-list-expanded:";

/** 读取指定 session 的折叠状态(无存储返回默认值) */
function loadCollapsed(sessionKey: string | null): boolean {
	if (!sessionKey || typeof window === "undefined") return true;
	const stored = localStorage.getItem(
		SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX + sessionKey,
	);
	return stored !== null ? stored === "true" : true;
}

function loadFileListExpanded(sessionKey: string | null): boolean {
	if (!sessionKey || typeof window === "undefined") return false;
	const stored = localStorage.getItem(
		SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX + sessionKey,
	);
	return stored !== null ? stored === "true" : false;
}

export function SessionFileSummary(props: {
	files: SessionModifiedFile[];
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
	/** sessionIdOrPath: 会话唯一标识(如 sessionPath),用于按 agent/session 隔离折叠状态。
	 *  组件卸载后再次挂载相同标识时,恢复之前保存的折叠偏好。 */
	sessionIdOrPath?: string;
}) {
	const [collapsed, setCollapsed] = useState(() =>
		loadCollapsed(props.sessionIdOrPath ?? null),
	);
	const [fileListExpanded, setFileListExpanded] = useState(() =>
		loadFileListExpanded(props.sessionIdOrPath ?? null),
	);
	const prevSessionRef = useRef(props.sessionIdOrPath);

	// 当 sessionIdOrPath 变化时重新从 localStorage 读取
	useEffect(() => {
		if (prevSessionRef.current === props.sessionIdOrPath) return;
		prevSessionRef.current = props.sessionIdOrPath;
		setCollapsed(loadCollapsed(props.sessionIdOrPath ?? null));
		setFileListExpanded(loadFileListExpanded(props.sessionIdOrPath ?? null));
	}, [props.sessionIdOrPath]);

	// 仅在用户主动点击时写 localStorage,不在 sessionIdOrPath 切换时误写
	const handleToggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			if (props.sessionIdOrPath) {
				localStorage.setItem(
					SESSION_FILE_SUMMARY_COLLAPSED_KEY_PREFIX + props.sessionIdOrPath,
					String(next),
				);
			}
			return next;
		});
	}, [props.sessionIdOrPath]);

	const handleToggleFileList = useCallback(() => {
		setFileListExpanded((prev) => {
			const next = !prev;
			if (props.sessionIdOrPath) {
				localStorage.setItem(
					SESSION_FILE_SUMMARY_FILE_LIST_EXPANDED_KEY_PREFIX +
						props.sessionIdOrPath,
					String(next),
				);
			}
			return next;
		});
	}, [props.sessionIdOrPath]);

	const visibleFiles = fileListExpanded ? props.files : props.files.slice(0, 4);
	const hiddenCount = Math.max(0, props.files.length - visibleFiles.length);

	// 无文件时不渲染
	if (props.files.length === 0) return null;

	return (
		<section className="session-file-summary-list-card" aria-label={t("drawer.modifiedFilesAria")}>
			<button
				className="session-file-summary-header"
				type="button"
				onClick={handleToggleCollapsed}
				aria-expanded={!collapsed}
			>
				<ChevronDown
					size={14}
					className={`session-file-summary-chevron${collapsed ? "" : " open"}`}
				/>
				<span className="session-file-summary-title-span">{t("drawer.modifiedFiles")}</span>
				<small className="session-file-summary-count">
					{props.files.length} {t("app.files")}
				</small>
			</button>
			{!collapsed && (
				<>
					<ul className="session-file-summary-list">
						{visibleFiles.map((file) => {
							const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
							return (
								<li key={file.path}>
									<button
										className="session-file-summary-row"
										type="button"
										title={file.path}
										onClick={() => props.onDiffFile?.(file.path, file.originalContent, file.content)}
									>
										<span className="session-file-summary-name">{fileName}</span>
									</button>
								</li>
							);
						})}
					</ul>
					{props.files.length > 4 && (
						<button
							className="session-file-summary-toggle"
							type="button"
							onClick={handleToggleFileList}
						>
							{fileListExpanded ? t("common.collapse") : t("drawer.moreFiles", { count: hiddenCount })}
						</button>
					)}
				</>
			)}
		</section>
	);
}

/** sessions 面板：DrawerContent（抽屉）与 SessionHistoryModal（弹窗）共用，导出供两者复用。 */
export function SessionsPanel(props: {
	sessions: SessionSummary[];
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	/* sessionActionNotice 已改用 toast (sonner) 实现 */
	const [sessionActionLoading, setSessionActionLoading] = useState<{
		filePath: string;
		action: "copy" | "export" | "delete";
	} | null>(null);
	const [deleteConfirmSession, setDeleteConfirmSession] =
		useState<SessionSummary | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	function startRename(session: SessionSummary) {
		setRenamingPath(session.filePath);
		setEditValue(session.name || "");
		requestAnimationFrame(() => inputRef.current?.focus());
	}

	function confirmRename() {
		if (renamingPath && editValue.trim()) {
			void props.onRename(renamingPath, editValue.trim());
		}
		setRenamingPath(null);
		setEditValue("");
	}

	async function runSessionAction(
		session: SessionSummary,
		actionType: "copy" | "export" | "delete",
		action: () => void | Promise<void>,
		successText: string,
	) {
		setSessionActionLoading({ filePath: session.filePath, action: actionType });
		showNotice(
			actionType === "copy"
				? t("drawer.sessionActionCopying")
				: actionType === "export"
					? t("drawer.sessionActionExporting")
					: t("drawer.sessionActionDeleting"),
			3500,
		);
		try {
			await action();
			showNotice(successText, 1600);
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : t("drawer.sessionActionFailed"),
				2400,
			);
		} finally {
			setSessionActionLoading(null);
		}
	}

	// 计算子会话到父会话的分组映射；路径可能跨 Windows/WSL 或经过 IPC，统一分隔符和大小写。
	const parentToChildren = useMemo(() => {
		const map = new Map<string, SessionSummary[]>();
		for (const s of props.sessions) {
			const parentKey = normalizeSessionPathForCompare(s.parentSessionPath);
			if (parentKey) {
				const list = map.get(parentKey) ?? [];
				list.push(s);
				map.set(parentKey, list);
			}
		}
		return map;
	}, [props.sessions]);
	// 仅显示顶层会话（非子会话）的计数
	const parentSessions = useMemo(() =>
		props.sessions.filter(s => !s.parentSessionPath),
		[props.sessions],
	);
	const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
	const toggleParent = useCallback((filePath: string) => {
		const key = normalizeSessionPathForCompare(filePath) ?? filePath;
		setExpandedParents(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{t("drawer.sessionCount", { count: parentSessions.length })}</span>
				<Button variant="ghost" size="sm" onClick={props.onRefresh}>{t("common.refresh")}</Button>
			</div>
			{parentSessions.length === 0 && (
				<div className="sessions-empty">
					<strong>{t("drawer.sessionEmptyTitle")}</strong>
					<span>{t("drawer.sessionEmptyDesc")}</span>
				</div>
			)}
			{parentSessions.map((session) => {
				const children = parentToChildren.get(normalizeSessionPathForCompare(session.filePath) ?? "");
				const normalizedPath = normalizeSessionPathForCompare(session.filePath) ?? session.filePath;
				const isExpanded = expandedParents.has(normalizedPath);
				return (
				<div
					key={session.filePath}
					className="session-card-group"
				>
					<div className="session-card">
					{renamingPath === session.filePath ? (
						<div className="session-rename-row">
							<Input
								ref={inputRef}
								value={editValue}
								onChange={(e) => setEditValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") confirmRename();
									if (e.key === "Escape") {
										setRenamingPath(null);
										setEditValue("");
									}
								}}
								autoFocus
							/>
							<Button size="sm" onClick={confirmRename}>{t("common.save")}</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setRenamingPath(null);
									setEditValue("");
								}}
							>
								{t("common.cancel")}
							</Button>
						</div>
					) : (
						<div className="session-card-display">
							<PathTooltip content={`${session.name || t("common.untitled")}\n${session.filePath}`}>
								<button
									className="session-card-inner"
									onClick={() => props.onOpen(session)}
								>
									<div className="session-card-title">
										<strong>{session.name || t("common.untitled")}</strong>
										{session.source && session.source !== "pi" && (
											<SessionSourceBadge source={session.source} />
										)}
										<small>
											{new Date(session.updatedAt).toLocaleString()} ·{" "}
											{t("drawer.sessionMessages", {
												count: session.messageCount,
											})}
										</small>
									</div>
								</button>
							</PathTooltip>
							<div className="session-card-actions">
								<Button
									variant="ghost"
									className="session-rename-button"
									title={t("menu.copySession")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"copy",
											() => props.onCopy(session),
											t("drawer.sessionCopied"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "copy"
											? t("menu.copying")
											: t("common.copy")}
									</span>
								</Button>
								<Button
									variant="ghost"
									className="session-rename-button"
									title={t("menu.exportHtml")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() =>
										void runSessionAction(
											session,
											"export",
											() => props.onExport(session),
											t("drawer.sessionExported"),
										)
									}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "export"
											? t("menu.exporting")
											: t("common.export")}
									</span>
								</Button>
								<Button
									variant="ghost"
									className="session-rename-button"
									title={t("common.rename")}
									onClick={() => startRename(session)}
								>
									<span>{t("common.rename")}</span>
								</Button>
								<Button
									variant="ghost"
									className="session-rename-button text-destructive"
									title={t("common.delete")}
									disabled={Boolean(sessionActionLoading)}
									onClick={() => setDeleteConfirmSession(session)}
								>
									{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete" && <span className="mini-loader" />}
									<span>
										{sessionActionLoading?.filePath === session.filePath &&
										sessionActionLoading.action === "delete"
											? t("drawer.sessionActionDeleting")
											: t("common.delete")}
									</span>
								</Button>
							</div>
							{/* sessionActionNotice 已改用 toast (sonner) 实现 */}
						</div>
					)}
				</div>
					{children && children.length > 0 && (
						<div className="session-card-children-header">
							<button
								className="session-card-expand-btn"
								title={isExpanded ? t("drawer.collapseSubagentSessions") : t("drawer.expandSubagentSessions")}
								onClick={() => toggleParent(session.filePath)}
							>
								{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
								<span>{t("drawer.subagentSessionCount", { count: children.length })}</span>
							</button>
						</div>
					)}
					{isExpanded && children?.map((child) => (
						<div key={child.filePath} className="session-card session-card-child">
							<div className="session-card-display">
								<PathTooltip content={`${child.name || t("common.untitled")}\n${child.filePath}`}>
									<button
										className="session-card-inner"
										onClick={() => props.onOpen(child)}
									>
										<div className="session-card-title">
											<strong>{child.name || t("common.untitled")}</strong>
											<SessionSourceBadge label={t("drawer.subagentSession")} source="codex" />
											<small>
												{new Date(child.updatedAt).toLocaleString()} ·{" "}
												{t("drawer.sessionMessages", {
													count: child.messageCount,
												})}
											</small>
										</div>
									</button>
								</PathTooltip>
							</div>
						</div>
					))}
				</div>
				);
			})}
			{deleteConfirmSession && (() => {
					const deleteChildren = parentToChildren.get(normalizeSessionPathForCompare(deleteConfirmSession.filePath) ?? "") ?? [];
					// #115 U5：删除确认统一走 shadcn ConfirmDialog（danger 变体），删掉散装 backdrop
					return (
						<ConfirmDialog
							title={t("drawer.sessionDeleteTitle")}
							message={deleteChildren.length > 0
								? t("drawer.sessionDeleteBodyWithChildren", {
										name: deleteConfirmSession.name || t("common.untitled"),
										count: deleteChildren.length,
									})
								: t("drawer.sessionDeleteBody", {
										name: deleteConfirmSession.name || t("common.untitled"),
									})}
							confirmLabel={t("common.delete")}
							danger
							onCancel={() => setDeleteConfirmSession(null)}
							onConfirm={() => {
								const target = deleteConfirmSession;
								setDeleteConfirmSession(null);
								void runSessionAction(
									target,
									"delete",
									() => props.onDelete(target),
									t("drawer.sessionDeleted"),
								);
							}}
						/>
					); })()
		}
		</div>
	);
}

export function SessionHistoryModal(props: {
	project: Project;
	sessions: SessionSummary[];
	loading: boolean;
	onClose: () => void;
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void | Promise<void>;
	onCopy: (session: SessionSummary) => void | Promise<void>;
	onExport: (session: SessionSummary) => void | Promise<void>;
	onDelete: (session: SessionSummary) => void | Promise<void>;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex max-h-[min(680px,calc(100vh-80px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle></DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="truncate border-b border-border-subtle bg-bg-muted px-[18px] py-[10px] text-caption text-text-secondary" title={props.project.path}>
					{props.project.path}
				</div>
				<div className="relative flex min-h-[320px] flex-1 flex-col overflow-hidden">
					{props.loading ? (
						<div className="grid min-h-[320px] place-items-center content-center gap-3 text-body text-text-tertiary">
							<div className="loader" />
							<span>{t("drawer.historyLoading")}</span>
						</div>
					) : (
						<SessionsPanel
							sessions={props.sessions}
							onRefresh={props.onRefresh}
							onOpen={props.onOpen}
							onRename={props.onRename}
							onCopy={props.onCopy}
							onExport={props.onExport}
							onDelete={props.onDelete}
						/>
					)}
				</div>
		
			</DialogContent>
		</Dialog>
	);
}

/** 创建 git worktree 的对话框 */
