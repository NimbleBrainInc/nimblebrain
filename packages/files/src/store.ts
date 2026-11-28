/**
 * The plugin's storage on the local filesystem, one directory per workspace:
 *
 *   <data>/workspaces/<workspaceId>/state.json        every owner's file and folder records, and
 *                                                      each upload completed within its window
 *   <data>/workspaces/<workspaceId>/bodies/<fileId>    a file's body, written once
 *   <data>/workspaces/<workspaceId>/uploads/<uploadId> the body last PUT to an open upload
 *
 * - **`state.json` is the only commit point.** A call changes the workspace in memory; then
 *   the bodies it adds are made durable under `bodies/` (each fsynced, then the directory
 *   that names them), `state.json` is replaced atomically (written beside it, fsynced,
 *   renamed, the workspace directory fsynced), and only then are the bodies it removes
 *   unlinked. A crash before the replace is durable leaves the call undone, and the bodies it
 *   wrote are orphans; a crash after it leaves bodies no record names. The first load of a
 *   workspace in a process removes both kinds of leftover, so storage holds what the state
 *   says. A call that throws evicts the workspace from memory, so its partial changes are
 *   never seen; the reload that follows reads the state again and removes nothing, since a
 *   PUT may be streaming to a temporary file.
 * - **No body is ever visible partly written.** `create` writes to a temporary file, fsyncs
 *   it and renames it into `bodies/`. A PUT streams to a temporary file and renames it over
 *   the upload's body when the stream ends, so `complete_upload` measures a whole body or
 *   none, and a repeated PUT replaces the earlier one. Completion hard-links the upload's
 *   body into `bodies/` (no copy, no window where neither name holds it), commits, then
 *   unlinks the upload's name.
 * - **An open upload lives in memory only.** Its URL lives only in this process, so a record
 *   of it on disk could outlive every way to send it a body: `begin_upload` writes nothing,
 *   and `complete_upload` is the upload's one commit. A workspace's first load in a process
 *   removes every upload body, since no open upload survives the process that opened it.
 * - **One process owns a data directory.** State reads and writes are synchronous, so the
 *   calls of one process never interleave; two processes on one directory are not
 *   serialized. The workspace id is the only path segment taken from a call; every other
 *   name is one this plugin minted.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Whether `value` can be one path segment: not empty, not `.` or `..`, no separator or NUL. */
export function isPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\0]/.test(value)
  );
}

/** A file's stored record. The owner is the wall; the workspace is the directory. */
export interface FileRow {
  id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  source: string;
  conversationId: string | null;
  runId: string | null;
  createdAt: string;
  description: string | null;
  folderId: string | null;
}

