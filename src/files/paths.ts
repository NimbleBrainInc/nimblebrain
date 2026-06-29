/**
 * The single sanctioned construction (and parse) site for workspace-partitioned file
 * paths. Mirrors `src/conversation/paths.ts`: every file directory is built and
 * parsed here, so the on-disk layout has exactly one definition.
 *
 * The workspace owns the directory (see `research/SPEC-permission-boundaries.md`
 * §2.3): a file lives under the workspace it was created in, with the owner as a
 * privacy sub-partition. Each owner partition is self-contained — it holds the
 * bytes, the per-owner `registry.jsonl` catalog, and the extracted-text
 * sidecars — so a `FileStore` rooted at the owner partition (like the
 * conversation store) gets owner-isolation and cross-workspace denial by
 * construction. A `files://<id>` URI stays bare; the workspace comes from the
 * ambient request, never the URI.
 *
 *   workspaces/<wsId>/files/<ownerId>/registry.jsonl        per-owner catalog
 *   workspaces/<wsId>/files/<ownerId>/<fileId>_<name>       owner-private bytes
 *   workspaces/<wsId>/files/_runs/<automationId>/<fileId>   automation outputs (PR 3; reserved here)
 *
 * This file is on the allow-list of `check:workspace-paths` (it defines the
 * `workspaces/<wsId>/files/...` layout) and is the only site `check:file-paths`
 * permits to construct a workspace files dir.
 */

import { join, sep } from "node:path";

/** Reserved owner-partition segment for automation file outputs (PR 3). */
export const RUN_PARTITION_SEGMENT = "_runs";

const FILES_SEGMENT = "files";
const WORKSPACES_SEGMENT = "workspaces";

/**
 * Directory holding one owner's files in one workspace:
 * `{workDir}/workspaces/<wsId>/files/<ownerId>`.
 */
export function workspaceFilesDir(workDir: string, wsId: string, ownerId: string): string {
  // `_runs` is reserved for automation outputs; an ownerId equal to it would
  // make `parseFilesPath` misread that user's files as automation runs. Opaque
  // OIDC/email ids never collide, but fail closed if one ever does.
  if (ownerId === RUN_PARTITION_SEGMENT) {
    throw new Error(
      `[files-paths] ownerId "${RUN_PARTITION_SEGMENT}" is reserved for automation runs`,
    );
  }
  return join(workDir, WORKSPACES_SEGMENT, wsId, FILES_SEGMENT, ownerId);
}

/**
 * Directory holding an automation's file outputs in one workspace:
 * `{workDir}/workspaces/<wsId>/files/_runs/<automationId>`. Reserved for PR 3;
 * nothing writes here yet.
 */
export function runFilesDir(workDir: string, wsId: string, automationId: string): string {
  return join(
    workDir,
    WORKSPACES_SEGMENT,
    wsId,
    FILES_SEGMENT,
    RUN_PARTITION_SEGMENT,
    automationId,
  );
}

/** What a parsed file path resolves to. */
export interface ParsedFilesPath {
  wsId: string;
  /** The owner sub-partition, or `null` for an automation-run file. */
  ownerId: string | null;
  /** The automation id, for a `_runs/<automationId>/` file; else `null`. */
  automationId: string | null;
}

/**
 * Inverse of the builders: recover `{ wsId, ownerId, automationId }` from a file
 * path under a `workspaces/<wsId>/files/...` subtree. Returns `null` for a path
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
  const partition = segments[wsIdx + 3];
  if (!wsId || filesSeg !== FILES_SEGMENT || !partition) return null;
  if (partition === RUN_PARTITION_SEGMENT) {
    const automationId = segments[wsIdx + 4];
    if (!automationId) return null;
    return { wsId, ownerId: null, automationId };
  }
  return { wsId, ownerId: partition, automationId: null };
}
