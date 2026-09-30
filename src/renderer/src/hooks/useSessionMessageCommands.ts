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
	setPromptForAgent: (sessionId: string, text: string | ((current: string) => string)) => void;
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
	/**
	 * 确认删除后立即隐藏将被删的消息段，返回结算函数（committed / failed）。
	 * 主进程删除大会话要数秒，没有即时反馈时用户会误以为没删掉。
	 */
	beginOptimisticDeletion?: (
		sessionId: string,
		messageId: string,
	) => (outcome: "committed" | "failed") => void;
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

	function releaseResendLock(messageId: string): void {
		resendingIdsRef.current.delete(messageId);
	}

	/**
	 * 重发失败时把正文还给输入框。
	 * 为什么不做文件回滚：pi 侧截断已经提交，回滚需要重写会话文件且无法还原图片，
	 * 代价高于收益；把文字放回输入框让用户直接重试是更小且更可预期的补偿。
	 */
	function restoreResendText(sessionId: string, text: string): void {
		if (!text.trim()) return;
		input.setPromptForAgent(sessionId, (current) => (current.trim() ? `${text}\n\n${current}` : text));
		input.showToast(t("app.resendRestoredToComposer"), 6000);
	}

	function resendUserMessage(expectedTarget: SessionRuntimeTarget, message: ChatMessage): void {
		if (resendingIdsRef.current.has(message.id)) return;
		if (message.agentId && message.agentId !== expectedTarget.agentId) {
			// runtime 已被替换：静默 return 会表现为「点了没反应」，必须告知用户
			input.showToast(t("sessionCommand.runtimeChanged"), 5000);
			return;
		}

		let currentTarget: SessionRuntimeTarget;
		try {
			currentTarget = requireCurrentRuntimeTarget(expectedTarget);
		} catch (error) {
			input.showToast(error instanceof Error ? error.message : String(error), 5000);
			return;
		}

		resendingIdsRef.current.add(message.id);
		// 30 秒是递途险：Promise 终结时会在 finally 里释放，定时器只防挂死。
		const timer = setTimeout(() => {
			releaseResendLock(message.id);
			resendTimersRef.current.delete(timer);
		}, 30_000);
		resendTimersRef.current.add(timer);

		// 只有 prepare 成功（文件已截断、原消息已从时间线消失）才需要把正文还给用户；
		// prepare 自身失败时原消息仍在，恢复会造成重复发送。
		let preparedText: string | undefined;
		void (async () => {
			try {
				const snapshot = requireSessionCommand(
					await api.sessions.prepareRuntimeResend(currentTarget, message.id),
				).value;
				preparedText = snapshot.text;
				const refreshSnapshot = input.captureHistoryMutationRefresh?.(currentTarget.sessionId) ?? null;
				// prepare 已完成文件变更；提交前刷新历史，避免截断后界面还显示已删的回复
				if (refreshSnapshot && input.refreshHistoryAfterMutation) {
					await input.refreshHistoryAfterMutation(refreshSnapshot);
				}
				// resend 是两阶段操作：prepare（旧 target 上完成文件 mutation）→ 重新提交。
				// 提交前必须重新校验 target：prepare 期间 runtime 可能已被替换，
				// submitPromptSnapshot 只带 sessionId 会把旧消息投递到新 generation runtime。
				requireCurrentRuntimeTarget(currentTarget);
				const submitted = await input.submitPromptSnapshot(currentTarget.sessionId, snapshot.text, snapshot.images);
				// "unknown" 表示发送已受理但结果未知，不能当作失败把正文再插一遍。
				if (submitted === false && preparedText !== undefined) restoreResendText(currentTarget.sessionId, preparedText);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				if (errMsg.includes("RESEND_IMAGE_BUDGET_EXCEEDED")) {
					input.showToast(t("composer.images.resendBudgetExceeded"), 5000);
				} else {
					input.showToast(errMsg, 5000);
				}
				// 仅当文件已被截断（prepare 成功）才恢复正文；prepare 失败时原消息仍在时间线
				if (preparedText !== undefined) restoreResendText(currentTarget.sessionId, preparedText);
			} finally {
				releaseResendLock(message.id);
				clearTimeout(timer);
				resendTimersRef.current.delete(timer);
			}
		})();
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
			message: t("message.deleteTurnPrompt"),
			danger: true,
			confirmLabel: t("common.delete"),
			onConfirm: async () => {
				input.overlays.clearConfirm();
				let settleOptimisticDeletion: ((outcome: "committed" | "failed") => void) | undefined;
				try {
					const currentTarget = requireCurrentRuntimeTarget(expectedTarget);
					// 隐藏只作用于视图层，缓存原样保留：历史重读快照仍按真实已加载深度计算
					const refreshSnapshot = input.captureHistoryMutationRefresh?.(currentTarget.sessionId) ?? null;
					settleOptimisticDeletion = input.beginOptimisticDeletion?.(currentTarget.sessionId, messageId);
					requireSessionCommand(await api.sessions.deleteRuntimeMessage(currentTarget, messageId));
					if (refreshSnapshot && input.refreshHistoryAfterMutation) {
						await input.refreshHistoryAfterMutation(refreshSnapshot);
					}
					// 删除已提交：隐藏保持到权威快照里这些消息消失为止（事件与命令响应不保证先后）
					settleOptimisticDeletion?.("committed");
				} catch (error) {
					// 删除失败：立即恢复被隐藏的消息，再提示失败原因
					settleOptimisticDeletion?.("failed");
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
