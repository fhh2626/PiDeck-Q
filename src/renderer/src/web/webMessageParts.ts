import type { UIMessage } from "ai";

/**
 * 合并 Web 展示层相邻的同类文本块。
 * SSE 重连后的新 parser 必须重新开启 text/reasoning part；权威快照已包含断线前半段，
 * 因此这里只在渲染前拼接相邻 part，保持一段回复的视觉连续性。工具等其他 part 是边界，
 * 不能跨越合并，否则会破坏真实的 reasoning/text/tool 时序。
 */
export function mergeAdjacentWebMessageParts(
	parts: UIMessage["parts"],
): UIMessage["parts"] {
	const merged: UIMessage["parts"] = [];
	for (const part of parts) {
		const previous = merged.at(-1);
		if (part.type === "reasoning" && previous?.type === "reasoning") {
			merged[merged.length - 1] = {
				...previous,
				text: previous.text + part.text,
			};
			continue;
		}
		if (part.type === "text" && previous?.type === "text") {
			merged[merged.length - 1] = {
				...previous,
				text: previous.text + part.text,
			};
			continue;
		}
		merged.push(part);
	}
	return merged;
}
