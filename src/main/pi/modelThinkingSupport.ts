import type { AvailableModel, ModelThinkingSupport } from "../../shared/types";
import {
	applyModelThinkingSupport,
	collectModelThinkingSupport,
	modelThinkingSupportKey,
	noModelThinkingSupport,
} from "../../shared/thinkingLevelSupport";
import type { PiModelsFile } from "../config/ConfigManager";

/**
 * 模型思考档位支持（xhigh / max）的读取与注入。
 *
 * 数据源固定为本地 models.json 的 `thinkingLevelMap`：配置页勾选 xhigh/max 后，
 * 模型列表响应会带上 `thinkingLevels`，渲染层只对支持的模型展示对应档位；
 * 主进程在模型切换/应用会话偏好时用同一份数据做 high 降级。
 *
 * models.json 可能来自 WSL（ConfigManager 已按当前环境切换目录），
 * 因此这里只经 ConfigManager 读取，不直接拼路径。
 */

type ModelsConfigSource = {
	getModelsConfig(): Promise<{ parsed: PiModelsFile; diagnostic?: unknown; readError?: boolean }>;
};

/**
 * 读取 models.json 的支持位索引。
 * 返回 undefined 表示「配置不可读/未知」，与「可读但未声明」严格区分：
 * 前者不能用来降级用户偏好，后者才按不支持处理。
 */
async function readModelThinkingSupport(
	configManager: ModelsConfigSource,
): Promise<Map<string, ModelThinkingSupport> | undefined> {
	try {
		const { parsed, diagnostic, readError } = await configManager.getModelsConfig();
		// 配置存在但 JSON 损坏/读取失败：此时 parsed 是 fallback，不能据此判定「不支持」并降级用户偏好。
		if (diagnostic || readError) return undefined;
		return collectModelThinkingSupport(parsed);
	} catch {
		return undefined;
	}
}

/**
 * 读取 models.json 并给模型列表补支持位。
 * 配置读取失败时返回全 false 支持位（选择器不出现扩展档位）；
 * 这只是展示层的保守展示，不用于主进程的档位降级决策。
 */
export async function decorateModelsWithThinkingSupport(
	models: AvailableModel[],
	configManager: ModelsConfigSource,
): Promise<AvailableModel[]> {
	const support = await readModelThinkingSupport(configManager);
	return applyModelThinkingSupport(models, support ?? new Map());
}

/**
 * 查询单个模型的扩展档位支持（模型切换降级用）。
 * 配置不可读时返回 undefined（调用方跳过降级，避免用瞬时 I/O 失败改掉用户偏好）；
 * 配置可读但模型未声明时返回全 false（按不支持处理）。
 */
export async function resolveModelThinkingSupport(
	configManager: ModelsConfigSource,
	provider: string,
	modelId: string,
): Promise<ModelThinkingSupport | undefined> {
	const support = await readModelThinkingSupport(configManager);
	if (!support) return undefined;
	return support.get(modelThinkingSupportKey(provider, modelId)) ?? noModelThinkingSupport();
}
