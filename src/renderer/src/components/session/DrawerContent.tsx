import { cn } from "../../lib/utils";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useCallback,
	type CSSProperties,
	type MouseEvent as ReactMouseEvent,
} from "react";
import {
	ChevronRight,
	ChevronsDownUp,
	FileText,
	Folder,
	FolderOpen,
	RefreshCw,
	X,
} from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import { FileSortControl } from "./FileSortControl";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../fileIcons";
import { sortFileNodes, FILE_SORT_OPTIONS, FILE_SORT_DEFAULT_DIRECTION, type FileSortMode, type FileSortDirection } from "../../utils/fileTreeSort";
import { writeFileNodeDragPayload } from "../app/AppUtils";
import { t } from "../../i18n";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import type { FileTreeNode, Project, SessionSummary } from "../../../../shared/types";
// SessionsPanel 仍由 WorkspaceSurface 持有（SessionHistoryModal 复用），按需 import。
// 注意：该 import 是 DrawerContent 动态 chunk 的依赖，不影响首屏 bundle。
import { SessionsPanel } from "./WorkspaceSurface";

/**
 * 右侧抽屉 files/sessions 面板（原 WorkspaceSurface 内的 DrawerContent）。
 * 独立成文件是为了配合 DrawerSurface 的动态 import：只有抽屉真正打开时才加载
 * 本模块（含 file-icons、fileTreeSort 等重依赖），不再进入首屏静态依赖链。
 */
export function DrawerContent(props: {
	panel: WorkspaceDrawerPanel;
	project?: Project;
	files: FileTreeNode[];
	sessions: SessionSummary[];
	sessionsLoading?: boolean;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onCollapseAllDirectories: () => void;
	onClose: () => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	onOpenFolder?: () => void;
	onRefreshSessions: () => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (filePath: string, newName: string) => void;
	onCopySession: (session: SessionSummary) => void | Promise<void>;
	onExportSession: (session: SessionSummary) => void | Promise<void>;
	onDeleteSession: (session: SessionSummary) => void | Promise<void>;
	onOpenFile?: (path: string) => void;
	/** 单击默认预览；第二参 permanent = 双击常驻 */
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	/** 项目根目录：面板空白处拖入/粘贴/右键的落点 */
	projectRoot?: string;
	/** 从 OS 拖入文件到目录或面板空白区域（复制） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件到目标目录（Ctrl+V / 右键菜单） */
	onPasteFiles?: (targetDir: string) => void;
	/** 文件树内部拖拽移动文件/目录到目标目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
}) {
	const title =
		props.panel === "files"
			? null
			: props.project
				? t("drawer.projectSessions", { name: props.project.name })
				: t("drawer.historyTitle");
	return (
		<>
			{/* 文件抽屉：去掉「文件 + ×」顶栏，关闭改走右侧 rail；会话历史仍保留顶栏。 */}
			{props.panel !== "files" && title && (
				<div className="drawer-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background px-3">
					<strong className="truncate text-sm font-semibold text-foreground">{title}</strong>
					<div className="drawer-header-actions flex shrink-0 items-center gap-1">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							title={t("drawer.closePanel")}
							aria-label={t("drawer.closePanel")}
							onClick={props.onClose}
						>
							<X size={16} />
						</Button>
					</div>
				</div>
			)}
			{props.panel === "files" && (
				<FilesPanel
					files={props.files}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onCollapseAll={props.onCollapseAllDirectories}
					onFileContextMenu={props.onFileContextMenu}
					onRefreshFiles={props.onRefreshFiles}
					onOpenFolder={props.onOpenFolder}
					onOpenFile={props.onOpenFile}
					onViewFile={props.onViewFile}
					projectRoot={props.projectRoot}
					onDropFiles={props.onDropFiles}
					onMoveFiles={props.onMoveFiles}
					onPasteFiles={props.onPasteFiles}
				/>
			)}
			{props.panel === "sessions" && (
				<SessionsPanel
					sessions={props.sessions}
					onRefresh={props.onRefreshSessions}
					onOpen={props.onOpenSession}
					onRename={props.onRenameSession}
					onCopy={props.onCopySession}
					onExport={props.onExportSession}
					onDelete={props.onDeleteSession}
				/>
			)}
		</>
	);
}

