import type { UIMessage } from "ai";
import { getWebAskQuestionResult } from "./webApi";

export type WebToolPart = {
	type: string;
	toolName?: string;
	toolCallId?: string;
	state?: string;
	output?: unknown;
	errorText?: string;
	[key: string]: unknown;
};

export function isWebToolPart(part: unknown): part is WebToolPart {
	if (!part || typeof part !== "object") return false;
	const type = (part as { type?: unknown }).type;
	return (
		type === "dynamic-tool" ||
		(typeof type === "string" && type.startsWith("tool-"))
	);
}

/** 仅精确识别 ask_question 工具 part（tool-ask_question 或 dynamic-tool with toolName="ask_question"） */
export function isWebAskQuestionToolPart(part: unknown): boolean {
	if (!part || typeof part !== "object") return false;
	const p = part as { type?: unknown; toolName?: unknown };
	if (p.type === "tool-ask_question") return true;
	if (p.type === "dynamic-tool" && p.toolName === "ask_question") return true;
	return false;
}

export function isPureToolMessage(message: UIMessage): boolean {
	if (message.role !== "assistant") return false;
	if (getWebAskQuestionResult(message)) return false;
	if (!message.parts || message.parts.length === 0) return false;

	let hasRealTool = false;
	for (const part of message.parts) {
		if (isWebAskQuestionToolPart(part)) return false; // 未回答的提问也是边界，不能作为历史纯工具组
		if (isWebToolPart(part)) {
			hasRealTool = true;
		} else if (part.type === "step-start") {
			// step-start 是不可见流程标记，允许共存于纯工具消息中
			continue;
		} else if (part.type === "text" && (!part.text || typeof part.text !== "string")) {
			// 空文本不可见，允许跳过
			continue;
		} else {
			return false; // 可见正文、reasoning 等均不是纯工具消息
		}
	}
	return hasRealTool;
}

export type WebAssistantPartGroupItem =
	| { kind: "reasoning"; part: { type: "reasoning"; text?: string }; originalIndex: number }
	| { kind: "text"; text?: string; originalIndex: number }
	| { kind: "ask-result"; originalIndex: number }
	| { kind: "tool-single"; part: WebToolPart; originalIndex: number }
	| { kind: "tool-group"; id: string; parts: Array<{ part: WebToolPart; originalIndex: number }> };

/**
 * 实时 SSE 单条 Assistant 消息内部的 parts 分组：
 * 连续的普通 tool parts 合并为 tool-group；reasoning、text、ask 问答卡为阻断边界。
 */
export function groupWebAssistantParts(
	displayParts: Array<{ type?: string; text?: string; [key: string]: unknown }>,
	message: UIMessage,
): WebAssistantPartGroupItem[] {
	const items: WebAssistantPartGroupItem[] = [];
	const askResult = getWebAskQuestionResult(message);

	// 优先选真正的提问工具承载已完成问答卡；若无明确 ask 工具则回退到首个工具（旧数据兼容）
	let selectedAskIndex = -1;
	if (askResult) {
		const trueAskIndex = displayParts.findIndex((part) => isWebAskQuestionToolPart(part));
		if (trueAskIndex !== -1) {
			selectedAskIndex = trueAskIndex;
		} else {
			selectedAskIndex = displayParts.findIndex((part) => isWebToolPart(part));
		}
	}

	let currentTools: Array<{ part: WebToolPart; originalIndex: number }> = [];

	const flushTools = () => {
		if (currentTools.length === 1) {
			items.push({
				kind: "tool-single",
				part: currentTools[0].part,
				originalIndex: currentTools[0].originalIndex,
			});
		} else if (currentTools.length >= 2) {
			const first = currentTools[0];
			const stableId = first.part.toolCallId || `${message.id}-group-${first.originalIndex}`;
			items.push({
				kind: "tool-group",
				id: stableId,
				parts: [...currentTools],
			});
		}
		currentTools = [];
	};

	for (let index = 0; index < displayParts.length; index += 1) {
		const part = displayParts[index];

		// 不可见标记跳过：step-start 与空文本均不打断工具组
		if (part.type === "step-start") {
			continue;
		}
		if (part.type === "text" && (!part.text || typeof part.text !== "string")) {
			continue;
		}

		// 选定的问答卡位置：渲染 ask-result，且隔离前后工具
		if (index === selectedAskIndex && askResult) {
			flushTools();
			items.push({
				kind: "ask-result",
				originalIndex: index,
			});
			continue;
		}

		// 任何提问工具（未回答，或多个提问工具中的其余项）：独立渲染 tool-single，并切断工具组
		if (isWebAskQuestionToolPart(part)) {
			flushTools();
			items.push({
				kind: "tool-single",
				part: part as WebToolPart,
				originalIndex: index,
			});
			continue;
		}

		// 普通工具加入连续工具缓存
		if (isWebToolPart(part)) {
			currentTools.push({ part: part as WebToolPart, originalIndex: index });
		} else {
			flushTools();
			if (part.type === "reasoning") {
				items.push({
					kind: "reasoning",
					part: part as { type: "reasoning"; text?: string },
					originalIndex: index,
				});
			} else if (part.type === "text") {
				items.push({
					kind: "text",
					text: typeof part.text === "string" ? part.text : undefined,
					originalIndex: index,
				});
			}
		}
	}

	flushTools();
	return items;
}

export type WebTimelineGroupedItem =
	| { kind: "message"; message: UIMessage }
	| { kind: "tool-message-group"; id: string; messages: UIMessage[]; parts: WebToolPart[] };

/**
 * 历史分页消息流在时间线层级的分组：
 * 连续的纯工具 UIMessage 合并为一个展示组；遇到 user、text、reasoning、ask 等立即结束。
 */
export function groupWebTimelineMessages(
	messages: readonly UIMessage[],
): WebTimelineGroupedItem[] {
	const items: WebTimelineGroupedItem[] = [];
	let currentToolMessages: UIMessage[] = [];

	const flushToolMessages = () => {
		if (currentToolMessages.length === 1) {
			items.push({ kind: "message", message: currentToolMessages[0] });
		} else if (currentToolMessages.length >= 2) {
			const first = currentToolMessages[0];
			const parts: WebToolPart[] = [];
			for (const m of currentToolMessages) {
				for (const p of m.parts ?? []) {
					if (isWebToolPart(p)) parts.push(p);
				}
			}
			const firstPart = parts[0];
			const stableId = firstPart?.toolCallId || `hist-tool-group-${first.id}`;
			items.push({
				kind: "tool-message-group",
				id: stableId,
				messages: [...currentToolMessages],
				parts,
			});
		}
		currentToolMessages = [];
	};

	for (const message of messages) {
		if (isPureToolMessage(message)) {
			currentToolMessages.push(message);
		} else {
			flushToolMessages();
			items.push({ kind: "message", message });
		}
	}

	flushToolMessages();
	return items;
}
