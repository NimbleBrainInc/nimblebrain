import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ID_RE } from "./workspace-id-pattern.ts";

/**
 * The archives `WorkspaceStore.delete` leaves under `archived/`, read and
 * purged by an operator.
 *
 * There is no sweep, timer, or retention policy here, and there should not be.
 * An automatic sweep fails silently and unrecoverably; a full disk is loud and
 * has a fix. So the runtime shows what is archived and removes one archive when
 * a person names it.
 */

/** One directory under `archived/`. */
export interface ArchiveEntry {
  /** Directory name under `archived/` — the handle `purgeArchive` takes. */
  name: string;
  /** From the archived `workspace.json`; `null` when missing, unreadable, or not a string. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** Sum of the byte sizes of every file beneath the directory. Symlinks are not followed. */
  sizeBytes: number;
  /**
   * The directory's mtime. `delete` sets it by writing the marker into the
   * moved directory, which is why `ArchiveMarker` carries no timestamp.
   */
  archivedAt: string;
}

export interface PurgeArchiveResult {
  /** `false` when no such archive exists — a repeat purge is a no-op. */
  purged: boolean;
  name: string;
  /** Bytes removed; `0` when nothing was there. */
  sizeBytes: number;
}

/**
 * Whether `name` can be the directory `delete` archives a workspace to.
 *
 * `delete` writes `archived/<wsId>` or, on collision, `archived/<wsId>-<suffix>`.
 * A workspace id contains no `-`, so the first one splits the two. Both halves
 * are drawn from `[a-z0-9_]`, so a name that passes holds no separator and no
 * dot and cannot address anything but a direct child of `archived/`.
 */
export function isArchiveName(name: string): boolean {
  const dash = name.indexOf("-");
  const wsId = dash === -1 ? name : name.slice(0, dash);
  if (!WORKSPACE_ID_RE.test(wsId)) return false;
  return dash === -1 || /^[a-z0-9_]{1,64}$/i.test(name.slice(dash + 1));
}

/**
 * List every directory under `archivedDir`, newest first.
 *
 * A directory whose `workspace.json` is missing or unparseable is listed with
 * `null` identity rather than dropped: those are the archives nothing else
 * describes. Returns `[]` when `archived/` has not been created yet.
 */
export async function listArchives(archivedDir: string): Promise<ArchiveEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(archivedDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const archives: ArchiveEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(archivedDir, entry.name);
    const [identity, sizeBytes, dirStat] = await Promise.all([
      readArchivedIdentity(dir),
      directorySize(dir),
      stat(dir),
    ]);
    archives.push({
      name: entry.name,
      ...identity,
      sizeBytes,
      archivedAt: dirStat.mtime.toISOString(),
    });
  }

  archives.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.name.localeCompare(b.name));
  return archives;
}

/**
 * Recursively remove one archive, named explicitly.
 *
 * Throws on a name `isArchiveName` refuses, and on an entry that is not a
 * directory — neither is something `delete` produced. An absent archive
 * returns `purged: false` rather than throwing, so a repeated purge is clean.
 */
export async function purgeArchive(archivedDir: string, name: string): Promise<PurgeArchiveResult> {
  if (!isArchiveName(name)) {
    throw new Error(`"${name}" is not an archive name.`);
  }
  const dir = join(archivedDir, name);
  try {
    const entry = await lstat(dir);
    if (!entry.isDirectory()) {
      throw new Error(`"${name}" is not an archive directory.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { purged: false, name, sizeBytes: 0 };
    }
    throw err;
  }
  const sizeBytes = await directorySize(dir);
  await rm(dir, { recursive: true, force: true });
  return { purged: true, name, sizeBytes };
}

async function readArchivedIdentity(
  dir: string,
): Promise<{ workspaceId: string | null; workspaceName: string | null }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "workspace.json"), "utf-8"));
    const record = (parsed ?? {}) as { id?: unknown; name?: unknown };
    return {
      workspaceId: typeof record.id === "string" ? record.id : null,
      workspaceName: typeof record.name === "string" ? record.name : null,
    };
  } catch {
    return { workspaceId: null, workspaceName: null };
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else if (entry.isFile()) {
      total += (await lstat(path)).size;
    }
  }
  return total;
}
