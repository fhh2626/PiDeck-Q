import type { AvailableModel, VisionBridgeConfig } from "../../../shared/types";

export type ModelImageNoticeKind =
	| "vision-bridge-active"
	| "unsupported-suggest-vision"
	| "unknown-capability";

export type ModelImageCapabilityNotice = {
	kind: ModelImageNoticeKind;
};

/**
 * 模型标识的稳定串键（provider + modelId）。
 * 分隔符用 \u0000，不会出现在真实 provider/model 名里，避免拼串后误命中；
 * 缺 modelId 时返回空串（能力未知），缺 provider 时仍保留 modelId，
 * 与输入框提示的匹配规则一致（仅按 modelId 匹配）。
 */
export function buildModelKey(provider?: string, modelId?: string): string {
	if (!modelId) return "";
	return `${provider ?? ""}\u0000${modelId}`;
}

/**
 * 从全量模型列表解析某模型的图片输入能力。
 * 返回 undefined 表示模型不在列表里（pi 未提供该列或列表还没拿到）——
 * 与扩展一致按「可能不支持」处理，不能据此认为模型能看图。
 */
export function resolveModelImageSupport(
	models: readonly AvailableModel[] | undefined,
	modelKey: string,
): boolean | undefined {
	if (!modelKey) return undefined;
	const separator = modelKey.indexOf("\u0000");
	if (separator < 0) return undefined;
	const provider = modelKey.slice(0, separator);
	const modelId = modelKey.slice(separator + 1);
	if (!modelId) return undefined;
	const matched = models?.find(
		(model) => model.id === modelId && (!provider || model.provider === provider),
	);
	return matched?.images;
}

/**
 * 视觉桥是否具备接管能力：总开关打开，且供应商与模型都填了。
 * 与扩展 resources/extensions/pi-deck-vision.ts 的判定保持一致——
 * 三项任一缺失时扩展直接放行原图，渲染层也不应显示「转换中」。
 */
export function isVisionBridgeConfigured(
	visionBridge: VisionBridgeConfig | null | undefined,
): boolean {
	return Boolean(visionBridge?.enabled && visionBridge.provider && visionBridge.model);
}

/**
 * 视觉桥轮询的时间窗（自消息发送起算）。
 * 它限制的是「什么时候还可以开始轮询」，不是轮询总时长（实际最多 4 轮、约 5.7 秒）：
 * 扩展在 input 阶段转换，正常几秒内完成；超出窗口的消息要么早已落盘（正文带标记块）、
 * 要么根本不会走桥，再轮询只会让气泡白转圈。
 */
export const VISION_BRIDGE_POLL_WINDOW_MS = 15_000;

export type VisionBridgePollInput = {
	/** 消息是否带图片附件 */
	hasImages: boolean;
	/** 消息正文里是否已有视觉桥标记块（历史消息的转换结果已持久化在文本里） */
	hasInlineBlocks: boolean;
	/** 当前视觉桥配置；null/undefined 表示未配置 */
	visionBridge: VisionBridgeConfig | null | undefined;
	/** 消息发送时间（毫秒时间戳） */
	sentAt: number;
	/** 当前时间（毫秒时间戳） */
	now: number;
	/** 覆盖默认轮询窗口（测试用） */
	windowMs?: number;
};

/**
 * 这条用户消息是否应轮询视觉桥事件文件。
 *
 * 只回答「要不要去找事件」，**不包含模型图片能力判断**：
 * 桌面模型列表（pi --list-models 的 images 列）与 pi 自己的 ctx.model.input 不是同一份数据，
 * 两边不一致时用桌面数据决定“不找”会永久丢卡片（自定义/虚拟模型尤其常见）。
 * 是否展示「转换中」提示由 shouldShowVisionConvertingHint 单独决定，两者职责分开。
 *
 * 仍然不轮询的情况（这些真的不会产生事件）：
 * - 视觉桥未启用/未配齐 → 扩展放行原图；
 * - 历史消息（超出窗口）→ 结果早已写进正文标记块，无需等待；
 * - 时间戳异常（会话文件里的秒级时间戳、缺失时间）→ 按历史处理；
 * - 正文已有标记块 / 没有图片。
 */
export function shouldPollVisionBridge(input: VisionBridgePollInput): boolean {
	if (!input.hasImages || input.hasInlineBlocks) return false;
	if (!isVisionBridgeConfigured(input.visionBridge)) return false;
	if (!Number.isFinite(input.sentAt) || !Number.isFinite(input.now)) return false;

	const ageMs = input.now - input.sentAt;
	const windowMs = input.windowMs ?? VISION_BRIDGE_POLL_WINDOW_MS;
	// 负值过大说明时间戳口径不同（秒/零值），同样视为历史消息不轮询。
	if (!Number.isFinite(ageMs) || ageMs > windowMs || ageMs < -windowMs) return false;
	return true;
}

/**
 * 是否允许显示「视觉桥转换中」提示。
 *
 * 模型明确声明支持图片输入时，扩展会让路（只写让路事件、不做转换），
 * 此时轮询照做（用于拿真实结果），但绝不能先闪一个“正在转换”的假忙碌——
 * 这正是用户实际遇到的误报场景。能力未知（undefined）按“可能转换”处理，允许提示。
 */
export function shouldShowVisionConvertingHint(input: {
	modelSupportsImages: boolean | undefined;
}): boolean {
	return input.modelSupportsImages !== true;
}

/**
 * 评估当前模型与视觉桥配置，决定是否需要向用户提示图片支持情况。
 * - model.images === true：原生支持图片，无提示 (null)；
 * - model.images === false 且视觉桥已配置并启用：提示将通过视觉桥接转换为文字；
 * - model.images === false 且未启用视觉桥：建议切换视觉模型或配置视觉桥；
 * - model.images === undefined：提示模型图片能力未知。
 */
export function getModelImageCapabilityNotice(
	model: AvailableModel | undefined,
	visionBridge: VisionBridgeConfig | undefined,
): ModelImageCapabilityNotice | null {
	if (!model) return null;
	if (model.images === true) return null;

	if (model.images === false) {
		if (isVisionBridgeConfigured(visionBridge)) {
			return { kind: "vision-bridge-active" };
		}
		return { kind: "unsupported-suggest-vision" };
	}

	return { kind: "unknown-capability" };
}
