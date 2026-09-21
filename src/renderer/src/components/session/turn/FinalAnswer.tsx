import { memo, type RefObject } from "react";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Textarea } from "../../ui-shadcn/textarea";
import { AssistantText } from "../SurfaceComponents";

/**
 * 最终回答段：本轮最后一条 assistant 文本，常驻、永不折叠。
 * 承载原地编辑 UI（编辑入口在 run 操作栏，编辑表单内联在此）。
 */
export const FinalAnswer = memo(function FinalAnswer(props: {
	message: ChatMessage;
	images?: ImageContent[];
	isStreaming?: boolean;
	/** live→settled 交接淡入 */
	settle?: boolean;
	/** 编辑态 */
	editing: boolean;
	editText: string;
	editAreaRef: RefObject<HTMLDivElement | null>;
	onEditTextChange: (text: string) => void;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onSaveEdit: () => void;
	onPreviewImage: (image: ImageContent, images?: ImageContent[]) => void;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	if (props.editing) {
		return (
			<div
				className="flex flex-col gap-2 rounded-md border border-border-subtle bg-[color:color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg-panel))] pl-2"
				ref={props.editAreaRef}
			>
				<div className="flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] before:content-['✎'] before:text-sm">
					{t("common.edit")}
				</div>
				<Textarea
					className="min-h-[100px] max-h-[400px] w-full resize-y rounded-sm border border-[var(--color-accent)] bg-bg-panel p-2 font-mono text-sm leading-relaxed text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_2px_var(--focus-ring)]"
					value={props.editText}
					onChange={(e) => props.onEditTextChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							props.onSaveEdit();
						}
						if (e.key === "Escape") props.onCancelEdit();
					}}
					autoFocus
				/>
				<div className="flex justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						className="h-auto border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] shadow-none hover:text-[var(--color-accent)]"
						onClick={props.onSaveEdit}
					>
						{t("common.save")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-auto px-3 py-1 text-xs shadow-none"
						onClick={props.onCancelEdit}
					>
						{t("common.cancel")}
					</Button>
				</div>
			</div>
		);
	}
	return (
		<AssistantText
			text={props.message.text}
			images={props.images}
			onPreviewImage={props.onPreviewImage}
			onOpenExternal={props.onOpenExternal}
			onOpenFile={props.onOpenFile}
			isStreaming={props.isStreaming ?? false}
			settle={props.settle}
		/>
	);
});
