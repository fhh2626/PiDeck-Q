/**
 * 模型规格自动补全（issue 需求：获取模型列表后保存即补全，无需逐个失焦）。
 *
 * computeModelSpecPatches：单模型 × 规格 → 补丁列表（纯函数，可单测）。
 * collectModelSpecPatches：整个 ModelsFile 批量补全（并行查询，返回新 providers 快照）。
 *
 * 规则（与内置表 lookupModelSpec 语义对齐）：
 * - 只填空字段：contextWindow/maxTokens 为空才填、reasoning 仅在「未设置」时填 true、
 *   input 未配置且规格声明图片才填——用户手填/明确关掉的一律不覆盖。
 * - 规格未命中或字段未公开时保持为空，不能用猜测值改变自定义模型的请求上限。
 */

import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { ModelItem, ModelsFile, ProviderConfig } from "../config/configTypes";

/** 单模型补全 patch：返回 [字段, 值] 列表，无空字段可补时返回空数组 */
export function computeModelSpecPatches(
	model: ModelItem,
	spec: ModelSpec,
): Array<[string, unknown]> {
	const updates: Array<[string, unknown]> = [];
	if (model.contextWindow == null && typeof spec.contextWindow === "number") {
		updates.push(["contextWindow", spec.contextWindow]);
	}
	if (model.maxTokens == null && typeof spec.maxTokens === "number") {
		updates.push(["maxTokens", spec.maxTokens]);
	}
	// reasoning 只在「未设置」时填 true；用户明确关掉的 false 不覆盖
	if (model.reasoning === undefined && spec.reasoning === true) {
		updates.push(["reasoning", true]);
	}
	// 多模态：未配置 input 且规格声明图片输入时才填
	if (model.input == null && spec.images === true) {
		updates.push(["input", ["text", "image"]]);
	}
	return updates;
}

export type ModelSpecLookup = (providerName: string, modelId: string) => Promise<ModelSpec | null>;

/**
 * 批量补全整个 ModelsFile：遍历所有 provider 的模型，并行查规格表，
 * 有补丁的模型写回新快照。返回 { providers, filledCount }。
 * 不修改入参（补全数据由调用方决定何时写回 state / 落盘）。
 */
export async function collectModelSpecPatches(
	models: ModelsFile,
	lookup: ModelSpecLookup,
): Promise<{ providers: Record<string, ProviderConfig>; filledCount: number }> {
	const providers: Record<string, ProviderConfig> = {};
	let filledCount = 0;
	// 并行查询全部模型（规格表是原生后端本地规格索引，数量级为几十个 provider × 个位数模型）
	const entries = Object.entries(models.providers).flatMap(([providerName, provider]) =>
		provider.models.map((model, index) => ({ providerName, provider, model, index })),
	);
	const results = await Promise.all(
		entries.map(({ providerName, model }) =>
			model.id ? lookup(providerName, model.id).catch(() => null) : Promise.resolve(null),
		),
	);
	for (let i = 0; i < entries.length; i++) {
		const { providerName, provider, model, index } = entries[i];
		const spec = results[i];
		const existing = providers[providerName];
		if (!existing) {
			// 浅拷贝 provider，仅 models 数组会被替换，其余字段共享引用
			providers[providerName] = { ...provider, models: [...provider.models] };
		}
		// 空 id 模型无意义，跳过（不发查询、不填默认值）
		if (!model.id) continue;
		// 未匹配或查询失败时不猜测模型上限，保留 provider/pi 的默认行为。
		if (!spec) continue;
		const updates = computeModelSpecPatches(model, spec);
		if (updates.length === 0) continue;
		filledCount++;
		const next = { ...model };
		for (const [field, value] of updates) next[field] = value;
		providers[providerName].models[index] = next;
	}
	return { providers, filledCount };
}
