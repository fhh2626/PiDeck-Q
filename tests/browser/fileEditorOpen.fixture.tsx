import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { createPreviewApi } from "@/previewApi";
import { setI18nLocale, t } from "@/i18n";
import { TooltipProvider } from "@/components/ui-shadcn/tooltip";
import type { Project } from "@shared/types";

type Read = { path: string; requestedAt: number; returnedAt?: number; domAt?: number; content?: string };
declare global {
	interface Window {
		fileEditorOpenFixture?: { reads: () => Read[]; originalReads: () => number };
	}
}

setI18nLocale("en-US");
const reads: Read[] = [];
let originalReads = 0;
const project: Project = { id: "project", name: "Editor fixture", path: "/project", lastOpenedAt: 1 };
const noop = () => {};
const noDiff = async () => null;

/** Browser routes control actual read/write completion; the renderer owns the full opening flow. */
async function readContent(path: string): Promise<string> {
	const entry: Read = { path, requestedAt: performance.now() };
	reads.push(entry);
	const response = await fetch(`/file-editor-test/read?path=${encodeURIComponent(path)}`);
	if (!response.ok) throw new Error(await response.text());
	entry.content = await response.text();
	entry.returnedAt = performance.now();
	return entry.content;
}
async function writeContent(path: string, content: string): Promise<void> {
	const response = await fetch("/file-editor-test/write", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, content }),
	});
	if (!response.ok) throw new Error(await response.text());
}
async function readOriginalContent(): Promise<string> {
	originalReads += 1;
	return "Git original";
}

const api = createPreviewApi();
window.piDesktop = { ...api, files: { ...api.files, readContent, writeContent } };

async function mount() {
	const [{ useFileEditor }, { WorkbenchContent }, { MarkdownLink }] = await Promise.all([
		import("@/hooks/useFileEditor"), import("@/components/workspace/WorkbenchContent"), import("@/components/session/MarkdownLink"),
	]);
	function Fixture() {
		const activeProjectIdRef = useRef<string | undefined>(project.id);
		const editor = useFileEditor({
			activeProjectId: project.id, activeProjectIdRef, activeAgent: null, activeProject: project,
			drawer: null, setDrawer: noop, setDrawerCollapsed: noop, contentOpenMode: "split", showToast: noop,
			readFileContent: readContent, readGitOriginalContent: readOriginalContent, writeFileContent: writeContent,
			openFile: async () => {}, workspaceFileDiff: noDiff, commitFileDiff: noDiff, t,
		});
		useEffect(() => {
			window.fileEditorOpenFixture = { reads: () => reads.map((entry) => ({ ...entry })), originalReads: () => originalReads };
			// This records DOM availability, not OS paint or WebView/IPC latency.
			const observer = new MutationObserver(() => {
				const pane = document.querySelector<HTMLElement>("[data-active-file]");
				const element = pane?.querySelector<HTMLElement>(".cm-editor");
				const view = element ? EditorView.findFromDOM(element) : null;
				const currentPath = pane?.getAttribute("data-active-file");
				for (const entry of reads) {
					if (entry.path === currentPath && entry.returnedAt !== undefined && entry.domAt === undefined
						&& view?.state.doc.toString() === entry.content) entry.domAt = performance.now();
				}
			});
			observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true, characterData: true });
			return () => { observer.disconnect(); delete window.fileEditorOpenFixture; };
		}, []);
		return <TooltipProvider>
			<nav className="flex gap-4 p-4">
				{["a.txt", "a.json", "b.txt", "b.json"].map((name) => <MarkdownLink key={name}
					href={`/project/${name}`} onOpenFile={editor.viewFilePath} onOpenExternal={noop}>{name}</MarkdownLink>)}
				<button onClick={editor.closeEditor}>Close editor</button>
			</nav>
			<div style={{ height: 600 }} data-active-file={editor.activeTab?.filePath}>
				<WorkbenchContent theme="light" maxFileSizeMB={5} gitDiff={editor.gitDrawerDiff}
					gitDiffDisplayMode={editor.gitDiffDisplayMode} onToggleGitDiffMode={editor.toggleGitDiffDisplayMode}
					onCloseGitDiff={editor.closeGitDiff} activeTab={editor.activeTab} editorMode={editor.editorMode}
					onToggleEditorMode={editor.toggleEditorMode} onCloseEditor={editor.closeEditor}
					editorTabs={editor.editorTabs.map((tab) => ({ ...tab, preview: tab.id === editor.previewEditorTabId }))}
					onSelectEditorTab={editor.selectEditorTab} onCloseEditorTab={editor.closeEditorTab}
					onPromoteEditorPreview={editor.promotePreviewEditorTab}
					readContent={editor.readEditorFileContent} readOriginalContent={editor.readEditorOriginalContent}
					saveContent={editor.saveEditorFileContent} onOpenFile={editor.viewFilePath} />
			</div>
		</TooltipProvider>;
	}
	const element = document.getElementById("root");
	if (!element) throw new Error("Missing fixture root");
	createRoot(element).render(<Fixture />);
}
void mount().catch((error: unknown) => { document.body.textContent = String(error); });
