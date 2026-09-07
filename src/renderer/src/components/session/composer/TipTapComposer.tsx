/**
 * TipTapComposer —— 会话输入框视图壳。
 * 编辑器生命周期见 useTipTapComposerEditor；本文件只做 ref / 焦点壳 / EditorContent /
 * 右键粘贴菜单（纯文本粘贴 / 原样粘贴）。
 */

import { forwardRef, useRef } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { ClipboardPaste } from "lucide-react";
import type { ComposerEditorProps } from "./types";
import { useTipTapComposerEditor } from "./useTipTapComposerEditor";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui-shadcn/context-menu";
import { htmlToPlainText, readClipboardHtmlConsistent, readClipboardText } from "../../../utils/clipboard";
import { insertComposerPlainTextFromEditor } from "./tiptap/insertComposerPlainText";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";

export type TipTapComposerProps = ComposerEditorProps;

/**
 * 右键粘贴：始终落到纯文本。
 * 即便 HTML 与 text 槽同源，也不走 TipTap HTML 插入——mention chip / &amp;
 * 会被 TipTap 解析成原子节点或重复 &，后续每个按键再同步一次就「输入一个字多一个 &」。
 * 同源 HTML 只用来还原换行结构（htmlToPlainText），再按纯文本插入。
 */
function insertClipboard(editor: Editor) {
  const text = readClipboardText();
  const html = readClipboardHtmlConsistent();
  const payload = html ? htmlToPlainText(html) : text;
  if (!payload) return;
  insertComposerPlainTextFromEditor(editor, payload);
}

export const TipTapComposer = forwardRef<HTMLDivElement, TipTapComposerProps>(
	function TipTapComposer(props, ref) {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const setHostRef = (node: HTMLDivElement | null) => {
			hostRef.current = node;
			if (typeof ref === "function") ref(node);
			else if (ref) ref.current = node;
		};

		const editor = useTipTapComposerEditor({
			...props,
			hostRef,
		});

		return (
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						ref={setHostRef}
						// overflow-hidden：把滚动关进 ProseMirror；否则 EditorContent 中间层
						// 不传高度约束时，内容会直接撑出 composer-box。
						className="tiptap-composer-host flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
						data-placeholder={props.placeholder}
						onFocus={props.onFocus}
						onBlur={props.onBlur}
					>
						<EditorContent
							editor={editor}
							className="tiptap-composer-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
						/>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent alignOffset={-6}>
					<ContextMenuItem
						onSelect={() => {
							if (!editor) return;
							void (async () => {
								try {
									// 图片/文件路径由 controller 统一处理（与 Ctrl+V 同一优先级链）；
									// 纯文本返回 false，走本地纯文本插入（不解析 HTML）
									const handled = await props.onPasteClipboard?.();
									if (!handled) insertClipboard(editor);
								} catch (error) {
									// Clipboard providers are asynchronous; a timeout must not become
									// an unhandled rejection or skip the menu's focus cleanup.
									showNotice(error instanceof Error ? error.message : String(error), 3000);
								} finally {
									// 菜单点击会让编辑器失焦，无论哪条路径都恢复焦点保证后续输入/光标可见
									editor.commands.focus();
								}
							})();
						}}
					>
						<ClipboardPaste size={13} strokeWidth={2} aria-hidden="true" />
						{t("common.paste")}
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		);
	},
);
