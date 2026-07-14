/**
 * Handler for conversations__get tool.
 *
 * Loads a conversation. Defaults to a bounded read: metadata + the most
 * recent `limit` messages, with a hard char cap on the merged message
 * payload. Callers opt into a metadata-only or full-transcript read via
 * `expand`. The full transcript is intentionally opt-in: in prod we saw
 * 897 KB tool results from agents calling `conversations__get` against
 * long conversations, blowing through the model's context window via a
 * single tool call.
 */

import type { AccessContext, ConversationIndex } from "../index-cache.ts";
import { readConversation } from "../jsonl-reader.ts";

export interface GetInput {
  id: string;
  expand?: "metadata" | "messages" | "full";
  limit?: number;
}

/** Default number of trailing messages returned in "messages" mode. */
export const DEFAULT_GET_LIMIT = 20;

/**
 * Soft cap on the serialized size of returned messages in "messages" mode,
 * measured against compact `JSON.stringify(msg).length` summed across
 * messages. If the selected window exceeds this, older messages are
 * dropped from the response (most-recent-wins) and a truncation note is
 * emitted.
 *
 * Sized to stay under the engine's `MAX_TOOL_RESULT_CHARS` (50,000) after
 * (a) the wrapper object is added, and (b) the final result is serialized
 * with `JSON.stringify(result, null, 2)` — pretty-print typically inflates
 * a nested message array by 30–50%. 30k of compact messages → ~40–45 KB
 * pretty-printed total, comfortably under the engine cap. The result shape
 * below puts `truncated` / `droppedOlderMessages` / `truncationHint` ahead
 * of `messages` so the flags survive even if the engine ever does slice.
 */
export const DEFAULT_GET_CHAR_CAP = 30_000;

interface GetMessagesResult {
  messages: unknown[];
  /** Count of messages omitted from the front of the selected window. */
  droppedOlderMessages: number;
  /** True when the char cap forced messages to be dropped. */
  truncated: boolean;
}

function selectByCharCap(messages: unknown[], cap: number): GetMessagesResult {
  if (cap <= 0 || messages.length === 0) {
    return { messages, droppedOlderMessages: 0, truncated: false };
  }
  // Walk newest → oldest, keeping messages whose cumulative size fits.
  // Always keep at least one (the most recent) so the response is useful
  // even if a single message exceeds the cap.
  const kept: unknown[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = JSON.stringify(messages[i]).length;
    if (kept.length > 0 && used + size > cap) break;
    kept.unshift(messages[i]);
    used += size;
  }
  const dropped = messages.length - kept.length;
  return { messages: kept, droppedOlderMessages: dropped, truncated: dropped > 0 };
}

export async function handleGet(
  input: GetInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<object> {
  // `index.get` returns undefined for both not-found and exists-but-
  // not-yours when `access` is supplied — one error message, no leak.
  const entry = index.get(input.id, access);
  if (!entry) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const conversation = await readConversation(entry.filePath);
  if (!conversation) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const metadata = {
    id: conversation.meta.id,
    title: conversation.meta.title,
    createdAt: conversation.meta.createdAt,
    updatedAt: conversation.meta.updatedAt,
    totalInputTokens: conversation.meta.totalInputTokens,
    totalOutputTokens: conversation.meta.totalOutputTokens,
    lastModel: conversation.meta.lastModel,
    ...(conversation.meta.ownerId ? { ownerId: conversation.meta.ownerId } : {}),
    // The workspace the conversation is sealed to. Surfaced so a client that
    // holds an open conversation can tell which workspace it belongs to — the
    // web chat panel uses it to avoid resuming a conversation from a workspace
    // the user is no longer viewing (a fresh draft is started instead). Absent
    // on legacy records predating the workspace-owned layout (those read as the
    // owner's personal workspace); absence therefore means "don't reconcile".
    ...(conversation.meta.workspaceId ? { workspaceId: conversation.meta.workspaceId } : {}),
  };

  const expand = input.expand ?? "messages";

  if (expand === "metadata") {
    return {
      metadata,
      messages: [],
      totalMessages: conversation.messageCount,
    };
  }

  if (expand === "full") {
    // Explicit opt-in to the full transcript. No limit, no char cap.
    // Caller has acknowledged the cost.
    return {
      metadata,
      messages: conversation.messages,
      totalMessages: conversation.messageCount,
    };
  }

  // Default: most-recent `limit` messages, with a char-cap safety net.
  const limit = input.limit !== undefined && input.limit >= 0 ? input.limit : DEFAULT_GET_LIMIT;
  const windowed = conversation.messages.slice(-limit);
  const { messages, droppedOlderMessages, truncated } = selectByCharCap(
    windowed,
    DEFAULT_GET_CHAR_CAP,
  );

  // Field order matters: small flags first, large `messages` last. The
  // engine's per-result cap (`MAX_TOOL_RESULT_CHARS`) slices the
  // pretty-printed JSON from the END if anything ever overshoots, so
  // putting `truncated` / `droppedOlderMessages` / `truncationHint` ahead
  // of `messages` keeps the diagnostic flags intact in the worst case.
  return {
    metadata,
    totalMessages: conversation.messageCount,
    ...(truncated
      ? {
          truncated: true,
          droppedOlderMessages,
          truncationHint: `Returned ${messages.length} of the requested ${windowed.length} trailing messages; the older ${droppedOlderMessages} exceeded the ${DEFAULT_GET_CHAR_CAP}-char response budget. Use expand:"full" only if you genuinely need the entire transcript, or narrow the limit and request specific ranges.`,
        }
      : {}),
    messages,
  };
}
