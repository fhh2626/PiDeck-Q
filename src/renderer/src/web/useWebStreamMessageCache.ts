/** Own stream-cache synchronization, including the final ready frame that may contain tool outputs. */
import { useEffect, useRef, type MutableRefObject } from "react";
import type { UIMessage } from "ai";
import { mergeAuthoritativeUiMessages } from "./webMessageMerge";
import { isLocalSseAssistant, sameUiMessage } from "./webMessageMergeHelpers";

export function useWebStreamMessageCache({ sessionId, streaming, messages, cache, setMessages }: {
	sessionId: string;
	streaming: boolean;
	messages: UIMessage[];
	cache: MutableRefObject<Record<string, UIMessage[]>>;
	setMessages: (messages: UIMessage[]) => void;
}): void {
	const lastStreamingSession = useRef<string | null>(null);
	useEffect(() => {
		if (!sessionId) { lastStreamingSession.current = null; return; }
		if (streaming) {
			lastStreamingSession.current = sessionId;
			cache.current[sessionId] = mergeAuthoritativeUiMessages(cache.current[sessionId] ?? [], messages);
			return;
		}
		const streamEnded = lastStreamingSession.current === sessionId;
		lastStreamingSession.current = null;
		// A short SSE response can batch streaming -> ready into one React commit.
		// Metadata-free assistant rows still identify its final frame, unlike disk history.
		if (!streamEnded && !messages.some(isLocalSseAssistant)) return;
		// 不用严格基线清理：同一条 SSE 同时出现在两侧时，那条路径会把两份都丢掉。
		// 空闲快照标志只丢掉「每一段都已被缓存覆盖」的回放克隆，未落盘的尾部仍保留。
		const merged = mergeAuthoritativeUiMessages(cache.current[sessionId] ?? [], messages, {
			dropUnmatchedTrailingPlaceholders: true,
		});
		cache.current[sessionId] = merged;
		// Only the settled stream can write back; never replace useChat mid-stream.
		// useChat may clone the assigned array; compare rows, not array references,
		// otherwise a retained local SSE row would cause an endless ready-state loop.
		if (merged.length !== messages.length || merged.some((row, index) => !sameUiMessage(row, messages[index]))) {
			setMessages(merged);
		}
	}, [sessionId, streaming, messages, cache, setMessages]);
}
