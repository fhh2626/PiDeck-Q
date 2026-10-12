/**
 * WebComposer — Web 端消息输入区（与桌面 ComposerArea 的 composer-box 同风格）。
 *
 * 复用桌面 .composer / .composer-box 样式类 + shadcn Button：
 * - textarea 由 .composer textarea 统一样式（透明底、内边距、随内容撑高）
 * - Enter 发送、Shift/Ctrl+Enter 换行
 * - 无会话时禁用；忙碌期间提交按钮转为停止（useChat 流式或 runtime 权威忙碌）
 * - textarea 非受控：正文只存在 DOM 里，React 只记录“是否有内容”。受控 textarea 每次按键都会
 *   改写 defaultValue（即 textarea 的子文本节点），只要样式表里有任何 :has() 规则，Chromium
 *   就会因此重算整页样式；长会话里每个按键 70ms+。
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { isComposingKeyboardEvent } from "../composerBehavior";

export function WebComposer(props: {
	disabled: boolean;
	busy: boolean;
	onSend: (text: string) => void;
	onStop: () => void;
}) {
	// 只在“空 ↔ 非空”切换时更新，普通按键不触发重渲染。
	const [hasText, setHasText] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	// 非受控时 DOM 可能已有内容（浏览器表单恢复等），挂载后按实际内容同步一次发送按钮状态。
	useEffect(() => {
		setHasText(Boolean(textareaRef.current?.value.trim()));
	}, []);

	const submit = () => {
		const textarea = textareaRef.current;
		const text = textarea?.value.trim() ?? "";
		if (!text || props.disabled || props.busy) return;
		props.onSend(text);
		if (textarea) textarea.value = "";
		setHasText(false);
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
					defaultValue=""
					onChange={(event) => setHasText(event.target.value.trim().length > 0)}
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
							disabled={props.disabled || !hasText}
						>
							{t("app.send")}
						</Button>
					)}
				</div>
			</div>
		</form>
	);
}