function FilesPanel(props: {
	files: FileTreeNode[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshFiles: () => void;
	/** 收起文件树中所有已展开的目录，清空 expandedDirs。 */
	onCollapseAll?: () => void;
	onOpenFolder?: () => void;
	onOpenFile?: (path: string) => void;
	/** 单击默认预览；第二参 permanent = 双击常驻 */
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	/** 项目根目录：面板空白处拖入/粘贴/右键的落点 */
	projectRoot?: string;
	/** 从 OS 拖入文件到目录或面板空白区域（复制） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件到目标目录（Ctrl+V / 右键菜单） */
	onPasteFiles?: (targetDir: string) => void;
	/** 文件树内部拖拽移动文件/目录到目标目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
}) {
	// 排序维度/方向持久化到 localStorage：文件树排序是用户偏好，跨会话保留
	const FILE_SORT_KEY = "pi-desktop:file-sort";
	const FILE_SORT_DIR_KEY = "pi-desktop:file-sort-dir";
	const [sortMode, setSortMode] = useState<FileSortMode>(() => {
		const saved = typeof window !== "undefined" ? localStorage.getItem(FILE_SORT_KEY) : null;
		return FILE_SORT_OPTIONS.some((o) => o.value === saved) ? (saved as FileSortMode) : "name";
	});
	const [sortDirection, setSortDirection] = useState<FileSortDirection>(() => {
		const saved = typeof window !== "undefined" ? localStorage.getItem(FILE_SORT_DIR_KEY) : null;
		return saved === "asc" || saved === "desc" ? saved : FILE_SORT_DEFAULT_DIRECTION["name"];
	});
	useEffect(() => {
		localStorage.setItem(FILE_SORT_KEY, sortMode);
		// 切换维度时方向跟随该维度的默认方向（名称升序；时间/大小倒序）
		setSortDirection(FILE_SORT_DEFAULT_DIRECTION[sortMode]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sortMode]);
	useEffect(() => {
		localStorage.setItem(FILE_SORT_DIR_KEY, sortDirection);
	}, [sortDirection]);
	// 排序是纯展示层变换：不改变 props.files 引用，只影响渲染次序
	const sortedFiles = useMemo(
		() => sortFileNodes(props.files, sortMode, sortDirection),
		[props.files, sortMode, sortDirection],
	);
	/** 拖入高亮的目标目录路径（null = 拖在面板空白区域） */
	const [dragOverDir, setDragOverDir] = useState<string | null>(null);
	const dragCountRef = useRef(0);

	// 面板自身接受拖入：落在空白区域视为复制到项目根目录
	const handlePanelDragOver = (event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};
	const handlePanelDrop = (event: React.DragEvent) => {
		event.preventDefault();
		setDragOverDir(null);
		dragCountRef.current = 0;
		if (event.dataTransfer.files.length > 0 && props.onDropFiles && props.projectRoot) {
			props.onDropFiles(props.projectRoot, event.dataTransfer.files);
		}
	};
	const handlePanelKeyDown = (event: React.KeyboardEvent) => {
		// Ctrl+V / Cmd+V 粘贴到项目根目录
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
			if (props.onPasteFiles && props.projectRoot) {
				props.onPasteFiles(props.projectRoot);
			}
		}
	};
	const handlePanelContextMenu = (event: React.MouseEvent) => {
		// 仅面板背景本身被右键时触发（不拦截文件节点的右键事件）
		if (event.target !== event.currentTarget) return;
		event.preventDefault();
		if (props.projectRoot) {
			props.onFileContextMenu(
				{
					path: props.projectRoot,
					name: "",
					type: "directory",
					relativePath: "",
					children: undefined,
				} as FileTreeNode,
				event.clientX,
				event.clientY,
			);
		}
	};
	return (
		<div
			className="files-panel flex min-h-0 flex-1 flex-col overflow-x-hidden"
			tabIndex={-1}
			onDragOver={handlePanelDragOver}
			onDragLeave={() => { setDragOverDir(null); dragCountRef.current = 0; }}
			onDrop={handlePanelDrop}
			onKeyDown={handlePanelKeyDown}
			onContextMenu={handlePanelContextMenu}
		>
			{/* 工具行压矮：去掉顶栏后这是文件抽屉唯一 chrome；h-7 + size-6 对齐侧栏密度 */}
			<div className="panel-action-row flex h-7 min-w-0 shrink-0 items-center justify-end gap-1 border-b border-border/40 px-2 text-xs text-muted-foreground">
				<div className="panel-action-buttons flex min-w-0 items-center gap-0.5">
					{/* 文件树排序：方向切换与维度选择合并在一个图标菜单内（默认按名称·升序） */}
					<FileSortControl
						sortMode={sortMode}
						sortDirection={sortDirection}
						onSortModeChange={setSortMode}
						onToggleDirection={() => setSortDirection((d) => (d === "asc" ? "desc" : "asc"))}
					/>
					{props.onOpenFolder && (
						<Button type="button" variant="ghost" size="icon-sm" className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={props.onOpenFolder} title={t("drawer.openFolder")} aria-label={t("drawer.openFolder")}>
							<Folder size={13} />
						</Button>
					)}
					{/* 刷新与全部收起：纯图标，密度对齐 shadcn icon button */}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
						onClick={props.onRefreshFiles}
						title={t("common.refresh")}
						aria-label={t("common.refresh")}
					>
						<RefreshCw size={13} />
					</Button>
					{props.onCollapseAll && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
							onClick={props.onCollapseAll}
							title={t("drawer.collapseAllDirs")}
							aria-label={t("drawer.collapseAllDirs")}
							disabled={props.expandedDirs.size === 0}
						>
							<ChevronsDownUp size={13} />
						</Button>
					)}
				</div>
			</div>
			{sortedFiles.map((node) => (
				<FileNode
					key={node.path}
					node={node}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
					onOpenFile={props.onOpenFile}
					onViewFile={props.onViewFile}
					onDropFiles={props.onDropFiles}
					onMoveFiles={props.onMoveFiles}
				dragOverDir={dragOverDir}
					onDragOverDirChange={setDragOverDir}
				/>
			))}
		</div>
	);
}

