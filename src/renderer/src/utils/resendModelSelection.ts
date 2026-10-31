import type { AgentRuntimeState } from "../../../shared/types";
import type { ModelPending } from "./modelPendingDisplay";

export type ResendModelSelection = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
};

export type ResendModelSources = {
	/** 生成进行中已选、尚未套到 pi 的模型（底栏显示 from → to 的那个 to）。 */
	pending?: ModelPending;
	/** 运行中 Agent 的真实状态：/model 轮换只改这里，不会写回 catalog。 */
	runtimeState?: Pick<AgentRuntimeState, "provider" | "modelId" | "thinkingLevel">;
	/** 会话记录里持久化的选择（Agent 未启动或运行态缺字段时的回退）。 */
	recordModel?: { provider: string; modelId: string };
	recordThinkingLevel?: string;
};

/**
 * 「用同一条消息再次发送」要沿用的是**当前选中的模型**，而不是那条历史消息当时用的模型：
 * 截断会话文件会把之后的 model_change 条目一并墓碑化，pi 重载后会退回旧模型。
 *
 * 优先级必须与底栏展示同源（见 ComposerComponents 的 liveModel）：
 * pending > runtime.state > record。
 * runtime.state 优先于 record 是因为 `/model` 轮换在 pi 内部完成，只体现在运行态；
 * 反过来以 record 为准会把用户刚轮换到的模型又写回旧的。
 */
export function resolveResendModelSelection(
	source: ResendModelSources,
): ResendModelSelection | undefined {
	const pending = source.pending?.to;
	if (pending?.provider && pending.modelId) {
		return { model: { provider: pending.provider, modelId: pending.modelId } };
	}
	const runtime = source.runtimeState;
	if (runtime?.provider && runtime.modelId) {
		return {
			model: { provider: runtime.provider, modelId: runtime.modelId },
			thinkingLevel: runtime.thinkingLevel,
		};
	}
	const record = source.recordModel;
	if (record?.provider && record.modelId) {
		return {
			model: { provider: record.provider, modelId: record.modelId },
			thinkingLevel: source.recordThinkingLevel,
		};
	}
	return undefined;
}
