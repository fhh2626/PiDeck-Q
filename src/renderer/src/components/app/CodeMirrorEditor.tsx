import { memo, useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, indentUnit } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { linter, lintGutter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { baseEditorExtensions, loadEditorLanguage } from "../../utils/codemirrorSetup";
import { t } from "../../i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";

// Prop synchronization must not become a user edit or an undo entry.
const externalValueChange = Annotation.define<boolean>();

export type CodeMirrorEditorProps = {
	value: string;
	onChange?: (value: string) => void;
	/** 文件扩展名（"ts"）或旧 Monaco 语言 id（"markdown"），按需加载见 loadEditorLanguage。 */
	language?: string;
	height?: string;
	readOnly?: boolean;
	/** 鼠标选中文本后右键菜单「引用选中内容」：携带选区起止行号（1 起），由调用方插入输入框。 */
	onAttachSelection?: (startLine: number, endLine: number) => void;
};

/** 右键选区菜单状态：无选区时保持 null（不接管浏览器右键菜单） */
type SelectionMenu = {
	x: number;
	y: number;
	startLine: number;
	endLine: number;
};

/** 统一封装：与旧 MonacoEditor 的 props 完全兼容（value/onChange/language/height/readOnly），
 * 外部切换时零成本替换。EditorView 生命周期由本组件托管：卸载 dispose、外部 value 变化
 * 以「与当前文档不同才替换」的方式同步，避免覆盖用户正在输入的内容。 */
export const CodeMirrorEditor = memo(function CodeMirrorEditor({
	value,
	onChange,
	language,
	height = "100%",
	readOnly = false,
	onAttachSelection,
}: CodeMirrorEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const readOnlyCompartment = useRef(new Compartment());
	const languageCompartment = useRef(new Compartment());
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onAttachSelectionRef = useRef(onAttachSelection);
	onAttachSelectionRef.current = onAttachSelection;
	// The mount effect reads the latest committed input, independently of language loading.
	const valueRef = useRef(value);
	valueRef.current = value;
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);

	// 右键：存在文本选区时接管默认菜单，弹出「引用选中内容」；无选区不拦截（保留浏览器菜单）。
	// 行号取 selection.main 的起止位置所在行（CM6 行号从 1 起，与编辑器 gutter 一致）。
	const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
		const view = viewRef.current;
		const main = view?.state.selection.main;
		if (!view || !main || main.from === main.to) return;
		event.preventDefault();
		const startLine = view.state.doc.lineAt(main.from).number;
		const endLine = view.state.doc.lineAt(main.to).number;
		setSelectionMenu({ x: event.clientX, y: event.clientY, startLine, endLine });
	};

	useEffect(() => {
		if (!hostRef.current) return;
		// Disk content is usable immediately. Optional parsers and JSON diagnostics
		// configure this view later, without discarding edits, selection or undo.
		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: valueRef.current,
				extensions: [
					...baseEditorExtensions({ wordWrap: true }),
					languageCompartment.current.of([]),
					readOnlyCompartment.current.of(EditorState.readOnly.of(readOnlyRef.current)),
					lineNumbers(),
					foldGutter(),
					history(),
					drawSelection(),
					dropCursor(),
					indentOnInput(),
					bracketMatching(),
					closeBrackets(),
					autocompletion(),
					rectangularSelection(),
					crosshairCursor(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					highlightSelectionMatches(),
					indentUnit.of("  "),
					keymap.of([
						...closeBracketsKeymap,
						...defaultKeymap,
						...searchKeymap,
						...historyKeymap,
						...foldKeymap,
						...completionKeymap,
						indentWithTab,
						{ key: "Mod-/", run: toggleComment },
					]),
					EditorView.updateListener.of((update) => {
						if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalValueChange))) {
							onChangeRef.current?.(update.state.doc.toString());
						}
					}),
				],
			}),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			if (viewRef.current === view) viewRef.current = null;
		};
	}, []);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		let cancelled = false;
		// Clear the previous language and its diagnostics together. A slow earlier
		// import must never reconfigure a replacement document or a destroyed view.
		view.dispatch({ effects: languageCompartment.current.reconfigure([]) });
		void loadEditorLanguage(language).then(async (resolvedLanguage) => {
			if (cancelled || viewRef.current !== view) return;
			view.dispatch({ effects: languageCompartment.current.reconfigure(resolvedLanguage ?? []) });
			const isJson = resolvedLanguage !== null && "language" in resolvedLanguage &&
				resolvedLanguage.language.name === "json";
			if (isJson) {
				const { jsonParseLinter } = await import("@codemirror/lang-json");
				if (cancelled || viewRef.current !== view) return;
				const jsonLinter: Extension = linter(jsonParseLinter());
				view.dispatch({ effects: languageCompartment.current.reconfigure([resolvedLanguage, lintGutter(), jsonLinter]) });
			}
		}).catch(() => {
			// A failed optional language/diagnostic import keeps the readable document.
			// loadEditorLanguage evicts failures so a later open can retry.
		});
		return () => { cancelled = true; };
	}, [language]);

	useEffect(() => {
		viewRef.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)) });
	}, [readOnly]);

	// 外部 value 同步：只在文档确实不同时替换（防止覆盖用户输入、防止 onChange 回环）
	useEffect(() => {
		const view = viewRef.current;
		if (!view || view.state.doc.toString() === value) return;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: value },
			annotations: [externalValueChange.of(true), Transaction.addToHistory.of(false)],
		});
	}, [value]);

	return <div ref={hostRef} style={{ height, minHeight: 60 }} className="codemirror-host" onContextMenu={handleContextMenu}>
		{/* 引用选中内容：虚拟锚点钉在右键坐标上（与 FileContextMenu 同模式，Radix 处理视口碰撞/ESC） */}
		{selectionMenu && (
			<DropdownMenu open onOpenChange={(open) => { if (!open) setSelectionMenu(null); }}>
				<DropdownMenuTrigger
					aria-hidden
					tabIndex={-1}
					style={{
						position: "fixed",
						left: selectionMenu.x,
						top: selectionMenu.y,
						width: 0,
						height: 0,
						padding: 0,
						border: 0,
						background: "transparent",
						pointerEvents: "none",
					}}
				/>
				<DropdownMenuContent align="start" side="bottom" className="min-w-44">
					<DropdownMenuItem
						onSelect={() => {
							const menu = selectionMenu;
							setSelectionMenu(null);
							onAttachSelectionRef.current?.(menu.startLine, menu.endLine);
						}}
					>
						{t("editor.attachSelectionRange", {
							range: selectionMenu.startLine === selectionMenu.endLine
								? String(selectionMenu.startLine)
								: `${selectionMenu.startLine}-${selectionMenu.endLine}`,
						})}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		)}
	</div>;
});
