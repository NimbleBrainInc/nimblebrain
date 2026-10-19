/**
 * The single sanctioned construction site for workspace-partitioned file
 * paths. Mirrors `src/conversation/paths.ts`: every file directory is built
 * here, so the on-disk layout has exactly one definition.
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

import { join } from "node:path";

const FILES_SEGMENT = "files";
const WORKSPACES_SEGMENT = "workspaces";

/**
 * Directory holding one owner's files in one workspace:
 * `{workDir}/workspaces/<wsId>/files/<ownerId>`.
 */
export function workspaceFilesDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, FILES_SEGMENT, ownerId);
}
