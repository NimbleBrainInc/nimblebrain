/**
 * What a conversation has already brought into context, read from its history
 * (ADR-0066). The run door feeds it to trigger matching and tool surfacing so a
 * turn's tools and composed skill never shrink from the last turn's: the request
 * prefix changes only when something is added.
 *
 * Both are derived from the recorded history, which only grows, so they need no
 * state of their own. A compaction folds older messages into a summary and so
 * drops what they carried; it rewrites the prefix anyway.
 */
import type { StoredMessage } from "../conversation/types.ts";

export interface ConversationCarry {
  /** The text of each user message, oldest first. */
  userTexts: string[];
  /** Every tool name an assistant message called, in first-call order. */
  calledTools: string[];
}

export function conversationCarry(
  history: readonly StoredMessage[] | undefined,
): ConversationCarry {
  const userTexts: string[] = [];
  const called = new Set<string>();
  for (const message of history ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (message.role === "user" && part.type === "text") userTexts.push(part.text);
      if (message.role === "assistant" && part.type === "tool-call") called.add(part.toolName);
    }
  }
  return { userTexts, calledTools: [...called] };
}

/**
 * The texts a turn's trigger match reads, newest first: the turn's own text,
 * then the earlier user messages. The first one that matches decides, so a
 * match holds for later turns until a newer message matches another skill.
 * `recorded` includes this turn's message (appended before composition), so its
 * last entry is dropped in favour of `current`, the raw text the person typed.
 */
export function matchCandidates(current: string, recorded: readonly string[]): string[] {
  return [current, ...recorded.slice(0, -1).reverse()];
}

/** The first match over {@link matchCandidates}, or null when no text matches. */
export function matchConversation<M>(
  match: (text: string) => M | null,
  current: string,
  recorded: readonly string[],
): M | null {
  for (const text of matchCandidates(current, recorded)) {
    const hit = match(text);
    if (hit) return hit;
  }
  return null;
}
