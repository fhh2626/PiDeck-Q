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
		// This is a live final frame, not a disk baseline: strict coverage cleanup
		// can discard both copies when the same SSE row exists on both sides.
		const merged = mergeAuthoritativeUiMessages(cache.current[sessionId] ?? [], messages);
		cache.current[sessionId] = merged;
		// Only the settled stream can write back; never replace useChat mid-stream.
		// useChat may clone the assigned array; compare rows, not array references,
		// otherwise a retained local SSE row would cause an endless ready-state loop.
		if (merged.length !== messages.length || merged.some((row, index) => !sameUiMessage(row, messages[index]))) {
			setMessages(merged);
		}
	}, [sessionId, streaming, messages, cache, setMessages]);
}
