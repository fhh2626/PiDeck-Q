export type ConfigTab = "models" | "settings" | "raw";

import type { ModelCostTier } from "./modelCostTiers";

// ── 匹配 pi 实际文件格式的类型 ────────────────────────

export type ThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;

/** 模型计费字段：单价为每百万 token 美元数，与 pi models.json 的 cost 字段一致。 */
export type ModelCost = {
	/** 输入 token 单价（$/M tokens） */
	input?: number;
	/** 输出 token 单价（$/M tokens） */
	output?: number;
	/** 缓存读 token 单价（$/M tokens） */
	cacheRead?: number;
	/** 缓存写 token 单价（$/M tokens） */
	cacheWrite?: number;
	/** 分档计费：输入 token 超过阈值后整次请求按该档费率（pi cost.tiers） */
	tiers?: ModelCostTier[];
};

export type ProviderCompat = {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	[key: string]: unknown;
};

export type ModelItem = {
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelCost;
	[key: string]: unknown;
};

export type ProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	compat?: ProviderCompat;
	models: ModelItem[];
	[key: string]: unknown;
};

export type ModelsFile = { providers: Record<string, ProviderConfig> };
export type SettingsFile = Record<string, unknown>;
