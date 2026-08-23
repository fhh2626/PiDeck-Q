/**
 * Composer 纯文本粘贴：把剪贴板字符串转为 ProseMirror Slice 一次性替换选区，
 * 不走 TipTap 的 HTML 解析，避免 &amp; / mention 标签把正文搅乱。
 */

import type { Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

export type ComposerPlainInsertStep =
	| { type: "text"; text: string }
	| { type: "hardBreak" };

/**
 * 将任意剪贴板纯文本规范成编辑器可插入的步骤（兼容/测试导出）。
 * Windows \r\n 收成 \n；空行保留为连续 hardBreak（与 plainTextCodec 一致）。
 */
export function composerPlainTextInsertSteps(text: string): ComposerPlainInsertStep[] {
	const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const steps: ComposerPlainInsertStep[] = [];
	for (let i = 0; i < parts.length; i++) {
		if (i > 0) steps.push({ type: "hardBreak" });
		if (parts[i]) steps.push({ type: "text", text: parts[i] });
	}
	return steps;
}

/**
 * 将纯文本转换为 ProseMirror Node 数组（text + hardBreak 节点）。
 */
export function composerPlainTextToNodes(schema: Schema, text: string): ProseMirrorNode[] {
	const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const nodes: ProseMirrorNode[] = [];
	const hardBreak = schema.nodes.hardBreak;
	for (let i = 0; i < parts.length; i++) {
		if (i > 0 && hardBreak) {
			nodes.push(hardBreak.create());
		}
		const part = parts[i];
		if (part) {
			nodes.push(schema.text(part));
		}
	}
	return nodes;
}

/**
 * 将纯文本构造成单次替换所需的 ProseMirror Slice。
 */
export function composerPlainTextToSlice(schema: Schema, text: string): Slice {
	const nodes = composerPlainTextToNodes(schema, text);
	return new Slice(Fragment.fromArray(nodes), 0, 0);
}

/** 在当前选区插入纯文本（单次 replaceSelection 替换选区，光标落在插入末尾）。 */
export function insertComposerPlainText(view: EditorView, text: string): void {
	const slice = composerPlainTextToSlice(view.state.schema, text);
	const tr = view.state.tr.replaceSelection(slice).scrollIntoView();
	view.dispatch(tr);
}

/** 右键菜单等只有 Editor 实例时的入口。 */
export function insertComposerPlainTextFromEditor(editor: Editor, text: string): void {
	if (!text || editor.isDestroyed) return;
	insertComposerPlainText(editor.view, text);
}
