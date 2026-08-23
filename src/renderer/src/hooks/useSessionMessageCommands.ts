import { useEffect, useRef, useState } from "react";
import type {
	AgentTab,
	ChatMessage,
	ImageContent,
	SessionRuntimeTarget,
} from "../../../shared/types";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { isSameSessionRuntimeTarget, requireSessionCommand } from "../utils/sessionCommands";
import type { HistoryMutationRefreshSnapshot } from "./useSessionTimelineController";

type SessionMessageCommandsInput = {
	activeAgentStatus: AgentTab["status"] | undefined;
	activeProjectId: string | undefined;
	agents: AgentTab[];
	isRuntimeTargetBusy: (target: SessionRuntimeTarget) => boolean;
	getRuntimeTargetForSession: (sessionId: string | undefined) => SessionRuntimeTarget | undefined;
	submitPromptSnapshot: (
		sessionId: string,
		message: string,
		images?: ImageContent[],
	) => Promise<boolean | "unknown">;
	openReplacedRuntimeSession: (
		projectId: string | undefined,
		targetSessionId: string | undefined,
	) => Promise<void>;
	currentSessionIdRef: { current: string | undefined };
	setPromptForAgent: (sessionId: string, text: string) => void;
	showToast: (message: string, duration?: number) => void;
	overlays: {
		showConfirm: (config: {
			title: string;
			message: string;
			onConfirm: () => void;
			danger?: boolean;
			confirmLabel?: string;
		}) => void;
		clearConfirm: () => void;
	};
	captureHistoryMutationRefresh?: (sessionId: string | undefined) => HistoryMutationRefreshSnapshot | null;
	refreshHistoryAfterMutation?: (snapshot: HistoryMutationRefreshSnapshot | null) => Promise<void>;
};

function translateAgentErrorMessage(message: string): string {
	if (message.startsWith("BUSY_STREAMING:")) return t("message.busyStreaming");
	if (message.startsWith("BUSY_TOOL:")) return t("message.busyTool");
	if (message.startsWith("BUSY_GENERIC:")) return t("message.busyGeneric");
	return message;
}

