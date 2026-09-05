/**
 * Handler for conversations__update tool.
 *
 * Sets a conversation's title through whichever channel that file's readers
 * actually project the title from — an appended `metadata.title` event for an
 * event-sourced conversation, the line-1 metadata for a legacy one.
 */

import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import type { AccessContext, ConversationIndex } from "../index-cache.ts";
import {
  type ConversationMeta,
  looksLikeEventLine,
  readConversationHeader,
} from "../jsonl-reader.ts";

export interface UpdateInput {
  id: string;
  title: string;
}

/**
 * Which channel carries the title for this file.
 *
 * Every reader — this bundle's `jsonl-reader`, its index, and the runtime's
 * event reconstructor — takes the title from the LAST `metadata.title` event
 * and falls back to line 1 only when there is none. The auto-titler appends
 * exactly that event on a conversation's first turn, so on an event-sourced
 * file a line-1 rewrite is shadowed: the write lands, every reader keeps
 * returning the older title, and the caller is told it succeeded.
 *
 * The inverse holds for a legacy file. Its messages are plain lines and the
 * reader picks its parser by asking whether ANY line looks like an event
 * (`format: "events"` or {@link looksLikeEventLine}), so appending an event to
 * one flips it onto the event reducer, which finds no messages in it — a
 * rename would empty the conversation. Line 1 is the only title channel a
 * legacy file has, and it is unshadowed there.
 *
 * Read with the reader's own predicate rather than a second copy of the
 * heuristic, so the two cannot drift into disagreeing about one file.
 */
function isEventSourced(lines: string[]): boolean {
  const raw = safeParse(lines[0]);
  if (raw?.format === "events") return true;
  return lines.slice(1).some(looksLikeEventLine);
}

function safeParse(line: string | undefined): Record<string, unknown> | null {
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Rewrite line 1's title in place, atomically (temp + rename). */
async function writeLegacyTitle(
  filePath: string,
  lines: string[],
  id: string,
  title: string,
): Promise<void> {
  const raw = safeParse(lines[0]);
  if (!raw) throw new Error(`Failed to parse metadata for conversation: ${id}`);
  const meta = raw as unknown as ConversationMeta;
  meta.title = title;
  meta.updatedAt = new Date().toISOString();
  lines[0] = JSON.stringify(meta);

  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmpPath, lines.map((l) => `${l}\n`).join(""));
  await rename(tmpPath, filePath);
}

export async function handleUpdate(
  input: UpdateInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<object> {
  const entry = index.get(input.id, access);
  if (!entry) {
    throw new Error(`Conversation not found: ${input.id}`);
  }

  const filePath = entry.filePath;
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`Conversation file is empty: ${input.id}`);
  }

  if (isEventSourced(lines)) {
    // Append-only, matching what the store's own `update` writes — so the
    // agent's rename and the auto-titler's are the same kind of record and the
    // last one written is the one every reader sees.
    //
    // A file whose last write was cut short has no trailing newline, and an
    // append onto it would splice the event onto that line and lose both. The
    // store's own `appendEventSync` cannot afford to check — it appends on the
    // hot path without reading the file — but this handler has already read it
    // to pick a branch, so the check is free here.
    const separator = content.endsWith("\n") ? "" : "\n";
    await appendFile(
      filePath,
      `${separator}${JSON.stringify({
        ts: new Date().toISOString(),
        type: "metadata.title",
        title: input.title,
      })}\n`,
    );
  } else {
    await writeLegacyTitle(filePath, lines, input.id, input.title);
  }

  // This handler writes the file itself rather than going through the store, so
  // the store's `onMutate` never fires for it. The index refreshes only what is
  // named, so without this the renamed title is stale until something else
  // names this conversation.
  index.invalidate({ id: entry.id, filePath, wsId: entry.workspaceId });

  // Report what a reader would now project, not what this handler just wrote.
  // Building the response from a local mutation is what let a shadowed write
  // echo back as success.
  const header = await readConversationHeader(filePath);
  if (!header) {
    throw new Error(`Failed to read conversation after update: ${input.id}`);
  }

  return {
    id: header.meta.id,
    title: header.meta.title,
    createdAt: header.meta.createdAt,
    updatedAt: header.meta.updatedAt,
    messageCount: header.messageCount,
    totalInputTokens: header.meta.totalInputTokens,
    totalOutputTokens: header.meta.totalOutputTokens,
    lastModel: header.meta.lastModel,
    preview: header.preview,
  };
}
