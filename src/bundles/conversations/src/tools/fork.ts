/**
 * Handler for conversations__fork tool.
 *
 * Fork a conversation at a message index, creating a new JSONL file
 * with messages copied from the source up to that point.
 * Token counts are recalculated from the copied messages only.
 */

import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AccessContext, ConversationIndex } from "../index-cache.ts";
import type { ConversationMeta, DisplayMessage, DisplayUsage } from "../jsonl-reader.ts";
import { readConversation } from "../jsonl-reader.ts";

export interface ForkInput {
  id: string;
  atMessage?: number;
}

/** Recalculated token totals across copied assistant messages. */
interface CopiedTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  lastModel: string | null;
}

/** Sum input/output tokens and track the last model across copied assistant messages. */
function sumCopiedUsage(messages: DisplayMessage[]): CopiedTotals {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel: string | null = null;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.usage) {
      totalInputTokens += msg.usage.inputTokens;
      totalOutputTokens += msg.usage.outputTokens;
      lastModel = msg.usage.model || lastModel;
    }
  }
  return { totalInputTokens, totalOutputTokens, lastModel };
}

/** Last copied message's timestamp, falling back to `now` when nothing was copied. */
function resolveUpdatedAt(messages: DisplayMessage[], now: string): string {
  if (messages.length === 0) return now;
  return messages[messages.length - 1]?.timestamp ?? now;
}

/** Project a DisplayUsage onto the on-disk usage object, omitting undefined subtotals. */
function buildOnDiskUsage(usage: DisplayUsage): Record<string, unknown> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

/** Build the on-disk `metadata` object (usage, model, tool calls, files) for a copied message. */
function buildOnDiskMetadata(msg: DisplayMessage): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (msg.role === "assistant" && msg.usage) {
    metadata.usage = buildOnDiskUsage(msg.usage);
    metadata.model = msg.usage.model;
    metadata.llmMs = msg.usage.llmMs;
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    metadata.toolCalls = msg.toolCalls;
  }
  if (msg.files) {
    metadata.files = msg.files;
  }
  return metadata;
}

/**
 * Serialize a copied DisplayMessage as one on-disk JSONL line.
 *
 * Project the in-memory DisplayMessage onto the on-disk StoredMessage shape
 * (`metadata.usage` instead of top-level `usage`), so the reader's
 * derived-totals path can see this fork's tokens. Without this, the reader
 * saw `usage` at the wrong level and aggregated zero — masked before by the
 * now-removed line-1 totals fallback.
 */
function messageToOnDiskLine(msg: DisplayMessage): string {
  const onDisk: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp,
    ...(msg.userId ? { userId: msg.userId } : {}),
  };
  const metadata = buildOnDiskMetadata(msg);
  if (Object.keys(metadata).length > 0) {
    onDisk.metadata = metadata;
  }
  return JSON.stringify(onDisk);
}

/** JSONL lines for a fork: metadata header followed by one line per copied message. */
function buildForkLines(meta: ConversationMeta, messages: DisplayMessage[]): string[] {
  const lines = [JSON.stringify(meta)];
  for (const msg of messages) {
    lines.push(messageToOnDiskLine(msg));
  }
  return lines;
}

/** Derive preview from the first copied user message; "" if none was copied. */
function derivePreview(messages: DisplayMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content;
    }
  }
  return "";
}

export async function handleFork(
  input: ForkInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<object> {
  const entry = index.get(input.id, access);
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
  const { totalInputTokens, totalOutputTokens, lastModel } = sumCopiedUsage(messagesToCopy);

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

  const newMeta: ConversationMeta = {
    id: newId,
    createdAt: now,
    // Set updatedAt to last copied message's timestamp (or now if no messages)
    updatedAt: resolveUpdatedAt(messagesToCopy, now),
    title: null,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    lastModel,
    // The fork inherits the source's owner. Stage 1 requires ownerId
    // on every conversation file — without this stamp the new file
    // would be unloadable by `EventSourcedConversationStore.load`
    // (which throws on missing ownerId post-purge).
    ...(conversation.meta.ownerId ? { ownerId: conversation.meta.ownerId } : {}),
  };

  // Build JSONL content: metadata line + message lines.
  const lines = buildForkLines(newMeta, messagesToCopy);

  // Write new file via temp+rename for atomicity
  const dir = dirname(entry.filePath);
  const newPath = join(dir, `${newId}.jsonl`);
  const tmpPath = `${newPath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
  await rename(tmpPath, newPath);

  const preview = derivePreview(messagesToCopy);

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
