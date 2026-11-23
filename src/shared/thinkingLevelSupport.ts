import type { AvailableModel, ModelThinkingSupport } from "./types";

/**
 * 模型级思考档位支持（xhigh / max）的纯策略。
 *
 * 规则来源：pi 的 models.json `thinkingLevelMap`，只有显式映射到 xhigh/max 的
 * 模型才支持对应档位。这里的函数不依赖 React / Node，主进程（模型切换降级、
 * 启动应用偏好）与渲染层（选择器过滤、记录同步）共用同一套判定，避免两边漂移。
 */

const EXTENDED_THINKING_LEVELS = ["xhigh", "max"] as const;
export type ExtendedThinkingLevel = (typeof EXTENDED_THINKING_LEVELS)[number];

/** 未声明任何扩展档位的默认支持位。调用方不要原地修改返回值。 */
export function noModelThinkingSupport(): ModelThinkingSupport {
	return { xhigh: false, max: false };
}

export function isExtendedThinkingLevel(level: string): level is ExtendedThinkingLevel {
	return level === "xhigh" || level === "max";
}

function isDeclaredLevel(value: unknown): value is ExtendedThinkingLevel {
	return value === "xhigh" || value === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** provider/model 键：与模型列表去重一致，大小写不敏感。 */
export function modelThinkingSupportKey(provider: string, modelId: string): string {
	return `${provider}\u0000${modelId}`.toLowerCase();
}

/**
 * models.json（unknown，来自磁盘）→ provider/model 支持位索引。
 * 只看 providers[*].models[*].thinkingLevelMap；结构损坏的条目直接跳过。
 */
export function collectModelThinkingSupport(parsed: unknown): Map<string, ModelThinkingSupport> {
	const support = new Map<string, ModelThinkingSupport>();
	if (!isRecord(parsed)) return support;
	const providers = parsed.providers;
	if (!isRecord(providers)) return support;
	for (const [provider, providerConfig] of Object.entries(providers)) {
		if (!isRecord(providerConfig)) continue;
		const models = providerConfig.models;
		if (!Array.isArray(models)) continue;
		for (const model of models) {
			if (!isRecord(model)) continue;
			const id = model.id;
			if (typeof id !== "string" || !id) continue;
			// 显式 reasoning:false 的模型在 pi 里只支持 off，即使残留了 xhigh/max 映射也不能展示。
			support.set(
				modelThinkingSupportKey(provider, id),
				model.reasoning === false
					? noModelThinkingSupport()
					: modelThinkingSupportFromMap(model.thinkingLevelMap),
			);
		}
	}
	return support;
}

/** 给模型列表补上 thinkingLevels（返回新数组，不改动模型列表缓存的原始对象）。 */
export function applyModelThinkingSupport(
	models: AvailableModel[],
	support: Map<string, ModelThinkingSupport>,
): AvailableModel[] {
	return models.map((model) => ({
		...model,
		// 显式 reasoning:false 时 pi 只支持 off；即使配置残留映射也不能展示扩展档位。
		thinkingLevels: model.reasoning === false
			? noModelThinkingSupport()
			: (support.get(modelThinkingSupportKey(model.provider, model.id)) ?? noModelThinkingSupport()),
	}));
}

/**
 * models.json 的 thinkingLevelMap（来自磁盘 JSON，按 unknown 收窄）→ 支持位。
 * 与配置页「思考级别」列保持一致：只有 xhigh/max 两个合法值算已勾选；
 * null / 其他字符串（损坏或旧数据）视为未声明。
 */
export function modelThinkingSupportFromMap(map: unknown): ModelThinkingSupport {
	if (!isRecord(map)) return noModelThinkingSupport();
	return {
		xhigh: isDeclaredLevel(map.xhigh),
		max: isDeclaredLevel(map.max),
	};
}

/**
 * 模型切换/应用偏好时的档位降级：
 * 当前档位是 xhigh/max 且新模型未声明该档位时退回 high，其余档位原样保留。
 * 纯函数，返回 undefined 表示调用方没有可用的档位信息（不写入记录）。
 */
export function clampThinkingLevelForModel(
	level: string | undefined,
	support: ModelThinkingSupport,
): string | undefined {
	if (!level) return level;
	if (level === "xhigh" && !support.xhigh) return "high";
	if (level === "max" && !support.max) return "high";
	return level;
}

/**
 * 在模型列表中查找指定 provider/model 的支持位。
 * 模型列表去重按大小写不敏感处理，这里沿用同一口径；找不到时按不支持处理
 * （与「没有勾上就不出现」一致）。
 */
export function findModelThinkingSupport(
	models: ReadonlyArray<Pick<AvailableModel, "provider" | "id" | "thinkingLevels">>,
	provider: string | undefined,
	modelId: string | undefined,
): ModelThinkingSupport {
	if (!provider || !modelId) return noModelThinkingSupport();
	const targetProvider = provider.toLowerCase();
	const targetModel = modelId.toLowerCase();
	const found = models.find(
		(model) =>
			model.provider.toLowerCase() === targetProvider &&
			model.id.toLowerCase() === targetModel,
	);
	return found?.thinkingLevels ?? noModelThinkingSupport();
}
