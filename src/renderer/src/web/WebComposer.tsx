/**
 * WebComposer — Web 端消息输入区（与桌面 ComposerArea 的 composer-box 同风格）。
 *
 * 复用桌面 .composer / .composer-box 样式类 + shadcn Button：
 * - textarea 由 .composer textarea 统一样式（透明底、内边距、随内容撑高）
 * - Enter 发送、Shift/Ctrl+Enter 换行
 * - 无会话时禁用；忙碌期间提交按钮转为停止（useChat 流式或 runtime 权威忙碌）
 */
import { useRef, useState } from "react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { isComposingKeyboardEvent } from "../composerBehavior";

export function WebComposer(props: {
	disabled: boolean;
	busy: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
}) {
	const [draft, setDraft] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	const submit = () => {
		const text = draft.trim();
		if (!text || props.disabled || props.busy) return;
		props.onSend(text);
		setDraft("");
	};

	return (
		<form
			className="composer w-full min-w-0 shrink-0 flex-col gap-2 bg-background px-3 pb-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="composer-box relative flex min-h-[7rem] min-w-0 flex-col overflow-visible rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow,background-color]">
				<textarea
					id="prompt"
					ref={textareaRef}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={t("web.promptPlaceholder")}
					disabled={props.disabled}
					onKeyDown={(event) => {
						if (isComposingKeyboardEvent(event)) return;
						if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
							event.preventDefault();
							submit();
						}
					}}
					aria-label={t("web.promptPlaceholder")}
				/>
				<div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2.5">
					<span className="composer-hint min-w-0 truncate text-caption text-muted-foreground">
						{t("web.composerHint")}
					</span>
					{props.busy ? (
						<Button
							type="button"
							variant="destructive"
							size="sm"
							className="h-8 shrink-0"
							onClick={props.onStop}
						>
							{t("app.stop")}
						</Button>
					) : (
						<Button
							type="submit"
							size="sm"
							className="h-8 shrink-0"
							disabled={props.disabled || !draft.trim()}
						>
							{t("app.send")}
						</Button>
					)}
				</div>
			</div>
		</form>
	);
}
