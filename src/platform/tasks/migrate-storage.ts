/**
 * Boot reconcile: task storage moves from `workspaces/<wsId>/automations/<ownerId>/`
 * to `workspaces/<wsId>/tasks/<ownerId>/` (ADR-0045: the old storage becomes
 * task storage, reconciled at boot so no step depends on an operator).
 *
 * Runs in `createTasksSource` before the scheduler loads, so the scheduler and
 * every reader only ever see the new layout.
 *
 * - **Records name their task as `taskId`.** Before anything moves, every
 *   `.json` / `.jsonl` file in the old owner dir (run index lines, archives,
 *   result sidecars, run tickets) has its `"automationId":` key rewritten to
 *   `"taskId":`, each file replaced atomically. A file already rewritten holds
 *   no such key and is left alone, so a crash mid-rewrite is finished by the
 *   next boot. The rewrite runs only on the old dir: a record written
 *   directly under `tasks/` by a runtime that predates the field rename keeps
 *   `automationId`, so its task can't be resolved from it: the run reads as
 *   one of an unknown task, and its result can't be fetched by run id.
 * - **One rename per owner dir** when the owner has no `tasks/` dir yet. A
 *   rename is atomic, so a crash leaves each owner either moved or not.
 * - **A merge, file by file, when both exist** (a process still on the old
 *   layout wrote after the move, or a crash between two owners' merges). A
 *   file the new tree lacks is renamed into it; an identical file is dropped
 *   from the old tree; a file that differs is a conflict: it stays where it is,
 *   is logged, and nothing in the new tree is overwritten. Each step is a
 *   single rename or unlink, so a crash mid-merge leaves a state the next boot
 *   finishes.
 * - Empty directories left in the old tree are removed, and `automations/`
 *   with them once nothing is left in it. A tree with conflicts stays, and the
 *   next boot reports it again.
 *
 * Idempotent: with no `automations/` dir anywhere it reads one directory per
 * workspace and writes nothing.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../../observability/log.ts";
import { ensureWorkspaceDir } from "../../workspace/context.ts";
import { workspaceTasksDir, workspaceTasksRoot } from "./paths.ts";

/** The directory a workspace's task storage used before the rename, beside `tasks/`. */
const LEGACY_SEGMENT = "automations";

/** How a record named its task before the rename, and how it names it now. */
const LEGACY_ID_KEY = '"automationId":';
const ID_KEY = '"taskId":';

function legacyRoot(workDir: string, wsId: string): string {
  return join(dirname(workspaceTasksRoot(workDir, wsId)), LEGACY_SEGMENT);
}

/** What one reconcile did, for the log and for tests. */
export interface TaskStorageMigration {
  /** Owner dirs moved whole: `<wsId>/<ownerId>`. */
  moved: string[];
  /** Files moved one by one into an owner dir that already existed. */
  merged: string[];
  /** Files left in the old tree because the new tree holds a different file at that path. */
  conflicts: string[];
  /** Record files whose legacy id key was rewritten to `taskId`. */
  rewritten: number;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** Whether two files hold the same bytes. */
function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Remove `dir` if it is empty; true when it is gone. */
function removeIfEmpty(dir: string): boolean {
  if (listDir(dir).length > 0) return false;
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge `from` into `to`, never overwriting a file in `to`. Recurses into
 * directories and removes each one it empties.
 */
function mergeInto(from: string, to: string, out: TaskStorageMigration, label: string): void {
  for (const name of listDir(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    if (isDir(src)) {
      if (!existsSync(dest)) {
        renameSync(src, dest);
        out.merged.push(`${label}/${name}`);
        continue;
      }
      if (!isDir(dest)) {
        out.conflicts.push(`${label}/${name}`);
        continue;
      }
      mergeInto(src, dest, out, `${label}/${name}`);
      removeIfEmpty(src);
      continue;
    }
    if (!existsSync(dest)) {
      renameSync(src, dest);
      out.merged.push(`${label}/${name}`);
    } else if (!isDir(dest) && sameContent(src, dest)) {
      unlinkSync(src);
    } else {
      out.conflicts.push(`${label}/${name}`);
    }
  }
}

/**
 * Rewrite the legacy id key in every record file under `dir`, one atomic
 * replace per file. A file without the key is untouched.
 */
function rewriteRecordKeys(dir: string, out: TaskStorageMigration): void {
  for (const name of listDir(dir)) {
    const path = join(dir, name);
    if (isDir(path)) {
      rewriteRecordKeys(path, out);
      continue;
    }
    if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
    const text = readFileSync(path, "utf-8");
    if (!text.includes(LEGACY_ID_KEY)) continue;
    const tmp = `${path}.migrate-tmp`;
    writeFileSync(tmp, text.split(LEGACY_ID_KEY).join(ID_KEY));
    renameSync(tmp, path);
    out.rewritten += 1;
  }
}

/** Move one workspace's `automations/` tree under `tasks/`. */
function migrateWorkspace(workDir: string, wsId: string, out: TaskStorageMigration): void {
  const root = legacyRoot(workDir, wsId);
  if (!isDir(root)) return;
  for (const ownerId of listDir(root)) {
    const from = join(root, ownerId);
    if (!isDir(from)) continue;
    rewriteRecordKeys(from, out);
    const to = workspaceTasksDir(workDir, wsId, ownerId);
    if (!existsSync(to)) {
      ensureWorkspaceDir(workspaceTasksRoot(workDir, wsId));
      renameSync(from, to);
      out.moved.push(`${wsId}/${ownerId}`);
      continue;
    }
    mergeInto(from, to, out, `${wsId}/${ownerId}`);
    removeIfEmpty(from);
  }
  removeIfEmpty(root);
}

/**
 * Reconcile every workspace's task storage to the `tasks/` layout. Never
 * throws for one workspace's trouble: it is logged and the rest go on, since a
 * scheduler that never starts fails every workspace's tasks.
 */
export function migrateTaskStorage(workDir: string): TaskStorageMigration {
  const out: TaskStorageMigration = { moved: [], merged: [], conflicts: [], rewritten: 0 };
  const wsRoot = join(workDir, "workspaces");
  for (const wsId of listDir(wsRoot)) {
    if (!isDir(join(wsRoot, wsId))) continue;
    try {
      migrateWorkspace(workDir, wsId, out);
    } catch (err) {
      log.warn("[tasks] could not move a workspace's task storage; it will be retried at boot", {
        workspace_id: wsId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (out.moved.length > 0 || out.merged.length > 0) {
    log.info("[tasks] moved task storage from automations/ to tasks/", {
      ownersMoved: out.moved,
      filesMerged: out.merged.length,
      recordsRewritten: out.rewritten,
    });
  }
  if (out.conflicts.length > 0) {
    log.warn("[tasks] task storage left in automations/: a different file is already in tasks/", {
      conflicts: out.conflicts,
    });
  }
  return out;
}
