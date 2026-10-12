/**
 * Web 整轮展示模型（纯函数，可单测）——对齐桌面 buildTurnDisplay / TurnRow：
 * - 一轮内的思考、工具、中间插入语按原顺序进入唯一的「执行过程」折叠区；
 * - 常驻区：最终回答（本轮最后一个条目且为正文）、提问导语、已完成问答卡、
 *   未回答提问卡、error/system 投影行（错误不能被折叠藏起来）；
 * - 流式中本轮末尾的正文也放常驻区（对应桌面 live interim 挂在折叠容器外），
 *   之后若出现工具，它自然回到折叠区成为中间回复；
 * - 流式单条合并气泡与落盘后按 pi 消息拆开的多行，产出相同的步骤序列，
 *   避免「流式时一种排版、结束后另一种排版」。
 */
import type { UIMessage } from "ai";
import type { ProcessSummary } from "../components/session/timeline/segmentSummary";
import { readWebMessageMetadata } from "./webMessageMetadata";
import { isWebReasoningPartRunning, mergeAdjacentWebMessageParts } from "./webMessageParts";
import { groupWebAssistantParts, isWebAskQuestionToolPart, type WebToolPart } from "./webToolGroups";

export type WebTurnStep =
	| { kind: "reasoning"; key: string; text: string; running: boolean }
	/** parts 长度 1 渲染单工具卡，≥2 渲染工具组卡 */
	| { kind: "tools"; key: string; parts: WebToolPart[] }
	| { kind: "text"; key: string; text: string; streaming: boolean }
	| { kind: "ask-result"; key: string; message: UIMessage }
	| { kind: "ask-tool"; key: string; part: WebToolPart };

export type WebTurnDisplay = {
	foldSteps: WebTurnStep[];
	persistentSteps: WebTurnStep[];
	summary: ProcessSummary;
	/** 已结束且以正文收尾：驱动 useTurnExecution 的自动收起 */
	hasFinalAnswer: boolean;
};

type FlatStep = { step: WebTurnStep; alwaysVisible: boolean };

export function buildWebTurnDisplay(
	messages: readonly UIMessage[],
	options: { streaming: boolean },
): WebTurnDisplay {
	const flat: FlatStep[] = [];
	messages.forEach((message, messageIndex) => {
		const chatRole = readWebMessageMetadata(message)?.chatRole;
		const alwaysVisible = chatRole === "error" || chatRole === "system";
		const parts = mergeAdjacentWebMessageParts(message.parts);
		const messageStreaming = options.streaming && messageIndex === messages.length - 1;
		for (const item of groupWebAssistantParts(parts, message)) {
			if (item.kind === "reasoning") {
				const running = isWebReasoningPartRunning(parts, item.originalIndex, messageStreaming);
				const text = item.part.text ?? "";
				if (!text.trim() && !running) continue;
				flat.push({ alwaysVisible, step: { kind: "reasoning", key: `${message.id}:${item.originalIndex}`, text, running } });
			} else if (item.kind === "text") {
				const text = item.text ?? "";
				if (!text.trim()) continue;
				flat.push({ alwaysVisible, step: { kind: "text", key: `${message.id}:${item.originalIndex}`, text, streaming: false } });
			} else if (item.kind === "ask-result") {
				flat.push({ alwaysVisible, step: { kind: "ask-result", key: `${message.id}:ask`, message } });
			} else if (item.kind === "tool-single") {
				const key = item.part.toolCallId || `${message.id}:${item.originalIndex}`;
				flat.push({
					alwaysVisible,
					step: isWebAskQuestionToolPart(item.part)
						? { kind: "ask-tool", key, part: item.part }
						: { kind: "tools", key, parts: [item.part] },
				});
			} else {
				flat.push({ alwaysVisible, step: { kind: "tools", key: item.id, parts: item.parts.map((entry) => entry.part) } });
			}
		}
	});

	// 跨消息合并相邻工具：落盘后每个工具是一条消息，流式时是同一条消息里的相邻 part。
	const merged: FlatStep[] = [];
	for (const entry of flat) {
		const previous = merged.at(-1);
		if (previous && previous.step.kind === "tools" && entry.step.kind === "tools" && !previous.alwaysVisible && !entry.alwaysVisible) {
			merged[merged.length - 1] = {
				alwaysVisible: false,
				step: { kind: "tools", key: previous.step.key, parts: [...previous.step.parts, ...entry.step.parts] },
			};
			continue;
		}
		merged.push(entry);
	}

	const foldSteps: WebTurnStep[] = [];
	const persistentSteps: WebTurnStep[] = [];
	// 最终回答只在「非 alwaysVisible」条目里找末位：压缩摘要 / error 行常挂在一轮末尾，
	// 若按绝对末位判定，它们会被当成最终回答，真正的回答反而被折进执行过程。
	let lastIndex = -1;
	merged.forEach((entry, index) => {
		if (!entry.alwaysVisible) lastIndex = index;
	});
	let hasFinalAnswer = false;
	merged.forEach((entry, index) => {
		const step = entry.step;
		const next = merged[index + 1]?.step;
		const isAsk = step.kind === "ask-result" || step.kind === "ask-tool";
		const isAskLeadIn = step.kind === "text" && (next?.kind === "ask-result" || next?.kind === "ask-tool");
		if (!entry.alwaysVisible && step.kind === "text" && index === lastIndex) {
			persistentSteps.push({ ...step, streaming: options.streaming });
			if (!options.streaming) hasFinalAnswer = true;
			return;
		}
		if (isAsk || isAskLeadIn || entry.alwaysVisible) {
			persistentSteps.push(step);
			return;
		}
		foldSteps.push(step);
	});

	return { foldSteps, persistentSteps, summary: summarizeWebTurnSteps(foldSteps), hasFinalAnswer };
}

/** 折叠区统计：工具按调用次数计，思考按段计（含流式中尚无文本的段），中间回复按正文段计。 */
export function summarizeWebTurnSteps(steps: readonly WebTurnStep[]): ProcessSummary {
	let toolCount = 0;
	let thinkingCount = 0;
	let interimCount = 0;
	for (const step of steps) {
		if (step.kind === "tools") toolCount += step.parts.length;
		else if (step.kind === "reasoning") thinkingCount += 1;
		else if (step.kind === "text") interimCount += 1;
	}
	return { toolCount, thinkingCount, interimCount };
}
