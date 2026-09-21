import type { ChatMessage, ImageContent } from "../../shared/types/session";
import {
	applyImageDisplayBudget,
	MAX_RUNTIME_TOTAL_IMAGE_BASE64_BYTES,
	type ImageBudgetResult,
} from "../../shared/imageLimits";

/**
 * 定位目标消息所在的用户轮次，并计算该轮次内除目标消息自身以外
 * 所有 assistant / tool 已使用的图片 Base64 字节数。
 */
export function computeTurnImageUsedBytes(
	list: ChatMessage[],
	targetMessageId?: string,
): number {
	let targetIdx = -1;
	if (targetMessageId) {
		targetIdx = list.findIndex((m) => m.id === targetMessageId);
	}

	let startIdx = 0;
	let endIdx = list.length - 1;

	if (targetIdx >= 0) {
		// 目标消息在列表中：向前找最近的 user 消息
		for (let i = targetIdx - 1; i >= 0; i--) {
			if (list[i].role === "user") {
				startIdx = i + 1;
				break;
			}
		}
		// 向后找下一个 user 消息
		for (let i = targetIdx + 1; i < list.length; i++) {
			if (list[i].role === "user") {
				endIdx = i - 1;
				break;
			}
		}
	} else {
		// 新追加消息：使用列表中最后一条 user 之后的轮次
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i].role === "user") {
				startIdx = i + 1;
				break;
			}
		}
	}

	let usedBytes = 0;
	for (let i = startIdx; i <= endIdx; i++) {
		const m = list[i];
		if (!m || m.id === targetMessageId) continue;
		if (m.role === "assistant" || m.role === "tool") {
			if (m.images?.length) {
				for (const img of m.images) {
					usedBytes += img.data.length;
				}
			}
		}
	}

	return usedBytes;
}

/**
 * 对 assistant / tool 消息的新图片快照应用展示预算。
 */
export function applyRuntimeMessageImageBudget(
	rawImages: ImageContent[],
	turnUsedBytes: number,
): ImageBudgetResult {
	return applyImageDisplayBudget(rawImages, { currentTurnUsedBytes: turnUsedBytes });
}

/**
 * 针对单个 runtime 内存中的 assistant / tool 图片聚合上限（32 MiB）进行淘汰保护：
 * 从最旧的输出消息开始淘汰图片，写入 runtime-budget-exceeded 提示。
 * 返回最早被修改的 list 索引（未发生修改返回 -1）。
 */
export function enforceRuntimeImageEviction(
	list: ChatMessage[],
	pendingSlideOut?: ChatMessage[],
	maxBytes: number = MAX_RUNTIME_TOTAL_IMAGE_BASE64_BYTES,
): number {
	// 汇总所有展示图片字节（避免同一对象重复计数）
	const countedIds = new Set<string>();
	let totalBytes = 0;

	if (pendingSlideOut) {
		for (const msg of pendingSlideOut) {
			if ((msg.role === "assistant" || msg.role === "tool") && msg.images?.length) {
				countedIds.add(msg.id);
				for (const img of msg.images) {
					totalBytes += img.data.length;
				}
			}
		}
	}

	for (const msg of list) {
		if ((msg.role === "assistant" || msg.role === "tool") && msg.images?.length && !countedIds.has(msg.id)) {
			countedIds.add(msg.id);
			for (const img of msg.images) {
				totalBytes += img.data.length;
			}
		}
	}

	if (totalBytes <= maxBytes) {
		return -1;
	}

	let earliestDirtyIndex = -1;

	// 先淘汰 pendingSlideOut 中的最旧图片
	if (pendingSlideOut) {
		for (const msg of pendingSlideOut) {
			if (totalBytes <= maxBytes) break;
			if ((msg.role === "assistant" || msg.role === "tool") && msg.images?.length) {
				const freed = msg.images.reduce((acc, img) => acc + img.data.length, 0);
				msg.images = undefined;
				msg.imageDisplayNotice = { kind: "runtime-budget-exceeded" };
				totalBytes -= freed;
			}
		}
	}

	// 再淘汰 list 中的最旧图片
	for (let i = 0; i < list.length; i++) {
		if (totalBytes <= maxBytes) break;
		const msg = list[i];
		if ((msg.role === "assistant" || msg.role === "tool") && msg.images?.length) {
			const freed = msg.images.reduce((acc, img) => acc + img.data.length, 0);
			msg.images = undefined;
			msg.imageDisplayNotice = { kind: "runtime-budget-exceeded" };
			totalBytes -= freed;
			if (earliestDirtyIndex === -1 || i < earliestDirtyIndex) {
				earliestDirtyIndex = i;
			}
		}
	}

	return earliestDirtyIndex;
}
