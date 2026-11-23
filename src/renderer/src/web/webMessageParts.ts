import type { UIMessage } from "ai";

/**
 * 合并 Web 展示层相邻的同类文本块。
 * SSE 重连后的新 parser 必须重新开启 text/reasoning part；权威快照已包含断线前半段，
 * 因此这里只在渲染前拼接相邻 part，保持一段回复的视觉连续性。工具等其他 part 是边界，
 * 不能跨越合并，否则会破坏真实的 reasoning/text/tool 时序。
 */
export function isWebToolPart(part: UIMessage["parts"][number]): boolean {
	return part.type === "dynamic-tool"
		|| (typeof part.type === "string" && part.type.startsWith("tool-"));
}

/** Real terminal evidence wins; pending states use event order so a live restart clears unknown. */
function webToolPartStrength(part: UIMessage["parts"][number]): number {
	if (!isWebToolPart(part)) return 0;
	const state = Reflect.get(part, "state");
	if (state === "output-available" || state === "output-error") return 3;
	return 1;
}

/**
 * 同一 toolCallId 在一条 UI 消息里只能保留一个 part。
 *
 * 背景：ai@7 的 tool-input-* 帧只在「当前 step」里按 toolCallId 查找 part，跨 step 的
 * 更新会 push 出第二条 part（典型：重连回放到一半的工具 + 收尾的「结果未记录」标记），
 * 于是同一个调用同时显示成「运行中」和「未知」。翻译层已经不让 step 边界切开活跃工具，
 * 这里再做一层纯展示收口：位置取首次出现（保持真实时序），内容取证据最强的一条。
 */
export function collapseDuplicateWebToolParts(
	parts: UIMessage["parts"],
): UIMessage["parts"] {
	const positions = new Map<string, number>();
	const kept: UIMessage["parts"] = [];
	for (const part of parts) {
		const toolCallId = isWebToolPart(part) ? Reflect.get(part, "toolCallId") : undefined;
		if (typeof toolCallId !== "string" || !toolCallId) {
			kept.push(part);
			continue;
		}
		const first = positions.get(toolCallId);
		if (first === undefined) {
			positions.set(toolCallId, kept.length);
			kept.push(part);
			continue;
		}
		// Equal-strength updates use the latest observation, including real live
		// input after unknown. An input/unknown replay can never erase a result.
		if (webToolPartStrength(part) >= webToolPartStrength(kept[first])) kept[first] = part;
	}
	return kept.length === parts.length ? parts : kept;
}

/** Compare message content including attachments, ignoring transport-only text state/steps. */
export function webMessageContentKey(message: UIMessage): string {
	return JSON.stringify(message.parts.filter((part) => part.type !== "step-start")
		.map((part) => part.type === "text" || part.type === "reasoning"
			? { type: part.type, text: part.text } : part));
}

export function mergeAdjacentWebMessageParts(
	parts: UIMessage["parts"],
): UIMessage["parts"] {
	const merged: UIMessage["parts"] = [];
	for (const part of parts) {
		const previous = merged.at(-1);
		if (part.type === "reasoning" && previous?.type === "reasoning") {
			// Reasoning parts have no replay identity or offset either; never discard by text overlap.
			merged[merged.length - 1] = {
				...previous,
				text: previous.text + part.text,
			};
			continue;
		}
		if (part.type === "text" && previous?.type === "text") {
			// AI SDK part state is not protocol evidence of replay; preserve every streamed
			// character unless the wire format supplies an identity/offset to prove overlap.
			merged[merged.length - 1] = {
				...previous,
				text: previous.text + part.text,
			};
			continue;
		}
		merged.push(part);
	}
	// 同一 toolCallId 的重复 part（跨 step 复制）只能留一条，否则 UI 会同时转圈和报未知。
	return collapseDuplicateWebToolParts(merged);
}

/** 消息仍在流时，只有最后一段未完成 reasoning 扫光；前面的思考卡保持结束态。 */
export function isWebReasoningPartRunning(
	parts: UIMessage["parts"],
	index: number,
	messageStreaming: boolean,
): boolean {
	if (!messageStreaming) return false;
	const part = parts[index];
	if (!part || part.type !== "reasoning") return false;
	const rest = parts.slice(index + 1);
	if (rest.some((item) => item.type === "reasoning")) return false;
	if (rest.some((item) => isWebToolPart(item))) return false;
	if (rest.some((item) => item.type === "text" && item.text.trim())) return false;
	return true;
}
