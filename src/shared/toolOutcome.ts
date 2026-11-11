/**
 * 工具结果状态契约（主进程投影 / 桌面时间线 / Web 共用，纯函数无运行时依赖）。
 *
 * 背景：会话可能异常终止（进程被杀、断电、离线导入、崩溃恢复），assistant 已经
 * 声明了 toolCall，但对应的 toolResult 永远没有落盘。这种调用既不能当成「运行中」
 * （会永远转圈），也不能当成成功或失败（都是编造结论）。统一用 unknown：
 * 保留调用记录本身，但不声明结果、耗时或成败。
 */

import type { ToolOutcomeStatus } from "./types/tool";

export const TOOL_STATUS_UNKNOWN: ToolOutcomeStatus = "unknown";

/**
 * UIMessage toolMetadata 上的「结果未记录」标记键。
 *
 * 只对 input-streaming / input-available 有意义：一旦 part 进入 output-available /
 * output-error，状态本身就是结论，标记即使残留在 part 上也不参与判定
 * （见 webToolGroups.isWebToolResultMissing），避免 AI SDK 的
 * `toolMetadata !== undefined` 才覆盖语义把旧标记粘到已完成的 part 上。
 */
export const TOOL_RESULT_MISSING_KEY = "resultMissing";

/** 生成 toolMetadata 标记对象（每次新建，避免共享可变引用）。 */
export function toolResultMissingMetadata(): Record<string, boolean> {
	return { [TOOL_RESULT_MISSING_KEY]: true };
}

/** 读取 toolMetadata 上的标记；未知/损坏结构一律视为「没有标记」。 */
export function hasToolResultMissingMetadata(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	return Reflect.get(value, TOOL_RESULT_MISSING_KEY) === true;
}

/**
 * 归一化 meta.status。
 * 旧数据没有 status 字段（历史遗留）时回退 done：这是投影/事件两条通道一直以来的
 * 默认语义，不能因为引入 unknown 而让老会话整片变成「结果未记录」。
 */
export function normalizeToolOutcomeStatus(raw: unknown): ToolOutcomeStatus {
	if (raw === "running" || raw === "error" || raw === "unknown") return raw;
	return "done";
}
