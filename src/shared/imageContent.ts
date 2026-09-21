import type { ImageContent } from "./types/session";

export type ImageExtractionResult = {
	images: ImageContent[];
	invalidCount: number;
};

const SUPPORTED_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/**
 * 校验标准 base64 格式（非空，仅限标准 A-Z, a-z, 0-9, +, /，合法填充 =，且长度为 4 的倍数）。
 * 不接受 base64url 字符（-、_）、data URL 头部、包含空格或非法填充。
 */
function isValidBase64(str: string): boolean {
	if (typeof str !== "string" || str.length === 0 || str.length % 4 !== 0) {
		return false;
	}
	let padding = 0;
	if (str.endsWith("==")) {
		padding = 2;
	} else if (str.endsWith("=")) {
		padding = 1;
	}

	const dataLen = str.length - padding;
	for (let i = 0; i < dataLen; i++) {
		const code = str.charCodeAt(i);
		const isUpper = code >= 65 && code <= 90; // A-Z
		const isLower = code >= 97 && code <= 122; // a-z
		const isDigit = code >= 48 && code <= 57; // 0-9
		const isPlus = code === 43; // +
		const isSlash = code === 47; // /
		if (!isUpper && !isLower && !isDigit && !isPlus && !isSlash) {
			return false;
		}
	}
	return true;
}

/**
 * 规范化 MIME 类型：去空白、转小写。
 * 若字段缺失（undefined），默认回退到 image/png；
 * 若显式提供但为空字符串、null、非字符串或不在支持列表中，返回 null 标记为非法。
 */
function normalizeMimeType(rawMime: unknown): string | null {
	if (rawMime === undefined) {
		return "image/png";
	}
	if (typeof rawMime !== "string" || !rawMime.trim()) {
		return null;
	}
	const normalized = rawMime.trim().toLowerCase();
	return SUPPORTED_MIME_TYPES.has(normalized) ? normalized : null;
}

/**
 * 从未知内容块中纯函数式提取结构化图片内容。
 * 兼容平铺格式 {type: "image", data, mimeType|mime_type} 与旧嵌套格式 {type: "image", source: {type: "base64", data, media_type}}。
 * 不丢弃合法兄弟块，统计无效块数量。
 */
export function extractImageContent(content: unknown): ImageExtractionResult {
	if (!Array.isArray(content)) {
		return { images: [], invalidCount: 0 };
	}

	const images: ImageContent[] = [];
	let invalidCount = 0;

	for (const block of content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) {
			continue;
		}

		const typed = block as Record<string, unknown>;
		if (typed.type !== "image") {
			continue;
		}

		// 1. 平铺表示优先：{ type: "image", data: string, mimeType?: string, mime_type?: string }
		let rawData: unknown = typed.data;
		let rawMime: unknown = typed.mimeType !== undefined ? typed.mimeType : typed.mime_type;

		// 2. 嵌套表示后备：{ type: "image", source: { type: "base64", data: string, media_type?: string } }
		if ((rawData === undefined || rawData === null) && typed.source && typeof typed.source === "object") {
			const source = typed.source as Record<string, unknown>;
			if (source.type === "base64") {
				rawData = source.data;
				rawMime = source.mimeType !== undefined ? source.mimeType : source.media_type;
			}
		}

		if (typeof rawData !== "string" || !rawData.trim()) {
			invalidCount++;
			continue;
		}

		const cleanData = rawData.trim();
		if (!isValidBase64(cleanData)) {
			invalidCount++;
			continue;
		}

		const mimeType = normalizeMimeType(rawMime);
		if (!mimeType) {
			invalidCount++;
			continue;
		}

		images.push({
			type: "image",
			data: cleanData,
			mimeType,
		});
	}

	return { images, invalidCount };
}