function fileIconElement(name: string, isDirectory: boolean, isExpanded: boolean) {
	if (isDirectory) {
		return isExpanded ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />;
	}
	try {
		const { svg, colorName } = getFileIconSeti(name);
		const color = getFileIconColor(colorName);
		// SVG 只来自仓库内附带许可证的只读 Seti 数据快照，不接收文件内容或用户输入。
		// 尺寸由 .file-node-seti-icon → --file-type-icon-size 承担（树行不用 shadcn Button，避免其 [&_svg]:size-4 抢尺寸）。
		return (
			<span
				aria-hidden="true"
				className="file-node-seti-icon"
				style={{ color }}
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
		);
	} catch {
		return <FileText size={16} aria-hidden="true" />;
	}
}

function FileNode(props: {
	node: FileTreeNode;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onOpenFile?: (path: string) => void;
	/** 单击默认预览；第二参 permanent = 双击常驻 */
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	depth?: number;
	/** 拖入文件（仅目录节点使用） */
	onDropFiles?: (targetDir: string, files: FileList) => void;
	/** 内部拖拽移动文件/目录 */
	onMoveFiles?: (sourcePaths: string[], targetDir: string) => void;
	dragOverDir?: string | null;
	onDragOverDirChange?: (path: string | null) => void;
}) {
	const { node, expandedDirs, onToggleDirectory, depth = 0 } = props;
	const expanded = expandedDirs.has(node.path);
	const typeLabel = node.type === "file" ? getFileTypeLabel(node.name) : "";
	const rowStyle = {
		/* 每层 8px：旧 16 在窄抽屉里空白过大（标注「缩进太大」）。 */
		"--file-depth-offset": `${depth * 8}px`,
		paddingLeft: `calc(var(--space-1) + ${depth * 8}px)`,
		paddingRight: "var(--space-1)",
	} as CSSProperties;
	const menu = (event: ReactMouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	// 内部拖拽移动：dataTransfer 携带源路径，目录行是落点；OS 文件拖入则是复制
	// effectAllowed=copyMove：目录落点显式选 move（内部移动），composer 落点选 copy（插入 @ 引用）
	const handleDragStart = useCallback((event: React.DragEvent) => {
		event.dataTransfer.effectAllowed = "copyMove";
		writeFileNodeDragPayload(event.dataTransfer, node);
	}, [node]);
	const handleDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		props.onDragOverDirChange?.(node.path);
	}, [node.path, props.onDragOverDirChange]);
	const handleDragLeave = useCallback(() => {
		props.onDragOverDirChange?.(null);
	}, [props.onDragOverDirChange]);
	const handleDrop = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		props.onDragOverDirChange?.(null);
		// 内部拖拽移动：优先检查 pi-file-path
		const sourcePath = event.dataTransfer.getData("text/pi-file-path");
		if (sourcePath) {
			if (sourcePath !== node.path && props.onMoveFiles) {
				props.onMoveFiles([sourcePath], node.path);
			}
			return;
		}
		// 外部 OS 文件拖入：复制到目标目录
		if (event.dataTransfer.files.length > 0 && props.onDropFiles) {
			props.onDropFiles(node.path, event.dataTransfer.files);
		}
	}, [node.path, props.onDropFiles, props.onMoveFiles, props.onDragOverDirChange]);
	const isDragOver = props.dragOverDir === node.path;
	/* 树行用原生 button，不用 shadcn Button：后者基类强制子 SVG size-4，
	   会压掉 Seti --file-type-icon-size 与 lucide size，靠 ! 反压是补丁。
	   2027-01：hover 高亮加与侧栏行同款的过渡动画（transition-[background-color,
	   border-color,box-shadow] duration-200），移入文件列表时背景平滑渐变而非瞬切。 */
	const fileRowButtonClass =
		"file-node-row inline-flex h-[28px] min-h-0 w-full items-center justify-start gap-1.5 rounded-sm border-0 bg-transparent py-0 text-left text-body font-normal text-foreground transition-[background-color,border-color,box-shadow] duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";
	if (node.type === "file")
		return (
			<div className="file-node" style={rowStyle}>
				<button
					type="button"
					className={cn("file", fileRowButtonClass)}
					style={rowStyle}
					title={`${node.relativePath}\n${typeLabel}`}
					draggable
					onDragStart={handleDragStart}
					onClick={() => props.onViewFile?.(node.path)}
					onDoubleClick={(event) => {
						event.preventDefault();
						props.onViewFile?.(node.path, "permanent");
					}}
					onContextMenu={menu}
				>
					<span className="file-node-icon">
						{fileIconElement(node.name, false, false)}
					</span>
					<span className="file-node-name">{node.name}</span>
					<span className="file-node-type-label">{typeLabel}</span>
				</button>
			</div>
		);
	return (
		<div className="file-node" style={rowStyle}>
			<Collapsible open={expanded} onOpenChange={() => onToggleDirectory(node.path)}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className={cn("directory group", fileRowButtonClass, isDragOver && "bg-muted ring-1 ring-border")}
						style={rowStyle}
						title={node.relativePath}
						draggable
						onDragStart={handleDragStart}
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
						onContextMenu={menu}
					>
						<ChevronRight className="file-node-chevron size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
						<span className="file-node-icon">
							{fileIconElement(node.name, true, expanded)}
						</span>
						<span className="file-node-name">{node.name}</span>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					{node.children && node.children.length > 0 && (
						<div className="file-children">
							{node.children.map((child) => (
								<FileNode key={child.path} node={child}
									expandedDirs={expandedDirs}
									onToggleDirectory={onToggleDirectory}
									onFileContextMenu={props.onFileContextMenu}
									onOpenFile={props.onOpenFile}
									onViewFile={props.onViewFile}
									onDropFiles={props.onDropFiles}
									onMoveFiles={props.onMoveFiles}
									dragOverDir={props.dragOverDir}
									onDragOverDirChange={props.onDragOverDirChange}
									depth={depth + 1} />
							))}
						</div>
					)}
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
