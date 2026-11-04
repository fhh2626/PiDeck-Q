import type { ChatMessage, ImageContent, ImageDisplayNotice } from "../../../../../shared/types";
import type { RenderMessage } from "../../app/AppUtils";
import { getToolName, getToolDetailText } from "../TimelineFormat.ts";

/**
 * 完整不可变的时间线导出数据模型（遵循计划步骤 9 要求）。
 */
export interface ExportMessageModel {
	id: string;
	role: string;
	timestamp: number;
	text: string;
	images?: ImageContent[];
	imageDisplayNotice?: ImageDisplayNotice;
}

export interface ExportThinkingModel {
	id: string;
	thinkingText: string;
}

export interface ExportToolModel {
	id: string;
	toolName: string;
	detailText: string;
	argsText?: string;
	resultText?: string;
	detailsText?: string;
	images?: ImageContent[];
	imageDisplayNotice?: ImageDisplayNotice;
}

export type ExportAgentRunSubItem =
	| { kind: "message"; message: ExportMessageModel }
	| { kind: "thinking"; thinking: ExportThinkingModel }
	| { kind: "tool"; tool: ExportToolModel };

export type ExportItemModel =
	| {
			kind: "message";
			message: ExportMessageModel;
	  }
	| {
			kind: "agent-run";
			id: string;
			items: ExportAgentRunSubItem[];
	  };

export interface ExportDocumentModel {
	sessionId?: string;
	items: ExportItemModel[];
}

/**
 * 将已过滤的 selectedRuns 构建为完整展开的只读模型对象。
 * 遵循计划规则：
 * 1. thinking 优先读 message.thinking；
 * 2. tool 完整保留 toolName、detailText、images 等，不截断、不折叠、不分页；
 * 3. 传入 fullTextMap 以覆盖截断的文本；
 * 4. 严禁修改原始 ChatMessage 与 RenderMessage 对象。
 */
export function buildExportDocumentModel(
	selectedRuns: readonly RenderMessage[],
	fullTextMap: ReadonlyMap<string, string>,
	showThinking = true,
	toolPayloadMap?: ReadonlyMap<string, { argsText?: string; resultText?: string; detailsText?: string }>,
): ExportDocumentModel {
	const docItems: ExportItemModel[] = [];

	for (const run of selectedRuns) {
		if (run.kind === "message") {
			const m = run.message;
			const inlineThinking =
				showThinking &&
				typeof (m as unknown as { thinking?: string }).thinking === "string" &&
				(m as unknown as { thinking: string }).thinking.trim()
					? (m as unknown as { thinking: string }).thinking.trim()
					: undefined;
			if (inlineThinking) {
				docItems.push({
					kind: "agent-run",
					id: `run-${m.id}-thinking`,
					items: [
						{
							kind: "thinking",
							thinking: {
								id: `${m.id}-thinking`,
								thinkingText: inlineThinking,
							},
						},
					],
				});
			}
			const text = fullTextMap.get(m.id) ?? m.text ?? "";
			docItems.push({
				kind: "message",
				message: {
					id: m.id,
					role: m.role,
					timestamp: m.timestamp,
					text,
					images: m.images,
					imageDisplayNotice: m.imageDisplayNotice,
				},
			});
			continue;
		}

		if (run.kind === "agent-run") {
			const runItems: ExportAgentRunSubItem[] = [];

			for (const sub of run.items) {
				if (sub.kind === "message") {
					const m = sub.message;
					const inlineThinking =
						showThinking &&
						typeof (m as unknown as { thinking?: string }).thinking === "string" &&
						(m as unknown as { thinking: string }).thinking.trim()
							? (m as unknown as { thinking: string }).thinking.trim()
							: undefined;
					if (inlineThinking) {
						runItems.push({
							kind: "thinking",
							thinking: {
								id: `${m.id}-thinking`,
								thinkingText: inlineThinking,
							},
						});
					}
					const text = fullTextMap.get(m.id) ?? m.text ?? "";
					if (text.trim() || !inlineThinking) {
						runItems.push({
							kind: "message",
							message: {
								id: m.id,
								role: m.role,
								timestamp: m.timestamp,
								text,
								images: m.images,
								imageDisplayNotice: m.imageDisplayNotice,
							},
						});
					}
					continue;
				}

				if (sub.kind === "thinking-group" && showThinking) {
					for (const m of sub.messages) {
						// 步骤 9.3 核心修复：思考块使用 message.thinking，绝不能看 message.text！
						const thinkingText =
							typeof (m as unknown as { thinking?: string }).thinking === "string" &&
							(m as unknown as { thinking?: string }).thinking
								? (m as unknown as { thinking: string }).thinking
								: m.text ?? "";
						if (thinkingText.trim()) {
							runItems.push({
								kind: "thinking",
								thinking: {
									id: m.id,
									thinkingText,
								},
							});
						}
					}
					continue;
				}

				if (sub.kind === "tool-group") {
					// 步骤 9.3 核心修复：工具不分页、不截断、展示全部工具卡片及完整详情！
					for (const m of sub.messages) {
						const toolPayload = toolPayloadMap?.get(m.id);
						const toolName = getToolName(m);
						const baseDetail = getToolDetailText(m);
						const detailText = toolPayload?.resultText ?? fullTextMap.get(m.id) ?? baseDetail;
						const argsText = toolPayload?.argsText ?? (m.meta?.args ? JSON.stringify(m.meta.args, null, 2) : undefined);
						const resultText = toolPayload?.resultText;
						const detailsText = toolPayload?.detailsText;
						runItems.push({
							kind: "tool",
							tool: {
								id: m.id,
								toolName,
								detailText,
								argsText,
								resultText,
								detailsText,
								images: m.images,
								imageDisplayNotice: m.imageDisplayNotice,
							},
						});
					}
					continue;
				}
			}

			docItems.push({
				kind: "agent-run",
				id: run.id,
				items: runItems,
			});
		}
	}

	return { items: docItems };
}
