import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText, Terminal } from "lucide-react";
import {
	contextControllerSettingsAtom,
	sessionRuntimeBySessionIdAtomFamily,
	sessionRuntimeUiBySessionIdAtomFamily,
	sessionSendStateByIdAtom,
} from "../../atoms";
import { isUserFacingSessionStart } from "../../hooks/useSessionTimelineController";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Switch } from "../ui-shadcn/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";

export type ContextSwitchState = {
	fileContent: boolean;
	commandOutput: boolean;
	keepRecent: number;
};

export const DEFAULT_SWITCH_STATE: ContextSwitchState = {
	fileContent: true,
	commandOutput: true,
	keepRecent: 10,
};

/**
 * 从 CTX widget 文本行解析当前开/关状态与保留窗口。
 * 行契约：
 *   "Keep recent 10"
 *   "File content ON" | "File content OFF"
 *   "Command output ON" | "Command output OFF"
 */
export function parseSwitchStateFromWidgetLines(lines?: readonly string[]): ContextSwitchState | null {
	if (!lines || lines.length === 0) return null;
	let fileContent: boolean | null = null;
	let commandOutput: boolean | null = null;
	let keepRecent: number | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		const upper = trimmed.toUpperCase();
		if (upper === "FILE CONTENT ON") fileContent = true;
		else if (upper === "FILE CONTENT OFF") fileContent = false;
		else if (upper === "COMMAND OUTPUT ON") commandOutput = true;
		else if (upper === "COMMAND OUTPUT OFF") commandOutput = false;
		else {
			const keepMatch = trimmed.match(/^Keep\s+recent\s+(\d+)$/i);
			if (keepMatch) {
				const num = Number(keepMatch[1]);
				if (Number.isFinite(num)) keepRecent = Math.max(0, Math.min(99, Math.floor(num)));
			}
		}
	}

	if (fileContent != null && commandOutput != null) {
		return { fileContent, commandOutput, keepRecent: keepRecent ?? 10 };
	}
	return null;
}

/**
 * 从 CTX widget 文本行解析当前估算的节省量。
 * 行契约：
 *   "Saved ~10k (83%)"
 */
export function parseSavedEstimateFromWidgetLines(lines?: readonly string[]): string | null {
	if (!lines || lines.length === 0) return null;
	for (const line of lines) {
		const match = line.trim().match(/^Saved\s+(.+)$/i);
		if (match && match[1]) {
			return match[1].trim();
		}
	}
	return null;
}

export function applyLocalSwitch(
	state: ContextSwitchState,
	key: "fileContent" | "commandOutput",
	include: boolean,
): ContextSwitchState {
	return { ...state, [key]: include };
}

/** 只有至少一类旧工具内容会被裁剪时，保留窗口才影响上下文。 */
export function isKeepRecentApplicable(state: ContextSwitchState): boolean {
	return !state.fileContent || !state.commandOutput;
}

function commandForKey(key: "fileContent" | "commandOutput", include: boolean): string {
	const flag = include ? "on" : "off";
	if (key === "fileContent") return `/context-files ${flag}`;
	return `/context-commands ${flag}`;
}

