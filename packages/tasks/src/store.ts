/**
 * The plugin's storage on the local filesystem, one directory per workspace:
 *
 *   <data>/workspaces/<workspaceId>/state.json     everything but ended runs: definitions
 *                                                   (with their grants), open runs, fences,
 *                                                   batches and their items, idempotency keys
 *   <data>/workspaces/<workspaceId>/runs.jsonl     ended runs, one JSON record per line
 *   <data>/workspaces/<workspaceId>/blobs/<name>.json  write-once data too large for the state:
 *                                                   a run's input, the answer begin_run gave
 *                                                   (grant and work spec), a run's result, a
 *                                                   batch's item inputs
 *
 * - **Every call is one transaction** ({@link Store.mutate}): it changes the workspace in
 *   memory, then its blobs are written, then its ended runs are appended, then `state.json`
 *   is replaced atomically (written beside it, fsynced, renamed). `state.json` is the commit
 *   point: a run is ended only when `state.json` no longer holds it open, so a crash before
 *   the rename leaves the call undone and the host's retry applies it whole. A call that
 *   throws evicts the workspace from memory, so its partial changes are never seen.
 * - **Loading folds `runs.jsonl`**: the last line per run id wins, a torn line is skipped,
 *   and a run `state.json` still holds open is open whatever the log says. Blobs no record
 *   names (left by a crash before a commit) are removed on load.
 * - **One process owns a data directory.** Every read and write is synchronous, so the calls
 *   of one process never interleave; two processes on one directory are not serialized.
 * - **The workspace id is a path segment**; the owner is never part of a path.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { emptyState, type RunRecord, type WorkspaceState } from "./model.ts";

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

/** A loaded workspace: its state and its ended runs. */
export interface Workspace {
  id: string;
  state: WorkspaceState;
  ended: Map<string, RunRecord>;
}

/** What one call does to a workspace, applied when it commits. */
export interface Tx {
  ws: Workspace;
  /** End a run: it leaves `open` and is appended to the log. */
  endRun(run: RunRecord): void;
  /** Remove ended runs from the log (retention). */
  dropEnded(ids: Iterable<string>): void;
  putBlob(name: string, value: unknown): void;
  dropBlob(name: string): void;
  readBlob<T>(name: string): T | undefined;
  /** Something `due` answers changed: the hint is sent once the call commits. */
  changed(): void;
}

export class Store {
  readonly #root: string;
  readonly #cache = new Map<string, Workspace>();
  readonly #listeners = new Set<(workspaceId: string) => void>();

  constructor(dataDir: string) {
    this.#root = join(dataDir, "workspaces");
  }

