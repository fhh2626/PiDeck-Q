import type { ChatMessage } from "../../../shared/types";

/** Only users start turns; summary cards, tools and assistants never consume a turn slot. */
export function countUserTurns(messages: readonly ChatMessage[]): number {
  let turns = 0;
  for (const message of messages) if (message.role === "user") turns++;
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
    if (messages[index].role !== "user") continue;
    if (++seen === turnCount) return messages.slice(index);
  }
  return messages;
}