/** Owns user-message mutations and fork/resend guards for the active session. */
export function useSessionMessageCommands(input: SessionMessageCommandsInput) {
	const resendingIdsRef = useRef<Set<string>>(new Set());
	const resendTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
	const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);

	useEffect(() => {
		if (input.activeAgentStatus !== "running" && input.activeAgentStatus !== "starting") {
			resendingIdsRef.current.clear();
		}
	}, [input.activeAgentStatus]);

	useEffect(() => () => {
		for (const timer of resendTimersRef.current) clearTimeout(timer);
		resendTimersRef.current.clear();
	}, []);

	function requireCurrentRuntimeTarget(expectedTarget: SessionRuntimeTarget): SessionRuntimeTarget {
		const latest = input.getRuntimeTargetForSession(expectedTarget.sessionId);
		if (!isSameSessionRuntimeTarget(expectedTarget, latest) || !latest) {
			throw new Error(t("sessionCommand.runtimeChanged"));
		}
		return latest;
	}

	function resendUserMessage(expectedTarget: SessionRuntimeTarget, message: ChatMessage): void {
		if (message.agentId && message.agentId !== expectedTarget.agentId) return;
		if (resendingIdsRef.current.has(message.id)) return;

		let currentTarget: SessionRuntimeTarget;
		try {
			currentTarget = requireCurrentRuntimeTarget(expectedTarget);
		} catch (error) {
			input.showToast(error instanceof Error ? error.message : String(error), 5000);
			return;
		}

		resendingIdsRef.current.add(message.id);
		const timer = setTimeout(() => {
			resendingIdsRef.current.delete(message.id);
			resendTimersRef.current.delete(timer);
		}, 30_000);
		resendTimersRef.current.add(timer);
		void api.sessions.prepareRuntimeResend(currentTarget, message.id)
			.then((result) => requireSessionCommand(result).value)
			// resend 是两阶段操作：prepare（旧 target 上完成文件 mutation）→ 重新提交。
			// 提交前必须重新校验 target：prepare 期间 runtime 可能已被替换，
			// submitPromptSnapshot 只带 sessionId 会把旧消息投递到新 generation runtime。
			.then((snapshot) => {
				requireCurrentRuntimeTarget(currentTarget);
				return input.submitPromptSnapshot(currentTarget.sessionId, snapshot.text, snapshot.images);
			})
			.catch((error) => input.showToast(error instanceof Error ? error.message : String(error), 5000));
	}

	async function editMessage(expectedTarget: SessionRuntimeTarget, messageId: string, newText: string): Promise<void> {
		try {
			const currentTarget = requireCurrentRuntimeTarget(expectedTarget);
			const refreshSnapshot = input.captureHistoryMutationRefresh?.(currentTarget.sessionId) ?? null;
			requireSessionCommand(await api.sessions.editRuntimeMessage(currentTarget, messageId, newText));
			if (refreshSnapshot && input.refreshHistoryAfterMutation) {
				await input.refreshHistoryAfterMutation(refreshSnapshot);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			input.showToast(`${t("message.editFailed")}: ${translateAgentErrorMessage(message)}`, 5000);
		}
	}

	function deleteMessage(expectedTarget: SessionRuntimeTarget, messageId: string): void {
		input.overlays.showConfirm({
			title: t("message.deleteTitle"),
			message: t("message.deleteReloadPrompt"),
			danger: true,
			confirmLabel: t("common.delete"),
			onConfirm: async () => {
				input.overlays.clearConfirm();
				try {
					const currentTarget = requireCurrentRuntimeTarget(expectedTarget);
					const refreshSnapshot = input.captureHistoryMutationRefresh?.(currentTarget.sessionId) ?? null;
					requireSessionCommand(await api.sessions.deleteRuntimeMessage(currentTarget, messageId));
					if (refreshSnapshot && input.refreshHistoryAfterMutation) {
						await input.refreshHistoryAfterMutation(refreshSnapshot);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					input.showToast(`${t("message.deleteFailed")}: ${translateAgentErrorMessage(message)}`, 5000);
				}
			},
		});
	}

	async function resolveForkEntryId(target: SessionRuntimeTarget, message: ChatMessage): Promise<string | undefined> {
		if (typeof message.meta?.entryId === "string" && message.meta.entryId) return message.meta.entryId;
		const historyPrefix = `${target.agentId}-history-`;
		if (message.id.startsWith(historyPrefix)) {
			const fromId = message.id.slice(historyPrefix.length).trim();
			if (fromId && fromId !== String(message.meta?._piDeckMsgSeq ?? "") && !/^\d+$/.test(fromId)) {
				return fromId;
			}
		}
		const forkMessages = requireSessionCommand(await api.sessions.getRuntimeForkMessages(target)).value;
		const targetText = message.text.trim();
		if (!targetText) return undefined;
		// 相同正文取最后一条，最接近用户当前点击的消息。
		for (let index = forkMessages.length - 1; index >= 0; index -= 1) {
			const item = forkMessages[index];
			if (item?.entryId && item.text?.trim() === targetText) return item.entryId;
		}
		return undefined;
	}

	async function forkFromUserMessage(expectedTarget: SessionRuntimeTarget, message: ChatMessage): Promise<void> {
		if (input.isRuntimeTargetBusy(expectedTarget) || forkingMessageId) return;
		setForkingMessageId(message.id);
		try {
			const currentTarget = requireCurrentRuntimeTarget(expectedTarget);
			const entryId = await resolveForkEntryId(currentTarget, message);
			if (!entryId) {
				input.showToast(t("app.forkMissingEntryId"), 4000);
				return;
			}
			const latestTarget = requireCurrentRuntimeTarget(currentTarget);
			const result = requireSessionCommand(await api.sessions.forkRuntimeSession(latestTarget, entryId));
			if (result.cancelled) {
				input.showToast(t("app.forkCancelled"), 3500);
				return;
			}
			const promptText = typeof result.text === "string" && result.text.length > 0 ? result.text : message.text;
			const projectId = input.agents.find((agent) => agent.id === latestTarget.agentId)?.projectId ?? input.activeProjectId;
			await input.openReplacedRuntimeSession(projectId, result.targetSessionId);
			const draftTarget = result.targetSessionId ?? input.currentSessionIdRef.current ?? latestTarget.agentId;
			if (result.targetSessionId) input.currentSessionIdRef.current = result.targetSessionId;
			input.setPromptForAgent(draftTarget, promptText);
			window.dispatchEvent(new CustomEvent("user-message-edit", { detail: { text: promptText } }));
			input.showToast(t("app.forkDone"), 3500);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			input.showToast(t("app.forkFailed", { error: translateAgentErrorMessage(message) }), 5000);
		} finally {
			setForkingMessageId(null);
		}
	}

	return { resendUserMessage, editMessage, deleteMessage, forkFromUserMessage, forkingMessageId };
}
