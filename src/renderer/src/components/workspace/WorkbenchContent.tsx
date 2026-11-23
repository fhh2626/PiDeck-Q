import type { WorkspaceContentOpenMode } from "../../../../shared/types";
import { FileDiffViewer } from "../app/FileDiffViewer";

type EditorTabLike = {
	id: string;
	filePath: string;
	mode: "view" | "diff";
	originalContent: string;
	modifiedContent?: string;
	allowSave: boolean;
	label?: string;
	preserveDrawer?: boolean;
};

type GitDiffLike = {
	filePath: string;
	originalContent: string;
	modifiedContent: string;
	label: string;
};

export type WorkbenchContentProps = {
	theme: "dark" | "light";
	maxFileSizeMB: number;
	/** Git Diff 优先；无 Diff 时渲染编辑器 tab */
	gitDiff: GitDiffLike | null;
	gitDiffDisplayMode: WorkspaceContentOpenMode;
	onToggleGitDiffMode: () => void;
	onCloseGitDiff: () => void;
	activeTab: EditorTabLike | null;
	editorMode: WorkspaceContentOpenMode;
	onToggleEditorMode?: () => void;
	onCloseEditor: () => void;
	editorTabs: (EditorTabLike & { preview?: boolean })[];
	onSelectEditorTab: (id: string) => void;
	onCloseEditorTab: (id: string) => void;
	onPromoteEditorPreview: (id: string) => void;
	readContent: (path: string) => Promise<string>;
	onOpenFile?: (path: string) => void;
	readOriginalContent: (path: string) => Promise<string>;
	saveContent: (path: string, content: string) => Promise<void>;
};

/**
 * 中间栏阅读面：Git Diff / 文件编辑共用 FileDiffViewer。
 *
 * 文件导航保留在阅读面内部，独立于侧栏会话选择。
 * 不用 React.lazy：WebView 下动态 import 偶发
 * 「Failed to fetch dynamically imported module」，且 lazy 会缓存 rejected
 * promise，边界「重试」也无法恢复。打开文件是主路径，静态引入更稳。
 */
export function WorkbenchContent(props: WorkbenchContentProps) {
	if (props.gitDiff) {
		return (
			<FileDiffViewer
				displayMode={props.gitDiffDisplayMode}
				filePath={props.gitDiff.filePath}
				mode="diff"
				onToggleMode={props.onToggleGitDiffMode}
				originalContent={props.gitDiff.originalContent}
				modifiedContent={props.gitDiff.modifiedContent}
				onClose={props.onCloseGitDiff}
				readContent={props.readContent}
				theme={props.theme}
				maxFileSizeMB={props.maxFileSizeMB}
			/>
		);
	}

	if (!props.activeTab) return null;

	return (
		<FileDiffViewer
			displayMode={props.editorMode}
			filePath={props.activeTab.filePath}
			mode={props.activeTab.mode}
			onToggleMode={
				props.activeTab.preserveDrawer ? undefined : props.onToggleEditorMode
			}
			originalContent={
				props.activeTab.mode === "diff"
					? props.activeTab.originalContent
					: undefined
			}
			modifiedContent={props.activeTab.modifiedContent}
			onClose={props.onCloseEditor}
			readContent={props.readContent}
			readOriginalContent={props.readOriginalContent}
			onOpenFile={props.onOpenFile}
			saveContent={
				props.activeTab.allowSave ? props.saveContent : undefined
			}
			theme={props.theme}
			maxFileSizeMB={props.maxFileSizeMB}
			tabs={props.editorTabs}
			activeTabId={props.activeTab.id}
			onSelectTab={props.onSelectEditorTab}
			onCloseTab={props.onCloseEditorTab}
			onPromotePreviewTab={props.onPromoteEditorPreview}
		/>
	);
}