export interface FolderRow {
  id: string;
  ownerId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

/** An upload `begin_upload` opened and no call has completed: held in memory only. */
export interface UploadRow {
  id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  size: number;
  source: string;
  folder: string | null;
  tags: string[];
  description: string | null;
  conversationId: string | null;
  runId: string | null;
  /** When its URL stops accepting a PUT, epoch ms. */
  expiresAt: number;
}

/**
 * An upload `complete_upload` completed, kept while a repeat may come (CONTRACT.md §12). A
 * repeat answers the first record unchanged: the file's row with the fields a later call can
 * change (`tag` its tags, `move` its folder) as they were when the upload completed.
 */
export interface CompletedUpload {
  fileId: string;
  /** The upload URL's `expiresAt`, epoch ms: the completion window runs from it. */
  expiresAt: number;
  tags: string[];
  folderId: string | null;
}

export interface WorkspaceState {
  files: Record<string, FileRow>;
  folders: Record<string, FolderRow>;
  completed: Record<string, CompletedUpload>;
}

const emptyState = (): WorkspaceState => ({ files: {}, folders: {}, completed: {} });

/** A fresh id under this plugin's grammar (`^[a-z0-9][a-z0-9_-]{0,63}$`), 96 random bits. */
export function mintId(prefix: "fl" | "fd" | "up"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/** What one call does to a workspace, applied when it commits. */
export interface Tx {
  state: WorkspaceState;
  /** Store `data` as the body of the new file `fileId`. */
  putBody(fileId: string, data: Buffer): void;
  /** Make the upload's stored body the body of the new file `fileId`. */
  adoptUploadBody(uploadId: string, fileId: string): void;
  /** Remove a file's body once the call commits. */
  dropBody(fileId: string): void;
  /** Remove an upload's stored body once the call commits. */
  dropUploadBody(uploadId: string): void;
}

export class Store {
  readonly #root: string;
  readonly #cache = new Map<string, WorkspaceState>();
  /** Each workspace's open uploads, by id: kept apart from the state, which never holds them. */
  readonly #open = new Map<string, Map<string, UploadRow>>();
  /** The workspaces whose leftovers this process has removed: once each, before any PUT. */
  readonly #recovered = new Set<string>();

  constructor(dataDir: string) {
    this.#root = join(dataDir, "workspaces");
  }

  /** Run `fn` against the workspace and commit what it did; nothing is kept when it throws. */
  mutate<T>(workspaceId: string, fn: (tx: Tx) => T): T {
    const dir = this.#dir(workspaceId);
    const state = this.#load(workspaceId);
    const effects = new Effects(dir, state);
    try {
      const result = fn(effects.tx);
      effects.commit();
      return result;
    } catch (err) {
      this.#cache.delete(workspaceId);
      throw err;
    }
  }

  /** Read the workspace. A workspace with no storage reads as an empty one. */
  view<T>(workspaceId: string, fn: (state: WorkspaceState) => T): T {
    return fn(this.#load(workspaceId));
  }

  /** Open an upload: in memory, after the workspace's leftovers are removed. */
  openUpload(workspaceId: string, upload: UploadRow): void {
    this.#load(workspaceId);
    const open = this.#open.get(workspaceId) ?? new Map<string, UploadRow>();
    open.set(segment(upload.id), upload);
    this.#open.set(workspaceId, open);
  }

  /** The open upload `uploadId` names, or undefined. */
  upload(workspaceId: string, uploadId: string): UploadRow | undefined {
    return this.#open.get(workspaceId)?.get(uploadId);
  }

  /** Forget an open upload: its call committed its file. */
  closeUpload(workspaceId: string, uploadId: string): void {
    const open = this.#open.get(workspaceId);
    open?.delete(uploadId);
    if (open?.size === 0) this.#open.delete(workspaceId);
  }

  /**
   * Retire the uploads `stale` refuses by their `expiresAt`: an open one with its bytes, a
   * completed one from memory. A completed one leaves `state.json` with the next commit; until
   * then a repeat for it is refused by its window, so retiring commits nothing of its own.
   */
  retireUploads(workspaceId: string, stale: (expiresAt: number) => boolean): void {
    const open = this.#open.get(workspaceId);
    for (const upload of open?.values() ?? []) {
      if (!stale(upload.expiresAt)) continue;
      open?.delete(upload.id);
      removeUploadFiles(this.#dir(workspaceId), upload.id);
    }
    if (open?.size === 0) this.#open.delete(workspaceId);
    const state = this.#cache.get(workspaceId);
    for (const [id, done] of Object.entries(state?.completed ?? {})) {
      if (stale(done.expiresAt)) delete state?.completed[id];
    }
  }

  /**
   * The workspaces holding anything to retire: each loaded one, and each with an open upload.
   * An open upload outlives its workspace's eviction from the cache, so it is found on its own.
   */
  held(): string[] {
    return [...new Set([...this.#cache.keys(), ...this.#open.keys()])];
  }

  /** Where a file's body is, or null when it has none. */
  bodyPath(workspaceId: string, fileId: string): string | null {
    const path = join(this.#dir(workspaceId), "bodies", segment(fileId));
    return existsSync(path) ? path : null;
  }

  /** The length of the body last stored for an upload, or null when none is. */
  uploadBodySize(workspaceId: string, uploadId: string): number | null {
    const path = join(this.#dir(workspaceId), "uploads", segment(uploadId));
    return existsSync(path) ? statSync(path).size : null;
  }

  /**
   * A temporary name for a PUT's body, and the commit that renames it over the upload's
   * body. The caller writes the temporary file, fsyncs it, then commits; a PUT that fails
   * removes it.
   */
  uploadTarget(
    workspaceId: string,
    uploadId: string,
  ): { tmp: string; commit(): void; abandon(): void } {
    const uploads = join(this.#dir(workspaceId), "uploads");
    makeDir(uploads);
    const final = join(uploads, segment(uploadId));
    const tmp = join(uploads, `${segment(uploadId)}.${randomBytes(8).toString("hex")}.tmp`);
    return {
      tmp,
      commit: () => {
        renameSync(tmp, final);
        syncDir(uploads);
      },
      abandon: () => rmSync(tmp, { force: true }),
    };
  }

  /** Remove every record, upload and body held for the workspace. */
  removeWorkspace(workspaceId: string): void {
    this.#cache.delete(workspaceId);
    this.#open.delete(workspaceId);
    rmSync(this.#dir(workspaceId), { recursive: true, force: true });
  }

  #dir(workspaceId: string): string {
    if (!isPathSegment(workspaceId)) throw new Error(`not a workspace id: ${workspaceId}`);
    return join(this.#root, workspaceId);
  }

  #load(workspaceId: string): WorkspaceState {
    const hit = this.#cache.get(workspaceId);
    if (hit) return hit;
    const dir = this.#dir(workspaceId);
    const statePath = join(dir, "state.json");
    const state = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, "utf-8")) as WorkspaceState)
      : emptyState();
    if (!this.#recovered.has(workspaceId)) {
      removeLeftovers(dir, state);
      this.#recovered.add(workspaceId);
    }
    this.#cache.set(workspaceId, state);
    return state;
  }
}

function segment(name: string): string {
  if (!isPathSegment(name)) throw new Error(`not a stored name: ${name}`);
  return name;
}

/** The effects of one call, collected while it runs and applied in commit order. */
class Effects {
  readonly #dir: string;
  readonly #state: WorkspaceState;
  readonly #puts = new Map<string, Buffer>();
  readonly #adopts = new Map<string, string>();
  readonly #dropBodies = new Set<string>();
  readonly #dropUploads = new Set<string>();
  readonly tx: Tx;

  constructor(dir: string, state: WorkspaceState) {
    this.#dir = dir;
    this.#state = state;
    this.tx = {
      state,
      putBody: (fileId, data) => this.#puts.set(segment(fileId), data),
      adoptUploadBody: (uploadId, fileId) => this.#adopts.set(segment(fileId), segment(uploadId)),
      dropBody: (fileId) => this.#dropBodies.add(segment(fileId)),
      dropUploadBody: (uploadId) => this.#dropUploads.add(segment(uploadId)),
    };
  }

  commit(): void {
    makeDir(this.#dir);
    const bodies = join(this.#dir, "bodies");
    if (this.#puts.size > 0 || this.#adopts.size > 0) {
      makeDir(bodies);
      for (const [fileId, data] of this.#puts) atomicWrite(join(bodies, fileId), data);
      for (const [fileId, uploadId] of this.#adopts) {
        const target = join(bodies, fileId);
        rmSync(target, { force: true });
        linkSync(join(this.#dir, "uploads", uploadId), target);
      }
      syncDir(bodies);
    }
    atomicWrite(join(this.#dir, "state.json"), JSON.stringify(this.#state));
    syncDir(this.#dir);
    for (const fileId of this.#dropBodies) rmSync(join(bodies, fileId), { force: true });
    for (const uploadId of this.#dropUploads) removeUploadFiles(this.#dir, uploadId);
  }
}

/** An upload's stored body and any PUT's temporary file for it. */
function removeUploadFiles(dir: string, uploadId: string): void {
  const uploads = join(dir, "uploads");
  if (!existsSync(uploads)) return;
  for (const file of readdirSync(uploads)) {
    if (file === uploadId || file.startsWith(`${uploadId}.`)) {
      rmSync(join(uploads, file), { force: true });
    }
  }
}

/** Make `path` and its missing parents, each new entry durable in the directory above it. */
function makeDir(path: string): void {
  const first = mkdirSync(path, { recursive: true });
  if (first === undefined) return;
  const top = resolve(first);
  for (let made = resolve(path); made !== dirname(made); made = dirname(made)) {
    syncDir(dirname(made));
    if (made === top) return;
  }
}

/** Make the entries of a directory durable: a rename, link or new name in it survives a crash. */
function syncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a file whole or not at all: beside it, fsynced, then renamed over it. The caller
 * fsyncs the directory once its renames are done.
 */
function atomicWrite(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Remove what no committed record names: bodies of files the state does not hold (a crash
 * between writing a body and the commit, or between a commit and an unlink), every upload's
 * body (no open upload outlives the process that opened it, and a completed one's body is
 * already a file's), and every temporary file. It runs on a workspace's first load in a
 * process only: no PUT is in flight before then, since a PUT needs a token only a loaded
 * workspace issues.
 */
function removeLeftovers(dir: string, state: WorkspaceState): void {
  removeUnless(join(dir, "bodies"), (file) => Object.hasOwn(state.files, file));
  removeUnless(join(dir, "uploads"), () => false);
  removeUnless(dir, (file) => !file.startsWith("state.json.tmp-"));
}

/** Remove every file of `dir` that `keep` refuses. */
function removeUnless(dir: string, keep: (file: string) => boolean): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!keep(file)) rmSync(join(dir, file), { force: true });
  }
}
