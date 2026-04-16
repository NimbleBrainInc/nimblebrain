/**
 * Handler for conversations__fork tool.
 *
 * Fork a conversation at a message index, creating a new JSONL file
 * with messages copied from the source up to that point.
 * Token counts are recalculated from the copied messages only.
 */

import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationIndex } from "../index-cache.ts";
import type { ConversationMeta } from "../jsonl-reader.ts";
import { readConversation } from "../jsonl-reader.ts";

export interface ForkInput {
  id: string;
  atMessage?: number;
}

export async function handleFork(input: ForkInput, index: ConversationIndex): Promise<object> {
  const entry = index.get(input.id);
  if (!entry) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const conversation = await readConversation(entry.filePath);
  if (!conversation) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  // Determine which messages to copy
  const messagesToCopy =
    input.atMessage !== undefined
      ? conversation.messages.slice(0, input.atMessage)
      : conversation.messages;

  // Generate new ID: conv_<16 random hex chars>
  const newId = `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  // Recalculate token counts from copied assistant messages
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let lastModel: string | null = null;

  for (const msg of messagesToCopy) {
    if (msg.role === "assistant" && msg.metadata) {
      totalInputTokens += msg.metadata.inputTokens ?? 0;
      totalOutputTokens += msg.metadata.outputTokens ?? 0;
      totalCostUsd += msg.metadata.costUsd ?? 0;
      lastModel = msg.metadata.model ?? lastModel;
    }
  }

  // Set updatedAt to last copied message's timestamp (or now if no messages)
  const updatedAt =
    messagesToCopy.length > 0 ? (messagesToCopy[messagesToCopy.length - 1]?.timestamp ?? now) : now;

  const newMeta: ConversationMeta = {
    id: newId,
    createdAt: now,
    updatedAt,
    title: null,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    lastModel,
  };

  // Build JSONL content: metadata line + message lines
  const lines = [JSON.stringify(newMeta)];
  for (const msg of messagesToCopy) {
    lines.push(JSON.stringify(msg));
  }

  // Write new file via temp+rename for atomicity
  const dir = dirname(entry.filePath);
  const newPath = join(dir, `${newId}.jsonl`);
  const tmpPath = `${newPath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
  await rename(tmpPath, newPath);

  // Derive preview from first user message
  let preview = "";
  for (const msg of messagesToCopy) {
    if (msg.role === "user" && typeof msg.content === "string") {
      preview = msg.content;
      break;
    }
  }

  return {
    id: newId,
    title: null,
    createdAt: newMeta.createdAt,
    updatedAt: newMeta.updatedAt,
    messageCount: messagesToCopy.length,
    totalInputTokens,
    totalOutputTokens,
    lastModel,
    preview,
  };
}