function ContextKeepSpinBox(props: {
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
				<label className={`flex items-center gap-1 text-xs text-muted-foreground select-none ${props.disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
					<span className="text-caption font-medium whitespace-nowrap">{t("ctx.switches.keepRecent")}</span>
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
					<span className="text-caption font-medium whitespace-nowrap">{t("ctx.switches.keepRecentUnit")}</span>
				</label>
			</TooltipTrigger>
			<TooltipContent side="bottom" align="end" className="max-w-72">
				{props.disabledReason ?? (
					<div className="grid gap-1">
						<div>{t("ctx.switches.keepRecentTooltip")}</div>
						<div className="border-t border-border/60 pt-1 text-muted-foreground text-micro">
							{t("ctx.switches.nextTurnNote")}
						</div>
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}

function ContextSwitchRow(props: {
	icon: ReactNode;
	label: string;
	tooltip: string;
	checked: boolean;
	disabled: boolean;
	disabledReason?: string;
	savedEstimate: string | null;
	onToggle: (next: boolean) => void;
}) {
	const rowClass = `flex items-center gap-1 text-xs text-muted-foreground select-none ${
		props.disabled ? "cursor-not-allowed" : "cursor-pointer"
	}`;
	const labelClass = `flex items-center gap-1 ${props.disabled ? "opacity-50" : ""}`;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div
					onClick={() => {
						if (!props.disabled) props.onToggle(!props.checked);
					}}
					className={rowClass}
				>
					<span className={labelClass}>
						{props.icon}
						<span className="text-caption font-medium whitespace-nowrap">{props.label}</span>
					</span>
					<Switch
						size="sm"
						disabled={props.disabled}
						checked={props.checked}
						onCheckedChange={props.onToggle}
						onClick={(e) => e.stopPropagation()}
						aria-label={props.tooltip}
					/>
				</div>
			</TooltipTrigger>
			<TooltipContent side="bottom" align="end" className="max-w-72">
				{props.disabledReason ? (
					props.disabledReason
				) : (
					<div className="grid gap-1">
						<div>{props.tooltip}</div>
						{!props.checked && (
							<div className="border-t border-border/60 pt-1 text-muted-foreground text-micro">
								{props.savedEstimate ? (
									<div className="font-semibold text-primary">
										{t("ctx.switches.savedEstimate", { saved: props.savedEstimate })}
									</div>
								) : null}
								<div>{t("ctx.switches.nextTurnNote")}</div>
							</div>
						)}
					</div>
				)}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * 会话头部右上角的上下文控制器开关组。
 * 挂载在官方上下文统计（SessionStatus）的左侧。
 */
export function ContextControllerSwitches(props: { sessionId: string }) {
	const { sessionId } = props;
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId));
	const extSettings = useAtomValue(contextControllerSettingsAtom);

	const sendStateSelector = useMemo(
		() => selectAtom(
			sessionSendStateByIdAtom,
			(states) => states[sessionId],
			Object.is,
		),
		[sessionId],
	);
	const sendState = useAtomValue(sendStateSelector);

	const isPluginDisabled =
		extSettings.piRpcNoExtensions ||
		extSettings.removedBuiltInExtensions.includes("pideck-q-context-controller.ts");

	const isBusy = runtime?.status === "running" || isUserFacingSessionStart(sendState?.status);

	const widgetLines = runtimeUi?.widgets?.["pi-deck-context-controller"];
	const widgetState = useMemo(() => parseSwitchStateFromWidgetLines(widgetLines), [widgetLines]);
	const savedEstimate = useMemo(() => parseSavedEstimateFromWidgetLines(widgetLines), [widgetLines]);

	const [persistedState, setPersistedState] = useState<ContextSwitchState>(DEFAULT_SWITCH_STATE);
	const [pendingState, setPendingState] = useState<ContextSwitchState | null>(null);

	useEffect(() => {
		let cancelled = false;
		if (!sessionId) return;
		setPersistedState(DEFAULT_SWITCH_STATE);
		setPendingState(null);

		void desktopApi.sessions.getContextControllerState(sessionId)
			.then((res) => {
				if (cancelled || !res) return;
				setPersistedState({
					fileContent: !res.clearReadContent,
					commandOutput: !res.clearCommandContent,
					keepRecent: typeof res.keepRecentCount === "number" ? res.keepRecentCount : 10,
				});
			})
			.catch(() => {
				// 历史读取失败时保守保持默认值
			});

		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	useEffect(() => {
		if (!pendingState || !widgetState) return;
		if (
			widgetState.fileContent === pendingState.fileContent &&
			widgetState.commandOutput === pendingState.commandOutput &&
			widgetState.keepRecent === pendingState.keepRecent
		) {
			setPendingState(null);
		}
	}, [pendingState, widgetState]);

	const currentState = pendingState ?? widgetState ?? persistedState;

	const sendSilentCommand = useCallback(async (command: string, nextState: ContextSwitchState) => {
		if (isBusy || isPluginDisabled || !sessionId) return;
		const prev = currentState;
		setPendingState(nextState);
		setPersistedState(nextState);

		try {
			const result = await desktopApi.sessions.sendPrompt({
				sessionId,
				requestId: crypto.randomUUID(),
				message: "",
				agentMessage: command,
				silent: true,
			});
			if (!result.accepted) {
				setPendingState(null);
				setPersistedState(prev);
				showNotice(result.error || t("ctx.switches.pluginDisabled"), 3000, "error");
			}
		} catch (error) {
			setPendingState(null);
			setPersistedState(prev);
			const message = error instanceof Error ? error.message : String(error);
			showNotice(message, 3000, "error");
		}
	}, [currentState, isBusy, isPluginDisabled, sessionId]);

	const toggleSwitch = useCallback((key: "fileContent" | "commandOutput", include: boolean) => {
		const next = applyLocalSwitch(currentState, key, include);
		void sendSilentCommand(commandForKey(key, include), next);
	}, [currentState, sendSilentCommand]);

	const setKeepRecent = useCallback((count: number) => {
		const next = { ...currentState, keepRecent: count };
		void sendSilentCommand(`/context-keep ${count}`, next);
	}, [currentState, sendSilentCommand]);

	const disabled = isPluginDisabled || isBusy;
	const disabledReason = isPluginDisabled
		? t("ctx.switches.pluginDisabled")
		: isBusy
			? t("ctx.switches.busyDisabled")
			: undefined;

	const keepRecentDisabled = disabled || !isKeepRecentApplicable(currentState);
	const keepRecentDisabledReason =
		disabledReason ??
		(!isKeepRecentApplicable(currentState) ? t("ctx.switches.keepRecentAllKeptReason") : undefined);

	return (
		<div className="flex min-w-0 shrink items-center justify-end gap-2 overflow-hidden pr-1">
			<ContextKeepSpinBox
				value={currentState.keepRecent}
				disabled={keepRecentDisabled}
				disabledReason={keepRecentDisabledReason}
				onChange={setKeepRecent}
			/>
			<ContextSwitchRow
				icon={<FileText size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
				label={t("ctx.switches.fileContent")}
				tooltip={t("ctx.switches.fileContentTooltip")}
				checked={currentState.fileContent}
				disabled={disabled}
				disabledReason={disabledReason}
				savedEstimate={savedEstimate}
				onToggle={(next) => void toggleSwitch("fileContent", next)}
			/>
			<ContextSwitchRow
				icon={<Terminal size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
				label={t("ctx.switches.commandOutput")}
				tooltip={t("ctx.switches.commandOutputTooltip")}
				checked={currentState.commandOutput}
				disabled={disabled}
				disabledReason={disabledReason}
				savedEstimate={savedEstimate}
				onToggle={(next) => void toggleSwitch("commandOutput", next)}
			/>
		</div>
	);
}
