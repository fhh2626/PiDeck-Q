/**
 * Composer 编辑器对外契约（与具体实现解耦）。
 * TipTap / 旧 contentEditable 都应实现同一 props；草稿真相永远是 string。
 */

import type {
	ClipboardEvent,
	DragEvent,
	FocusEvent,
	KeyboardEvent,
	MutableRefObject,
} from "react";
import type { ComposerChip } from "./chips";

export type { ComposerChip };

/**
 * 程序化光标请求：`pos` 是纯文本偏移，`forValue` 是本次变更后的草稿文本。
 * 写入方必须与 `setDraft(forValue)` 在同一 tick 写入；编辑器只在内容同步到
 * `forValue` 的同一趟 layout pass 消费，不匹配的请求视为过期并丢弃——
 * 这保证光标永远只作用于它所属的那次变更，不会被后续输入误用。
 */
export type ComposerCaretRequest = { pos: number; forValue: string };

export type ComposerEditorProps = {
	value: string;
	onChange: (value: string, cursor: number) => void;
	/** TipTap 真实文本输入（不含 paste），用于创建显式 completion session。 */
	onTextInput?: (text: string) => void;
	onCursorChange: (cursor: number) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
	onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
	/** 右键「粘贴」：返回 true 表示已消费剪贴板（图片/文件路径）；false 表示纯文本，交给编辑器插入 */
	onPasteClipboard?: () => Promise<boolean>;
	onDrop?: (event: DragEvent<HTMLDivElement>) => void;
	onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
	onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
	onBlur?: (event: FocusEvent<HTMLDivElement>) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	/** 程序化变更的光标请求；消费（或判定过期丢弃）后应置回 null */
	caretRef?: MutableRefObject<ComposerCaretRequest | null>;
	onChipClick?: (chip: ComposerChip) => void;
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
	validSessionRefs?: Set<string>;
};
