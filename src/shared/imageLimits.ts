import type { ImageContent, ImageDisplayNotice } from "./types/session";

/** 单张工具图片 base64 上限：4 MiB */
export const MAX_TOOL_IMAGE_SINGLE_BASE64_BYTES = 4 * 1024 * 1024;

/** 单条消息最大工具图片张数：8 张 */
export const MAX_TOOL_IMAGES_PER_MESSAGE = 8;

/** 单条消息/每轮最大工具图片 base64 聚合上限：8 MiB */
export const MAX_TOOL_IMAGE_MESSAGE_BASE64_BYTES = 8 * 1024 * 1024;

/** 单个 runtime 内存中所有消息的图片 base64 聚合上限：32 MiB */
export const MAX_RUNTIME_TOTAL_IMAGE_BASE64_BYTES = 32 * 1024 * 1024;

/** 单批消息下发总预算上限（留出安全余量给 JSON 框架和文本）：30 MiB */
export const MAX_MESSAGE_DELIVERY_TOTAL_IMAGE_BASE64_BYTES = 30 * 1024 * 1024;

export type ImageBudgetResult = {
	images: ImageContent[];
	notice?: ImageDisplayNotice;
};

/**
 * 针对工具/助手消息的图片展示预算处理（纯函数）：
 * 1. 单图超过 maxSingleBytes（默认 4 MiB）直接剔除；
 * 2. 数量超过 maxImages（默认 8 张）或单轮总字节数超过 maxTotalBytes（默认 8 MiB）进行截断；
 * 3. 若有剔除或截断，返回相应的 imageDisplayNotice。
 */
export function applyImageDisplayBudget(
	rawImages: ImageContent[],
	options?: {
		maxSingleBytes?: number;
		maxImages?: number;
		maxTotalBytes?: number;
		currentTurnUsedBytes?: number;
	},
): ImageBudgetResult {
	if (!rawImages || rawImages.length === 0) {
		return { images: [] };
	}

	const maxSingleBytes = options?.maxSingleBytes ?? MAX_TOOL_IMAGE_SINGLE_BASE64_BYTES;
	const maxImages = options?.maxImages ?? MAX_TOOL_IMAGES_PER_MESSAGE;
	const maxTotalBytes = options?.maxTotalBytes ?? MAX_TOOL_IMAGE_MESSAGE_BASE64_BYTES;
	let currentTurnUsed = options?.currentTurnUsedBytes ?? 0;

	const validImages: ImageContent[] = [];
	let oversizedCount = 0;

	// 1. 单图大小检查
	for (const img of rawImages) {
		if (img.data.length > maxSingleBytes) {
			oversizedCount++;
		} else {
			validImages.push(img);
		}
	}

	// 2. 数量与单轮总字节数预算检查
	const finalImages: ImageContent[] = [];
	let budgetExceededCount = 0;

	for (let i = 0; i < validImages.length; i++) {
		const img = validImages[i];
		if (finalImages.length >= maxImages) {
			budgetExceededCount++;
			continue;
		}
		if (currentTurnUsed + img.data.length > maxTotalBytes) {
			budgetExceededCount++;
			continue;
		}
		finalImages.push(img);
		currentTurnUsed += img.data.length;
	}

	let notice: ImageDisplayNotice | undefined;
	if (oversizedCount > 0) {
		notice = {
			kind: "too-large",
			count: rawImages.length,
			omitted: oversizedCount + budgetExceededCount,
		};
	} else if (budgetExceededCount > 0) {
		notice = {
			kind: "too-many",
			count: rawImages.length,
			omitted: budgetExceededCount,
		};
	}

	return { images: finalImages, notice };
}

