/**
 * TipTap editorProps：把上层 Composer 回调桥成 ProseMirror DOM 事件。
 * 与 React 组件生命周期解耦，便于单测与复用。
 */

import type { EditorProps } from "@tiptap/pm/view";
import type { ComposerChip } from "../chips";
import { htmlToPlainText } from "../../../../utils/clipboard";
import { toComposerDomKeyboardEvent } from "./domEventBridge";
import { insertComposerPlainText } from "./insertComposerPlainText";

export type ComposerEditorDomHandlers = {
	composingRef: { current: boolean };
	onKeyDown?: (event: KeyboardEvent) => void;
	onTextInput?: (text: string) => void;
	onPaste?: (event: ClipboardEvent) => void;
	onDrop?: (event: DragEvent) => void;
	onDragOver?: (event: DragEvent) => void;
	onChipClick?: (chip: ComposerChip) => void;
};

function readChipFromDom(chipEl: HTMLElement): ComposerChip | null {
	const raw = chipEl.getAttribute("data-raw") ?? "";
	const kind = chipEl.getAttribute("data-type");
	if (kind !== "file" && kind !== "skill" && kind !== "session") return null;
	const label =
		chipEl.querySelector(".input-chip__label")?.textContent?.trim() || raw.slice(1);
	return { start: 0, end: raw.length, raw, kind, label };
}

export function buildComposerEditorProps(
	handlers: ComposerEditorDomHandlers,
	options: {
		className?: string;
		placeholder?: string;
		disabled?: boolean;
	},
): EditorProps {
	return {
		attributes: {
			class: ["rich-input", "ProseMirror", options.className].filter(Boolean).join(" "),
			role: "textbox",
			"aria-multiline": "true",
			...(options.placeholder ? { "data-placeholder": options.placeholder } : {}),
			...(options.disabled ? { "aria-disabled": "true" } : {}),
		},
		handleKeyDown: (_view, event) => {
			handlers.onKeyDown?.(toComposerDomKeyboardEvent(event));
			return event.defaultPrevented;
		},
		handleTextInput: (_view, _from, _to, text) => {
			if (!handlers.composingRef.current) handlers.onTextInput?.(text);
			return false;
		},
		handlePaste: (view, event) => {
			// 先给 controller：明确文件来源与位图由上层接管
			handlers.onPaste?.(event);
			if (event.defaultPrevented) return true;
			// 普通文本一律按纯文本插入。TipTap 默认会解析 text/html，
			// Windows 剪贴板残留的 &amp; / mention 标签会把正文搅成重复 & 或 chip。
			const text = event.clipboardData?.getData("text/plain") ?? "";
			const html = text ? "" : (event.clipboardData?.getData("text/html") ?? "");
			const payload = text || (html ? htmlToPlainText(html) : "");
			if (!payload) return false;
			event.preventDefault();
			insertComposerPlainText(view, payload);
			return true;
		},
		handleDOMEvents: {
			compositionstart: () => {
				handlers.composingRef.current = true;
				return false;
			},
			compositionend: () => {
				handlers.composingRef.current = false;
				return false;
			},
			dragover: (_view, event) => {
				handlers.onDragOver?.(event);
				return event.defaultPrevented;
			},
			drop: (_view, event) => {
				handlers.onDrop?.(event);
				return event.defaultPrevented;
			},
			click: (_view, event) => {
				if (!handlers.onChipClick) return false;
				const target = event.target as HTMLElement | null;
				const chipEl = target?.closest?.(".input-chip") as HTMLElement | null;
				if (!chipEl) return false;
				const chip = readChipFromDom(chipEl);
				if (!chip) return false;
				handlers.onChipClick(chip);
				return true;
			},
		},
	};
}
