import type { AvailableModel, VisionBridgeConfig } from "../../../shared/types";

export type ModelImageNoticeKind =
	| "vision-bridge-active"
	| "unsupported-suggest-vision"
	| "unknown-capability";

export type ModelImageCapabilityNotice = {
	kind: ModelImageNoticeKind;
};

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
		if (visionBridge?.enabled && Boolean(visionBridge.model)) {
			return { kind: "vision-bridge-active" };
		}
		return { kind: "unsupported-suggest-vision" };
	}

	return { kind: "unknown-capability" };
}
