/**
 * The single sanctioned construction (and parse) site for workspace-partitioned
 * file paths. Mirrors `src/conversation/paths.ts`: every file directory is built
 * and parsed here, so the on-disk layout has exactly one definition.
 *
 * The workspace owns the directory (see `research/SPEC-permission-boundaries.md`
 * §2.3): a file lives under the workspace it was created in, with the owner as a
 * privacy sub-partition. The path is the binding — `FileEntry.workspaceId` is a
 * denormalised convenience, the directory is authoritative.
 *
 *   workspaces/<wsId>/files/<ownerId>/   a member's files (private by default)
 *
 * This file is on the allow-list of `check:workspace-paths` (it defines the
 * `workspaces/<wsId>/...` file layout) and is the only site `check:file-paths`
 * permits to build a file directory.
 */

import { join, sep } from "node:path";

const FILES_SEGMENT = "files";
const WORKSPACES_SEGMENT = "workspaces";

/**
 * Directory holding a user's files in one workspace:
 * `{workDir}/workspaces/<wsId>/files/<ownerId>`.
 */
export function workspaceFilesDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, FILES_SEGMENT, ownerId);
}

/** What a parsed file path resolves to. */
export interface ParsedFilePath {
  wsId: string;
  ownerId: string;
}

/**
 * Inverse of the builder: recover `{ wsId, ownerId }` from a file or directory
 * path. Returns `null` for a path that is not under a
 * `workspaces/<wsId>/files/<ownerId>/` subtree (e.g. a legacy identity-owned
 * `users/<userId>/files/`), so callers can skip it. The path is the authority.
 */
export function parseFilePath(absPath: string): ParsedFilePath | null {
  const segments = absPath.split(sep);
  const wsIdx = segments.lastIndexOf(WORKSPACES_SEGMENT);
  if (wsIdx === -1) return null;
  const wsId = segments[wsIdx + 1];
  const filesSeg = segments[wsIdx + 2];
  const ownerId = segments[wsIdx + 3];
  if (!wsId || filesSeg !== FILES_SEGMENT || !ownerId) return null;
  return { wsId, ownerId };
}
