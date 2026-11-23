import type { ChatMessage, SessionRuntimeEvent, SessionRuntimePreservedProjection } from "../../../shared/types";
import type { SessionMessageCacheEntry } from "./session-atoms";

type RuntimeOwner = Pick<SessionRuntimeEvent, "agentId" | "runtimeGeneration">;
type OwnedRuntimeWindow = SessionMessageCacheEntry & RuntimeOwner & { source: "runtime" };

/** Require the runtime that actually supplied the cached window, not just the current tab binding. */
function ownsRuntimeWindow(entry: SessionMessageCacheEntry | undefined, owner: RuntimeOwner): entry is OwnedRuntimeWindow {
  return entry?.source === "runtime" && entry.agentId === owner.agentId && entry.runtimeGeneration === owner.runtimeGeneration;
}

/** A replay gap may miss transient metadata but still receive the latest full window. */
export function recoverRuntimeWindowHistory(input: SessionRuntimePreservedProjection & {
  current: SessionMessageCacheEntry | undefined;
  owner: RuntimeOwner;
  preserveHistory: boolean;
  stickyHistory: boolean;
  windowStart: number;
  deliveredSlideOutCount: number;
  isSummaryCard: (message: ChatMessage) => boolean;
}) {
  const { current, owner, preservedProjectionId, preserveHistory, windowStart, isSummaryCard } = input;
  if (!preserveHistory || !ownsRuntimeWindow(current, owner)) return { stickyHistory: input.stickyHistory };
  if (preservedProjectionId !== current.preservedProjectionId) {
    return { stickyHistory: input.stickyHistory || preservedProjectionId !== undefined };
  }
  // Within a projection the absolute start advances only for trimmed rows. The
  // frame's slide-out covers the newest of them; recover only the missing head.
  const trimmed = windowStart - (current.windowStart ?? 0) - input.deliveredSlideOutCount;
  if (input.stickyHistory || trimmed <= 0) return { stickyHistory: input.stickyHistory };
  const trimmedPrefix = current.messages.filter((message) => !isSummaryCard(message)
    && message.meta?.optimistic !== true && message.meta?.slidingOut !== true).slice(0, trimmed);
  return { stickyHistory: false, trimmedPrefix };
}

/** Complete a cached assistant shell if the authoritative row did not arrive first. */
export function settleRuntimeAssistantShell(entry: SessionMessageCacheEntry | undefined, owner: RuntimeOwner, messageId: string, text: string) {
  if (!text || !ownsRuntimeWindow(entry, owner)) return;
  const index = entry.messages.findIndex((message) => message.id === messageId
    && message.role === "assistant" && !message.text && message.meta?.slidingOut !== true);
  if (index < 0) return;
  // Preserve the canonical slot and all positional metadata for future deltas.
  const messages = entry.messages.slice();
  messages[index] = { ...messages[index], text };
  return { ...entry, messages, revision: entry.revision + 1 };
}