  /** Call `listener` with the workspace id after a committed call changed what `due` answers. */
  onChange(listener: (workspaceId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Run `fn` against the workspace and commit what it did; nothing is kept when it throws. */
  mutate<T>(workspaceId: string, fn: (tx: Tx) => T): T {
    const ws = this.#load(workspaceId);
    const effects = new Effects(this.#dir(workspaceId), ws);
    try {
      const result = fn(effects.tx);
      effects.commit();
      if (effects.hint) for (const listener of this.#listeners) listener(workspaceId);
      return result;
    } catch (err) {
      this.#cache.delete(workspaceId);
      throw err;
    }
  }

  /** Run a read-only `fn` against the workspace; nothing is committed. */
  view<T>(workspaceId: string, fn: (tx: Tx) => T): T {
    const ws = this.#load(workspaceId);
    return fn(new Effects(this.#dir(workspaceId), ws).tx);
  }

  /** Read the workspace. A workspace with no storage reads as an empty one. */
  read<T>(
    workspaceId: string,
    fn: (ws: Workspace, readBlob: <B>(n: string) => B | undefined) => T,
  ): T {
    const dir = this.#dir(workspaceId);
    return fn(this.#load(workspaceId), (name) => readBlobFile(dir, name));
  }

  /** Remove every record and file held for the workspace. */
  removeWorkspace(workspaceId: string): void {
    this.#cache.delete(workspaceId);
    rmSync(this.#dir(workspaceId), { recursive: true, force: true });
  }

  #dir(workspaceId: string): string {
    if (!isPathSegment(workspaceId)) throw new Error(`not a workspace id: ${workspaceId}`);
    return join(this.#root, workspaceId);
  }

  #load(workspaceId: string): Workspace {
    const hit = this.#cache.get(workspaceId);
    if (hit) return hit;
    const dir = this.#dir(workspaceId);
    const statePath = join(dir, "state.json");
    const state = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, "utf-8")) as WorkspaceState)
      : emptyState();
    const ended = readEnded(join(dir, "runs.jsonl"));
    for (const id of Object.keys(state.open)) ended.delete(id);
    const ws: Workspace = { id: workspaceId, state, ended };
    removeOrphanBlobs(dir, ws);
    this.#cache.set(workspaceId, ws);
    return ws;
  }
}

/** The effects of one call, collected while it runs and applied in commit order. */
class Effects {
  readonly #dir: string;
  readonly #ws: Workspace;
  readonly #ended: RunRecord[] = [];
  readonly #puts = new Map<string, unknown>();
  readonly #drops = new Set<string>();
  #compact = false;
  hint = false;
  readonly tx: Tx;

  constructor(dir: string, ws: Workspace) {
    this.#dir = dir;
    this.#ws = ws;
    this.tx = {
      ws,
      endRun: (run) => {
        delete ws.state.open[run.id];
        ws.ended.set(run.id, run);
        this.#ended.push(run);
      },
      dropEnded: (ids) => {
        for (const id of ids) ws.ended.delete(id);
        this.#compact = true;
      },
      putBlob: (name, value) => {
        this.#drops.delete(name);
        this.#puts.set(name, value);
      },
      dropBlob: (name) => {
        this.#puts.delete(name);
        this.#drops.add(name);
      },
      readBlob: <T>(name: string) =>
        this.#puts.has(name) ? (this.#puts.get(name) as T) : readBlobFile<T>(this.#dir, name),
      changed: () => {
        this.hint = true;
      },
    };
  }

  commit(): void {
    const blobs = join(this.#dir, "blobs");
    if (this.#puts.size > 0) mkdirSync(blobs, { recursive: true });
    for (const [name, value] of this.#puts)
      atomicWrite(blobPath(this.#dir, name), JSON.stringify(value));
    mkdirSync(this.#dir, { recursive: true });
    const log = join(this.#dir, "runs.jsonl");
    // The log is written before the commit point: a run it ends that `state.json` still holds
    // open stays open on load.
    if (this.#compact) {
      atomicWrite(log, [...this.#ws.ended.values()].map((r) => `${JSON.stringify(r)}\n`).join(""));
    } else if (this.#ended.length > 0) {
      appendDurably(log, this.#ended.map((r) => `${JSON.stringify(r)}\n`).join(""));
    }
    atomicWrite(join(this.#dir, "state.json"), JSON.stringify(this.#ws.state));
    for (const name of this.#drops) rmSync(blobPath(this.#dir, name), { force: true });
  }
}

function blobPath(dir: string, name: string): string {
  if (!isPathSegment(name)) throw new Error(`not a blob name: ${name}`);
  return join(dir, "blobs", `${name}.json`);
}

function readBlobFile<T>(dir: string, name: string): T | undefined {
  const path = blobPath(dir, name);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : undefined;
}

/** Write a file whole or not at all: beside it, fsynced, then renamed over it. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function appendDurably(path: string, text: string): void {
  appendFileSync(path, text);
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Fold the ended-runs log: the last line per id wins, a torn line is skipped. */
function readEnded(path: string): Map<string, RunRecord> {
  const out = new Map<string, RunRecord>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const run = JSON.parse(line) as RunRecord;
      if (run && typeof run.id === "string") out.set(run.id, run);
    } catch {
      // a torn line
    }
  }
  return out;
}

/** The blob names the workspace's records refer to. */
function referencedBlobs(ws: Workspace): Set<string> {
  const names = new Set<string>();
  const runs = [...Object.values(ws.state.open), ...ws.ended.values()];
  for (const run of runs) {
    names.add(`input-${run.id}`);
    names.add(`answer-${run.id}`);
    names.add(`result-${run.id}`);
  }
  for (const id of Object.keys(ws.state.batches)) names.add(`batch-${id}`);
  return names;
}

function removeOrphanBlobs(dir: string, ws: Workspace): void {
  const blobs = join(dir, "blobs");
  if (!existsSync(blobs)) return;
  const keep = referencedBlobs(ws);
  for (const file of readdirSync(blobs)) {
    const name = file.replace(/\.json$/, "");
    if (!keep.has(name) || !file.endsWith(".json")) unlinkSync(join(blobs, file));
  }
}
