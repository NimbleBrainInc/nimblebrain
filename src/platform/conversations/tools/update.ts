/**
 * Handler for conversations__update tool.
 *
 * Sets a conversation's title by appending a `metadata.title` event — the
 * channel every reader projects the title from. Every reader (this connector's
 * `jsonl-reader`, its index, and the runtime's event reconstructor) takes the
 * title from the LAST `metadata.title` event and falls back to line 1 only when
 * there is none, and the auto-titler appends exactly that event on a
 * conversation's first turn, so a line-1 rewrite would be shadowed.
 */

import { appendFile, readFile } from "node:fs/promises";
import type { ConversationsUpdateOutput } from "../../schemas/conversations.ts";
import type { AccessContext, ConversationIndex } from "../index-cache.ts";
import { readConversationHeader } from "../jsonl-reader.ts";

export interface UpdateInput {
  id: string;
  title: string;
}

export async function handleUpdate(
  input: UpdateInput,
  index: ConversationIndex,
  access?: AccessContext,
): Promise<ConversationsUpdateOutput> {
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

  // Append-only, matching what the store's own `update` writes — so the agent's
  // rename and the auto-titler's are the same kind of record and the last one
  // written is the one every reader sees.
  //
  // A file whose last write was cut short has no trailing newline, and an append
  // onto it would splice the event onto that line and lose both. The store's own
  // `appendEventSync` cannot afford to check — it appends on the hot path
  // without reading the file — but this handler has already read it, so the
  // check is free here.
  const separator = content.endsWith("\n") ? "" : "\n";
  await appendFile(
    filePath,
    `${separator}${JSON.stringify({
      ts: new Date().toISOString(),
      type: "metadata.title",
      title: input.title,
    })}\n`,
  );

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
