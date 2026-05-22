/**
 * Shared metadata-line helpers for top-level conversation JSONL files.
 *
 * Conversations are stored at `{workDir}/conversations/<convId>.jsonl`
 * post-Stage-1. The first line is a JSON metadata object whose fields
 * (id, ownerId, workspaceId, etc.) are read on every conversation
 * lookup. Subsequent lines are the append-only event log and MUST be
 * preserved byte-identical when the metadata is rewritten.
 *
 * Migrations and heals that rename workspace ids reach into the
 * metadata line to update the `workspaceId` field. Three sites needed
 * this logic prior to extraction (`migrate-personal-workspaces.ts` plus
 * two copies in `heal-truncated-personal-workspaces.ts`). Future
 * workspace-id-renaming migrations should reuse this helper.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

/**
 * Read the metadata line (line 1) of a top-level conversation JSONL.
 * Returns null if the file is unreadable, the metadata line is not
 * valid JSON, or the file has no newline (single-line file is malformed
 * — leave it alone). Callers treat null as "skip this file."
 */
export async function readConversationMetadata(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const newlineIdx = raw.indexOf("\n");
    const firstLine = newlineIdx < 0 ? raw : raw.slice(0, newlineIdx);
    return JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Rewrite the metadata line of a conversation JSONL so its
 * `workspaceId` field reflects a workspace id rename. Returns true if
 * the file was rewritten, false if the metadata's `workspaceId`
 * didn't match `oldId` (already migrated, different workspace, or
 * malformed metadata). Other lines pass through byte-identical via
 * tmp-file + atomic rename.
 */
export async function rewriteConversationWorkspaceId(
  filePath: string,
  oldId: string,
  newId: string,
): Promise<boolean> {
  const raw = await readFile(filePath, "utf-8");
  const newlineIdx = raw.indexOf("\n");
  if (newlineIdx < 0) return false;

  const metadataLine = raw.slice(0, newlineIdx);
  const rest = raw.slice(newlineIdx); // includes the leading \n

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metadataLine);
  } catch {
    return false;
  }
  if (meta.workspaceId !== oldId) return false;
  meta.workspaceId = newId;
  const newMetadata = JSON.stringify(meta);

  const tmp = `${filePath}.tmp.${Date.now()}`;
  await writeFile(tmp, `${newMetadata}${rest}`, { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
  return true;
}
