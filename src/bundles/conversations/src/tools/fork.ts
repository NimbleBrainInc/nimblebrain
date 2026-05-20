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
  const entry = await index.get(input.id);
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
  let lastModel: string | null = null;

  for (const msg of messagesToCopy) {
    if (msg.role === "assistant" && msg.usage) {
      totalInputTokens += msg.usage.inputTokens;
      totalOutputTokens += msg.usage.outputTokens;
      lastModel = msg.usage.model || lastModel;
    }
  }
  // KNOWN REGRESSION from StoredMessage era:
  // The old shape persisted `costUsd` per assistant message (computed by
  // the runtime at write-time using its own price table). DisplayMessage
  // intentionally doesn't carry cost — the bundle is decoupled from the
  // runtime's pricing logic, and `totalCostUsd` on the parent conversation
  // file is an aggregate across all messages, not per-message.
  //
  // Rather than duplicate a price table inside the bundle, forks start at
  // totalCostUsd=0; it can be recomputed live from (inputTokens, outputTokens,
  // model) by any consumer that owns pricing. Documented in CHANGELOG.
  const totalCostUsd = 0;

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

  // Build JSONL content: metadata line + message lines.
  //
  // Project the in-memory DisplayMessage onto the on-disk StoredMessage
  // shape (`metadata.usage` instead of top-level `usage`), so the reader's
  // derived-totals path can see this fork's tokens. Without this, the
  // reader saw `usage` at the wrong level and aggregated zero — masked
  // before by the now-removed line-1 totals fallback.
  const lines = [JSON.stringify(newMeta)];
  for (const msg of messagesToCopy) {
    const onDisk: Record<string, unknown> = {
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      ...(msg.userId ? { userId: msg.userId } : {}),
    };
    const metadata: Record<string, unknown> = {};
    if (msg.role === "assistant" && msg.usage) {
      metadata.usage = {
        inputTokens: msg.usage.inputTokens,
        outputTokens: msg.usage.outputTokens,
        ...(msg.usage.cacheReadTokens !== undefined
          ? { cacheReadTokens: msg.usage.cacheReadTokens }
          : {}),
        ...(msg.usage.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: msg.usage.cacheWriteTokens }
          : {}),
        ...(msg.usage.reasoningTokens !== undefined
          ? { reasoningTokens: msg.usage.reasoningTokens }
          : {}),
      };
      metadata.model = msg.usage.model;
      metadata.llmMs = msg.usage.llmMs;
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      metadata.toolCalls = msg.toolCalls;
    }
    if (msg.files) {
      metadata.files = msg.files;
    }
    if (Object.keys(metadata).length > 0) {
      onDisk.metadata = metadata;
    }
    lines.push(JSON.stringify(onDisk));
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
