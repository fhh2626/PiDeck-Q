/**
 * 执行过程折叠汇总统计（纯函数，可单测）。
 *
 * 折叠态只显示纯数字，不显示内容预览（与用户确认）。
 * 文案拼接（i18n）放在展示组件层，本模块只负责统计，保持零副作用。
 */
import type { TurnDisplayItem } from "./types";

export type ProcessSummary = {
	toolCount: number;
	thinkingCount: number;
	interimCount: number;
};

export function buildProcessSummary(items: TurnDisplayItem[]): ProcessSummary {
	let toolCount = 0;
	let thinkingCount = 0;
	let interimCount = 0;
	for (const item of items) {
		// final-answer 与 ask-result 都是常驻内容，不参与「执行过程」统计。
		if (item.kind === "final-answer" || item.kind === "ask-result") continue;
		if (item.kind === "process-entry") {
			// A display entry can contain several consecutive tool invocations.
			if (item.entry.kind === "tool-entry") toolCount += item.entry.group.messages.length;
			else thinkingCount += 1;
		} else if (item.kind === "interim-answer") {
			// 只数有文本的中间回复：空文本骨架是 live 挂载点 / 模型 error 占位
			// （如连续多条 stopReason=error 的空消息），不是真实中间回复，
			// 计入会虚增「N 段中间回复」计数（用户反馈：5 条 error 空消息显示成 5 段）。
			if (item.message.text.trim()) interimCount += 1;
		}
	}
	return { toolCount, thinkingCount, interimCount };
}

export function isEmptySummary(summary: ProcessSummary): boolean {
	return (
		summary.toolCount === 0 &&
		summary.thinkingCount === 0 &&
		summary.interimCount === 0
	);
}
