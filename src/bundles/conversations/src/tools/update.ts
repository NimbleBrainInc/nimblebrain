/**
 * Handler for conversations__update tool.
 *
 * Updates conversation title by rewriting the metadata line (line 1)
 * of the JSONL file. Uses atomic temp+rename write pattern.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import type { ConversationIndex } from "../index-cache.ts";
import type { ConversationMeta } from "../jsonl-reader.ts";

export interface UpdateInput {
  id: string;
  title: string;
}

export async function handleUpdate(input: UpdateInput, index: ConversationIndex): Promise<object> {
  const entry = index.get(input.id);
  if (!entry) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const filePath = entry.filePath;

  // Read the full file content
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`Conversation file is empty: ${input.id}`);
  }

  // Parse line 1 as metadata
  let meta: ConversationMeta;
  try {
    const raw = JSON.parse(lines[0]!) as Record<string, unknown>;
    meta = raw as unknown as ConversationMeta;
  } catch {
    throw new Error(`Failed to parse metadata for conversation: ${input.id}`);
  }

  // Update the title and updatedAt
  meta.title = input.title;
  meta.updatedAt = new Date().toISOString();

  // Rewrite line 1 with updated metadata
  lines[0] = JSON.stringify(meta);

  // Write all lines to a temp file (same dir, .tmp suffix) then atomic rename
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
  await rename(tmpPath, filePath);

  // Count messages (lines 2+)
  const messageCount = lines.length - 1;

  // Extract preview from first user message
  let preview = "";
  for (let i = 1; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]!) as { role: string; content: string };
      if (msg.role === "user" && typeof msg.content === "string") {
        preview = msg.content;
        break;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount,
    totalInputTokens: meta.totalInputTokens,
    totalOutputTokens: meta.totalOutputTokens,
    lastModel: meta.lastModel,
    preview,
  };
}
