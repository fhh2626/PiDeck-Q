/**
 * Web 顶栏上下文控制：保留最近 N 条数字框 + 两个 Checkbox（文件/命令）。
 * 状态以会话 JSONL 快照为准；乐观更新期间不让轮询盖掉本地选择。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { Checkbox } from "@/components/ui-shadcn/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui-shadcn/tooltip";
import {
	applyLocalSwitch,
	DEFAULT_SWITCH_STATE,
	isKeepRecentApplicable,
	type ContextSwitchState,
} from "../components/session/ContextControllerSwitches";
import { fetchContextControllerState, sendContextControllerCommand } from "./webApi";
import type { WebHeaderStatus } from "./WebHeader";

const POLL_MS = 4000;

function commandForKey(key: "fileContent" | "commandOutput", include: boolean): string {
	const flag = include ? "on" : "off";
	if (key === "fileContent") return `/context-files ${flag}`;
	return `/context-commands ${flag}`;
}

function toSwitchState(res: {
	clearReadContent: boolean;
	clearCommandContent: boolean;
	keepRecentCount?: number;
}): ContextSwitchState {
	return {
		fileContent: !res.clearReadContent,
		commandOutput: !res.clearCommandContent,
		keepRecent: typeof res.keepRecentCount === "number" ? res.keepRecentCount : 10,
	};
}

export function WebContextChecks(props: {
	sessionId: string;
	status: WebHeaderStatus;
}) {
	const { sessionId, status } = props;
	const [state, setState] = useState<ContextSwitchState>(DEFAULT_SWITCH_STATE);
	const [error, setError] = useState<string | null>(null);
	const pendingRef = useRef(false);
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;

	const busy = status === "running" || status === "starting";
	const disabled = !sessionId || busy;

	const loadState = useCallback(async (id: string) => {
		if (!id || pendingRef.current) return;
		try {
			const snapshot = await fetchContextControllerState(id);
			if (sessionIdRef.current !== id || pendingRef.current) return;
			setState(toSwitchState(snapshot));
		} catch {
			// 读失败保持当前本地态，避免把用户刚拨的开关弹回去
		}
	}, []);

	useEffect(() => {
		pendingRef.current = false;
		setError(null);
		if (!sessionId) {
			setState(DEFAULT_SWITCH_STATE);
			return;
		}
		setState(DEFAULT_SWITCH_STATE);
		void loadState(sessionId);
	}, [sessionId, loadState]);

	// 桌面端改动后，Web 靠 JSONL 轮询跟上；本地乐观更新期间跳过，防止闪回。
	useEffect(() => {
		if (!sessionId) return;
		const timer = window.setInterval(() => {
			void loadState(sessionId);
		}, POLL_MS);
		return () => window.clearInterval(timer);
	}, [sessionId, loadState]);

	const sendCommand = useCallback(async (command: string, next: ContextSwitchState) => {
		if (disabled || !sessionId) return;
		const prev = state;
		setState(next);
		setError(null);
		pendingRef.current = true;
		try {
			const result = await sendContextControllerCommand(sessionId, command);
			if (sessionIdRef.current !== sessionId) return;
			if (!result.accepted) {
				setState(prev);
				setError(result.error || t("ctx.switches.pluginDisabled"));
			}
		} catch (cause) {
			if (sessionIdRef.current !== sessionId) return;
			setState(prev);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (sessionIdRef.current === sessionId) pendingRef.current = false;
		}
	}, [disabled, sessionId, state]);

	const toggle = useCallback((key: "fileContent" | "commandOutput", include: boolean) => {
		const next = applyLocalSwitch(state, key, include);
		void sendCommand(commandForKey(key, include), next);
	}, [sendCommand, state]);

	const setKeepRecent = useCallback((count: number) => {
		const next = { ...state, keepRecent: count };
		void sendCommand(`/context-keep ${count}`, next);
	}, [sendCommand, state]);

	const disabledReason = !sessionId
		? t("web.chooseSession")
		: busy
			? t("ctx.switches.busyDisabled")
			: undefined;

	const keepRecentDisabled = disabled || !isKeepRecentApplicable(state);
	const keepRecentDisabledReason =
		disabledReason ??
		(!isKeepRecentApplicable(state) ? t("ctx.switches.keepRecentAllKeptReason") : undefined);

	return (
		<div className="chat-context-checks flex min-w-0 flex-wrap items-center gap-2">
			<WebKeepSpinBox
				value={state.keepRecent}
				disabled={keepRecentDisabled}
				disabledReason={keepRecentDisabledReason}
				onChange={setKeepRecent}
			/>
			<ContextCheck
				label={t("ctx.switches.fileContent")}
				tooltip={t("ctx.switches.fileContentTooltip")}
				checked={state.fileContent}
				disabled={disabled}
				disabledReason={disabledReason}
				onToggle={(next) => void toggle("fileContent", next)}
			/>
			<ContextCheck
				label={t("ctx.switches.commandOutput")}
				tooltip={t("ctx.switches.commandOutputTooltip")}
				checked={state.commandOutput}
				disabled={disabled}
				disabledReason={disabledReason}
				onToggle={(next) => void toggle("commandOutput", next)}
			/>
			{error ? (
				<span className="max-w-40 truncate text-micro text-destructive" title={error}>
					{error}
				</span>
			) : null}
		</div>
	);
}

function WebKeepSpinBox(props: {
	value: number;
	disabled: boolean;
	disabledReason?: string;
	onChange: (next: number) => void;
}) {
	const [text, setText] = useState(() => String(props.value));

	useEffect(() => {
		setText(String(props.value));
	}, [props.value]);

	const commit = useCallback(() => {
		if (props.disabled) {
			setText(String(props.value));
			return;
		}
		const parsed = Number(text.trim());
		const clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(99, Math.floor(parsed))) : props.value;
		setText(String(clamped));
		if (clamped !== props.value) {
			props.onChange(clamped);
		}
	}, [props, text]);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<label className={`flex shrink-0 items-center gap-1 text-caption text-muted-foreground select-none ${props.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
					<span className="whitespace-nowrap">{t("ctx.switches.keepRecent")}</span>
					<input
						type="number"
						min={0}
						max={99}
						step={1}
						disabled={props.disabled}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onBlur={commit}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								commit();
								e.currentTarget.blur();
							}
						}}
						onClick={(e) => e.stopPropagation()}
						className="h-5 w-9 [appearance:textfield] rounded border border-input bg-transparent px-0.5 text-center text-caption font-medium tabular-nums shadow-2xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
						aria-label={t("ctx.switches.keepRecentTooltip")}
					/>
					<span className="whitespace-nowrap">{t("ctx.switches.keepRecentUnit")}</span>
				</label>
			</TooltipTrigger>
			<TooltipContent side="bottom" align="end" className="max-w-72">
				{props.disabledReason ?? (
					<div className="grid gap-1">
						<div>{t("ctx.switches.keepRecentTooltip")}</div>
						<div className="border-t border-border/60 pt-1 text-micro text-muted-foreground">
							{t("ctx.switches.nextTurnNote")}
						</div>
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}

function ContextCheck(props: {
	label: string;
	tooltip: string;
	checked: boolean;
	disabled: boolean;
	disabledReason?: string;
	onToggle: (next: boolean) => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					className={`flex shrink-0 items-center gap-1 whitespace-nowrap text-caption text-muted-foreground select-none ${
						props.disabled ? "cursor-not-allowed" : "cursor-pointer"
					}`}
					onClick={() => {
						if (!props.disabled) props.onToggle(!props.checked);
					}}
				>
					<Checkbox
						checked={props.checked}
						disabled={props.disabled}
						onCheckedChange={(value) => {
							if (props.disabled) return;
							props.onToggle(value === true);
						}}
						onClick={(event) => event.stopPropagation()}
						className="size-3.5 min-w-3.5"
						aria-label={props.tooltip}
					/>
					<span className={`whitespace-nowrap ${props.disabled ? "opacity-50" : ""}`}>{props.label}</span>
				</div>
			</TooltipTrigger>
			<TooltipContent side="bottom" align="end" className="max-w-72">
				{props.disabledReason ?? (
					<div className="grid gap-1">
						<div>{props.tooltip}</div>
						{!props.checked && (
							<div className="border-t border-border/60 pt-1 text-micro text-muted-foreground">
								{t("ctx.switches.nextTurnNote")}
							</div>
						)}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}
