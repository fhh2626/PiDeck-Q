import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";
import type { SessionRuntimeTarget } from "../../../shared/types";
import { useTimelinePresentationContext } from "../components/session/timeline/timelinePresentationContext";
import { useTimelineEditCommands } from "../components/session/timeline/timelineEditCommandsContext";
import {
	getEditPresentationAtom,
	sessionEditingRowKeysFamily,
	type EditPresentation,
} from "../atoms/timeline-presentation";

/**
 * 统一时间线消息行编辑 Hook。
 * 遵循计划步骤 7 设计：
 * 1. 状态可序列化存入 editPresentationFamily (idle | editing | submitting)；
 * 2. 开始编辑时捕获 runtimeTarget 并锁定 editId；
 * 3. 提交时原样传入捕获的 target，不使用当前最新的 target；
 * 4. 提交中禁用重复触发，返回 boolean 明确成功/失败；
 * 5. 更新 sessionEditingRowKeysFamily 维护会话内正在编辑的行索引。
 */
export function useTimelineMessageEdit(params: {
	messageId: string;
	initialText: string;
	onLegacyEditMessage?: (messageId: string, newText: string) => Promise<boolean | void>;
}) {
	const { messageId, initialText, onLegacyEditMessage } = params;
	const presentationCtx = useTimelinePresentationContext();
	const editCommands = useTimelineEditCommands();

	const sessionId = presentationCtx?.sessionId;
	const rowKey = presentationCtx?.rowKey;

	const editAtom = useMemo(() => {
		if (sessionId && rowKey) {
			return getEditPresentationAtom(sessionId, rowKey);
		}
		return null;
	}, [sessionId, rowKey]);

	const [editState, setEditState] = useAtom(
		editAtom ??
			useMemo(
				() => getEditPresentationAtom("__local__", "__local__"),
				[],
			),
	);

	const [, setSessionEditingRowKeys] = useAtom(
		sessionEditingRowKeysFamily(sessionId ?? "__local__"),
	);

	const isEditing = editState.status === "editing" || editState.status === "submitting";
	const isSubmitting = editState.status === "submitting";
	const currentText = editState.status !== "idle" ? editState.text : initialText;

	const beginEdit = useCallback(() => {
		const target = editCommands?.currentRuntimeTarget;
		const editId = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		setEditState({
			status: "editing",
			editId,
			messageId,
			text: initialText,
			runtimeTarget: target ?? {
				sessionId: sessionId ?? "",
				agentId: "",
				runtimeGeneration: 0,
			},
		});

		if (rowKey) {
			setSessionEditingRowKeys((prev) => {
				const next = new Set(prev);
				next.add(rowKey);
				return next;
			});
		}
	}, [editCommands?.currentRuntimeTarget, messageId, initialText, sessionId, rowKey, setEditState, setSessionEditingRowKeys]);

	const updateText = useCallback((text: string) => {
		setEditState((prev) => {
			if (prev.status === "idle") return prev;
			return { ...prev, text };
		});
	}, [setEditState]);

	const cancelEdit = useCallback(() => {
		setEditState({ status: "idle" });
		if (rowKey) {
			setSessionEditingRowKeys((prev) => {
				const next = new Set(prev);
				next.delete(rowKey);
				return next;
			});
		}
	}, [rowKey, setEditState, setSessionEditingRowKeys]);

	const saveEdit = useCallback(async (): Promise<boolean> => {
		if (editState.status !== "editing") return false;
		const { editId, text, runtimeTarget } = editState;
		if (!text.trim()) return false;

		setEditState((prev) => (prev.status === "editing" ? { ...prev, status: "submitting" } : prev));

		let success = false;
		try {
			if (editCommands) {
				success = await editCommands.submitEditMessage(runtimeTarget, messageId, text);
			} else if (onLegacyEditMessage) {
				const res = await onLegacyEditMessage(messageId, text);
				success = res !== false;
			}
		} catch {
			success = false;
		}

		if (success) {
			setEditState((prev) => {
				if (prev.status !== "idle" && prev.editId === editId) {
					return { status: "idle" };
				}
				return prev;
			});
			if (rowKey) {
				setSessionEditingRowKeys((prev) => {
					const next = new Set(prev);
					next.delete(rowKey);
					return next;
				});
			}
			return true;
		} else {
			// 失败时回退到 editing 状态，保留用户输入的修改文本
			setEditState((prev) => {
				if (prev.status === "submitting" && prev.editId === editId) {
					return { ...prev, status: "editing" };
				}
				return prev;
			});
			return false;
		}
	}, [editState, editCommands, onLegacyEditMessage, messageId, rowKey, setEditState, setSessionEditingRowKeys]);

	return {
		isEditing,
		isSubmitting,
		text: currentText,
		beginEdit,
		updateText,
		cancelEdit,
		saveEdit,
	};
}
