import { useEffect, useRef, useState } from "react";
import type {
	AgentTab,
	ChatMessage,
	ImageContent,
	SessionRuntimeTarget,
} from "../../../shared/types";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import { requireSessionCommand } from "../utils/sessionCommands";
import type { HistoryMutationRefreshSnapshot } from "./useSessionTimelineController";

type SessionMessageCommandsInput = {
	activeAgentId: string | undefined;
	activeAgentStatus: AgentTab["status"] | undefined;
	activeProjectId: string | undefined;
	currentSessionId: string | undefined;
	agents: AgentTab[];
	isAgentCurrentlyBusy: () => boolean;
	getRuntimeTargetForAgent: (agentId: string | undefined) => SessionRuntimeTarget | undefined;
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

	function resendUserMessage(message: ChatMessage): void {
		const agentId = input.activeAgentId;
		if (!agentId || message.agentId !== agentId || resendingIdsRef.current.has(message.id)) return;
		const target = input.getRuntimeTargetForAgent(agentId);
		const sessionId = input.currentSessionId;
		if (!target || !sessionId) return;

		resendingIdsRef.current.add(message.id);
		const timer = setTimeout(() => {
			resendingIdsRef.current.delete(message.id);
			resendTimersRef.current.delete(timer);
		}, 30_000);
		resendTimersRef.current.add(timer);
		void api.sessions.prepareRuntimeResend(target, message.id)
			.then((result) => requireSessionCommand(result).value)
			.then((snapshot) => input.submitPromptSnapshot(sessionId, snapshot.text, snapshot.images))
			.catch((error) => input.showToast(error instanceof Error ? error.message : String(error), 5000));
	}

	async function editMessage(messageId: string, newText: string): Promise<void> {
		if (!input.activeAgentId) return;
		try {
			const target = input.getRuntimeTargetForAgent(input.activeAgentId);
			if (!target) return;
			const refreshSnapshot = input.captureHistoryMutationRefresh?.(target.sessionId) ?? null;
			requireSessionCommand(await api.sessions.editRuntimeMessage(target, messageId, newText));
			if (refreshSnapshot && input.refreshHistoryAfterMutation) {
				await input.refreshHistoryAfterMutation(refreshSnapshot);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			input.showToast(`${t("message.editFailed")}: ${translateAgentErrorMessage(message)}`, 5000);
		}
	}

	function deleteMessage(messageId: string): void {
		const agentId = input.activeAgentId;
		if (!agentId) return;
		input.overlays.showConfirm({
			title: t("message.deleteTitle"),
			message: t("message.deleteReloadPrompt"),
			danger: true,
			confirmLabel: t("common.delete"),
			onConfirm: async () => {
				input.overlays.clearConfirm();
				try {
					const target = input.getRuntimeTargetForAgent(agentId);
					if (!target) return;
					const refreshSnapshot = input.captureHistoryMutationRefresh?.(target.sessionId) ?? null;
					requireSessionCommand(await api.sessions.deleteRuntimeMessage(target, messageId));
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

	async function resolveForkEntryId(agentId: string, message: ChatMessage): Promise<string | undefined> {
		if (typeof message.meta?.entryId === "string" && message.meta.entryId) return message.meta.entryId;
		const historyPrefix = `${agentId}-history-`;
		if (message.id.startsWith(historyPrefix)) {
			const fromId = message.id.slice(historyPrefix.length).trim();
			if (fromId && fromId !== String(message.meta?._piDeckMsgSeq ?? "") && !/^\d+$/.test(fromId)) {
				return fromId;
			}
		}
		try {
			const target = input.getRuntimeTargetForAgent(agentId);
			if (!target) return undefined;
			const forkMessages = requireSessionCommand(await api.sessions.getRuntimeForkMessages(target)).value;
			const targetText = message.text.trim();
			if (!targetText) return undefined;
			// 相同正文取最后一条，最接近用户当前点击的消息。
			for (let index = forkMessages.length - 1; index >= 0; index -= 1) {
				const item = forkMessages[index];
				if (item?.entryId && item.text?.trim() === targetText) return item.entryId;
			}
		} catch {
			// 上层统一展示无法解析 entryId 的提示。
		}
		return undefined;
	}

	async function forkFromUserMessage(message: ChatMessage): Promise<void> {
		const agentId = input.activeAgentId;
		if (!agentId || input.isAgentCurrentlyBusy() || forkingMessageId) return;
		setForkingMessageId(message.id);
		try {
			const entryId = await resolveForkEntryId(agentId, message);
			if (!entryId) {
				input.showToast(t("app.forkMissingEntryId"), 4000);
				return;
			}
			const target = input.getRuntimeTargetForAgent(agentId);
			if (!target) return;
			const result = requireSessionCommand(await api.sessions.forkRuntimeSession(target, entryId));
			if (result.cancelled) {
				input.showToast(t("app.forkCancelled"), 3500);
				return;
			}
			const promptText = typeof result.text === "string" && result.text.length > 0 ? result.text : message.text;
			const projectId = input.agents.find((agent) => agent.id === agentId)?.projectId ?? input.activeProjectId;
			await input.openReplacedRuntimeSession(projectId, result.targetSessionId);
			const draftTarget = result.targetSessionId ?? input.currentSessionIdRef.current ?? agentId;
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
