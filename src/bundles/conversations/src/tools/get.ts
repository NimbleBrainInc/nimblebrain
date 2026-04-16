/**
 * Handler for conversations__get tool.
 *
 * Load a conversation's full message history.
 * Uses readConversation() from jsonl-reader.ts.
 */

import type { ConversationIndex } from "../index-cache.ts";
import { readConversation } from "../jsonl-reader.ts";

export interface GetInput {
  id: string;
  limit?: number;
}

export async function handleGet(input: GetInput, index: ConversationIndex): Promise<object> {
  const entry = index.get(input.id);
  if (!entry) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const conversation = await readConversation(entry.filePath);
  if (!conversation) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  let { messages } = conversation;

  // When limit is provided, return only the last N messages
  if (input.limit !== undefined && input.limit >= 0) {
    messages = messages.slice(-input.limit);
  }

  return {
    metadata: {
      id: conversation.meta.id,
      title: conversation.meta.title,
      createdAt: conversation.meta.createdAt,
      updatedAt: conversation.meta.updatedAt,
      totalInputTokens: conversation.meta.totalInputTokens,
      totalOutputTokens: conversation.meta.totalOutputTokens,
      lastModel: conversation.meta.lastModel,
      ...(conversation.meta.ownerId ? { ownerId: conversation.meta.ownerId } : {}),
      ...(conversation.meta.visibility ? { visibility: conversation.meta.visibility } : {}),
      ...(conversation.meta.participants ? { participants: conversation.meta.participants } : {}),
    },
    messages,
    totalMessages: conversation.messageCount,
  };
}
