/**
 * The single sanctioned construction (and parse) site for workspace-partitioned file
 * paths. Mirrors `src/conversation/paths.ts`: every file directory is built and
 * parsed here, so the on-disk layout has exactly one definition.
 *
 * The workspace owns the directory: a file lives under the workspace it was
 * created in, with the owner as a
 * privacy sub-partition. Each owner partition is self-contained — it holds the
 * bytes, the per-owner `registry.jsonl` catalog, and the extracted-text
 * sidecars — so a `FileStore` rooted at the owner partition (like the
 * conversation store) gets owner-isolation and cross-workspace denial by
 * construction. A `files://<id>` URI stays bare; the workspace comes from the
 * ambient request, never the URI.
 *
 *   workspaces/<wsId>/files/<ownerId>/registry.jsonl        per-owner catalog
 *   workspaces/<wsId>/files/<ownerId>/<fileId>_<name>       owner-private bytes
 *
 * This file is on the allow-list of `check:workspace-paths` (it defines the
 * `workspaces/<wsId>/files/...` layout) and is the only site `check:file-paths`
 * permits to construct a workspace files dir.
 */

import { join, sep } from "node:path";

const FILES_SEGMENT = "files";
const WORKSPACES_SEGMENT = "workspaces";

/**
 * Directory holding one owner's files in one workspace:
 * `{workDir}/workspaces/<wsId>/files/<ownerId>`.
 */
export function workspaceFilesDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, FILES_SEGMENT, ownerId);
}

/** What a parsed file path resolves to. */
export interface ParsedFilesPath {
  wsId: string;
  ownerId: string;
}

/**
 * Inverse of the builder: recover `{ wsId, ownerId }` from a file path under a
 * `workspaces/<wsId>/files/<ownerId>/...` subtree. Returns `null` for a path
 * that isn't one (e.g. a legacy `users/<id>/files/...` path). Used by the
 * migration and tests to label destinations. Note: a per-owner
 * `<ownerId>/registry.jsonl` parses as an owner-partition path (ownerId set,
 * filename ignored) — callers pass file paths, not the registry.
 */
export function parseFilesPath(absPath: string): ParsedFilesPath | null {
  const segments = absPath.split(sep);
  const wsIdx = segments.lastIndexOf(WORKSPACES_SEGMENT);
  if (wsIdx === -1) return null;
  const wsId = segments[wsIdx + 1];
  const filesSeg = segments[wsIdx + 2];
  const ownerId = segments[wsIdx + 3];
  if (!wsId || filesSeg !== FILES_SEGMENT || !ownerId) return null;
  return { wsId, ownerId };
}
