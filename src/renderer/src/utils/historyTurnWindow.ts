import type { ChatMessage } from "../../../shared/types";

/** User prompts and read-only task goals start turns; diagnostics, tools and assistants do not. */
function startsHistoryTurn(message: ChatMessage): boolean {
  return message.role === "user" || (message.role === "system" && message.meta?.type === "todoTask");
}

/** Only turn starts consume a history-window slot. */
export function countUserTurns(messages: readonly ChatMessage[]): number {
  let turns = 0;
  for (const message of messages) if (startsHistoryTurn(message)) turns++;
  return turns;
}

/**
 * Preserve the last N complete user turns. Insufficient turns retain leading fragments;
 * nonpositive requests return no messages. This is not the display-page byte-budget policy.
 */
export function keepTailTurns(messages: ChatMessage[], turnCount: number): ChatMessage[] {
  if (turnCount <= 0) return [];
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!startsHistoryTurn(messages[index])) continue;
    if (++seen === turnCount) return messages.slice(index);
  }
  return messages;
}
