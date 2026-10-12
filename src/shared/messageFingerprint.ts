import type { ChatMessage } from "./types/session";

/** 去除 provider/终端输出可能携带的 ANSI 控制序列。 */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function imageSignature(message: ChatMessage): string {
	const images = message.images ?? [];
	if (images.length === 0) return "";
	return images
		.map((image) => {
			const data = image.data ?? "";
			const head = data.slice(0, 64);
			const tail = data.length > 128 ? data.slice(-64) : "";
			return `${image.mimeType}:${data.length}:${head}${tail}`;
		})
		.join(",");
}

/**
 * 匹配摘要事件而非投影 id：session 与 runtime 的消息 id 不同，不能据此去重。
 * 两端都有 canonical id 时只认 id；旧数据回退严格的类型/正文/时间/token 指纹，
 * 不把相同正文的不同压缩事件、或分支摘要与压缩摘要合并。
 */
export function isSameSummaryCard(left: ChatMessage, right: ChatMessage): boolean {
	const kind: unknown = left.meta?.type;
	if (
		left.role !== "system" || right.role !== "system" ||
		(kind !== "compaction" && kind !== "branchSummary") || right.meta?.type !== kind
	) return false;
	const idKey = kind === "compaction" ? "compactionId" : "branchSummaryId";
	const leftId: unknown = left.meta?.[idKey];
	const rightId: unknown = right.meta?.[idKey];
	if (typeof leftId === "string" && leftId && typeof rightId === "string" && rightId) {
		return leftId === rightId;
	}
	// 已知接缝/分支来源不同也必须保留，不能因旧投影缺 canonical id 就退化为正文匹配。
	const sourceKey = kind === "compaction" ? "firstKeptEntryId" : "fromId";
	const leftSource: unknown = left.meta?.[sourceKey];
	const rightSource: unknown = right.meta?.[sourceKey];
	if (typeof leftSource === "string" && typeof rightSource === "string" && leftSource !== rightSource) return false;
	return Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp) &&
		left.timestamp === right.timestamp && left.text === right.text &&
		left.meta?.tokensBefore === right.meta?.tokensBefore;
}

/**
 * 跨运行期事件副本与 JSONL 投影副本匹配同一条消息的稳定内容指纹。
 * 两条通道的 message.id 不同，因此不能把 id 当作跨层身份。
 */
export function messageFingerprint(message: ChatMessage): string {
	const toolCallId =
		message.role === "tool"
			? message.meta?.toolCallId
			: undefined;
	if (typeof toolCallId === "string" && toolCallId) {
		return `tool\u0000${toolCallId}`;
	}
	return [
		message.role,
		stripAnsi(message.text),
		stripAnsi(message.thinking ?? ""),
		imageSignature(message),
	].join("\u0000");
}
