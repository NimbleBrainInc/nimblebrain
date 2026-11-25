import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../../observability/log.ts";
import {
  type Claim,
  type ClaimRequest,
  type EnqueueRequest,
  type EnqueueResult,
  type FailOptions,
  LeaseLostError,
  WORK_QUEUE_RETENTION_MS,
  type WorkQueue,
} from "./types.ts";

/**
 * The work queue on the local filesystem: the implementation that ships in the
 * box, for one runtime process (`multiProcess: false`).
 *
 * - **One JSON file per item**, `<sha256(idempotencyKey)>.json`, so the key is
 *   the file name and a repeat finds it without an index.
 * - **Every write is atomic.** A new item is written to a temp file and
 *   hard-linked to its name, which fails when the name exists, so creation is
 *   exclusive and never leaves a half-written item. A state change writes a
 *   temp file and renames it over the item. A temp file left by a crash is
 *   never read as an item, and is removed at open.
 * - **One process owns the directory.** Opening takes `queue.lock` in it,
 *   naming this process's pid, and refuses while another live process on this
 *   host holds it. A lock whose process is gone (a crash, a kill) is taken
 *   over. Hosts sharing a volume are outside what the lock can check.
 * - **Holding the lock, the process keeps every item in memory** as well as on
 *   disk, so a claim reads no files. Each method decides and writes in one
 *   synchronous step, so two calls in the process never interleave.
 * - **Terminal items are kept for `WORK_QUEUE_RETENTION_MS`**, then removed by
 *   the next claim's sweep. An enqueue that finds an expired terminal item
 *   under its key replaces it, so the window is exact whether or not a claim
 *   has swept.
 *
 * The runtime will place the directory at `<workDir>/queue`: instance-level,
 * never under a workspace, since one queue carries every workspace's work.
 */
export interface FilesystemWorkQueueOptions {
  /** The directory the queue owns. Created if absent. */
  dir: string;
  /** The provider's clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export const LOCK_FILE = "queue.lock";
const ITEM_FILE = /^[0-9a-f]{64}\.json$/;
const TEMP_SUFFIX = ".tmp";

type ItemState = "pending" | "claimed" | "completed" | "failed";

/** One item as stored in its file. */
interface StoredItem {
  id: string;
  idempotencyKey: string;
  kind: string;
  payload: unknown;
  state: ItemState;
  /** Enqueue order, the tie-break between equal due times. */
  seq: number;
  enqueuedAt: string;
  /** When a pending item is due. */
  dueAt: string;
  attempt: number;
  token: number;
  workerId?: string;
  /** When a claimed item's lease expires. */
  leaseUntil?: string;
  /** When a terminal item settled; retention counts from it. */
  settledAt?: string;
  error?: string;
}

/** Directories a queue in this process holds, so a second open here is refused too. */
const heldDirs = new Set<string>();

export function itemFileName(idempotencyKey: string): string {
  return `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists under another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(path: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the directory's lock, or throw naming who holds it. A lock left by a
 * process that is gone is taken over: one naming a pid that no longer runs, or
 * this process's own pid when this process does not hold the directory (a
 * restarted container reuses its pid).
 */
function acquireLock(dir: string): void {
  const path = join(dir, LOCK_FILE);
  if (heldDirs.has(dir)) {
    throw new Error(`The work queue at ${dir} is already open in this process.`);
  }
  const body = `${JSON.stringify({ pid: process.pid, since: new Date().toISOString() })}\n`;
  try {
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const pid = readLockPid(path);
    if (pid !== null && pid !== process.pid && isAlive(pid)) {
      throw new Error(
        `The work queue at ${dir} is held by process ${pid}. One process owns a filesystem ` +
          "queue; stop the other process, or delete the lock file if it is not running.",
      );
    }
    log.warn("[queue] taking over a work queue lock left by a stopped process", { dir, pid });
    unlinkSync(path);
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
  }
  heldDirs.add(dir);
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function requireLeaseMs(leaseMs: number): void {
  if (typeof leaseMs !== "number" || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new RangeError("leaseMs must be a positive number");
  }
}

/** Parse an instant the caller names, or throw. */
function parseInstant(value: string, field: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new RangeError(`${field} must be an ISO 8601 instant`);
  return ms;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** When the item is due, or null when it is not waiting to be claimed. */
function dueTime(item: StoredItem): number | null {
  if (item.state === "pending") return Date.parse(item.dueAt);
  if (item.state === "claimed" && item.leaseUntil) return Date.parse(item.leaseUntil);
  return null;
}

function isTerminal(item: StoredItem): boolean {
  return item.state === "completed" || item.state === "failed";
}

function claimOf(item: StoredItem): Claim {
  return {
    id: item.id,
    kind: item.kind,
    payload: item.payload,
    attempt: item.attempt,
    token: item.token,
    leaseUntil: item.leaseUntil ?? "",
  };
}

/**
 * Open the queue at `dir`: take its lock, remove temp files a crash left, and
 * load its items. Throws when another live process holds the directory.
 * `close()` releases the lock.
 */
export function createFilesystemWorkQueue(options: FilesystemWorkQueueOptions): WorkQueue {
  const dir = resolve(options.dir);
  const now = options.now ?? Date.now;
  mkdirSync(dir, { recursive: true });
  acquireLock(dir);

  /** Every item by file name. Authoritative while the lock is held. */
  const items = new Map<string, StoredItem>();
  let nextSeq = 1;
  let tempCounter = 0;
  let closed = false;

  for (const name of readdirSync(dir)) {
    if (name.endsWith(TEMP_SUFFIX)) {
      unlinkSync(join(dir, name));
      continue;
    }
    if (!ITEM_FILE.test(name)) continue;
    try {
      const item = JSON.parse(readFileSync(join(dir, name), "utf-8")) as StoredItem;
      items.set(name, item);
      nextSeq = Math.max(nextSeq, item.seq + 1);
    } catch (err) {
      log.warn("[queue] skipping a work item that does not parse", {
        file: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function tempPath(name: string): string {
    return join(dir, `${name}.${process.pid}.${++tempCounter}${TEMP_SUFFIX}`);
  }

  function writeTemp(name: string, item: StoredItem): string {
    const tmp = tempPath(name);
    writeFileSync(tmp, `${JSON.stringify(item)}\n`, { encoding: "utf-8", mode: 0o600 });
    return tmp;
  }

  /** Write a new item; throws EEXIST when the name is taken. */
  function create(name: string, item: StoredItem): void {
    const tmp = writeTemp(name, item);
    try {
      linkSync(tmp, join(dir, name));
    } finally {
      unlinkSync(tmp);
    }
    items.set(name, item);
  }

  /** Replace an existing item. */
  function replace(name: string, item: StoredItem): void {
    renameSync(writeTemp(name, item), join(dir, name));
    items.set(name, item);
  }

  function remove(name: string): void {
    try {
      unlinkSync(join(dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    items.delete(name);
  }

  function isExpired(item: StoredItem, at: number): boolean {
    return (
      isTerminal(item) &&
      item.settledAt !== undefined &&
      Date.parse(item.settledAt) + WORK_QUEUE_RETENTION_MS <= at
    );
  }

  /** Remove every terminal item whose retention window has ended. */
  function sweep(at: number): void {
    for (const [name, item] of [...items]) if (isExpired(item, at)) remove(name);
  }

  /** The due item of an allowed kind with the earliest due time, ties to the first enqueued. */
  function firstDue(
    at: number,
    kinds: string[] | undefined,
  ): { name: string; item: StoredItem } | null {
    const allowed = kinds ? new Set(kinds) : null;
    let best: { name: string; item: StoredItem; due: number } | null = null;
    for (const [name, item] of items) {
      const due = dueTime(item);
      if (due === null || due > at || (allowed && !allowed.has(item.kind))) continue;
      if (!best || due < best.due || (due === best.due && item.seq < best.item.seq)) {
        best = { name, item, due };
      }
    }
    return best;
  }

  function requireOpen(): void {
    if (closed) throw new Error(`The work queue at ${dir} is closed.`);
  }

  /** The stored item a claim names, while that claim is current; else LeaseLostError. */
  function currentHolder(claim: Claim): { name: string; item: StoredItem } {
    for (const [name, item] of items) {
      if (item.id !== claim.id) continue;
      if (item.state === "claimed" && item.token === claim.token) return { name, item };
      break;
    }
    throw new LeaseLostError(claim.id, claim.token);
  }

  return {
    multiProcess: false,

    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      requireOpen();
      requireNonEmpty(request.kind, "kind");
      requireNonEmpty(request.idempotencyKey, "idempotencyKey");
      const at = now();
      const dueAt =
        request.notBefore === undefined
          ? iso(at)
          : iso(parseInstant(request.notBefore, "notBefore"));
      const name = itemFileName(request.idempotencyKey);
      const existing = items.get(name);
      if (existing && !isExpired(existing, at)) return { id: existing.id, created: false };
      const item: StoredItem = {
        id: randomUUID(),
        idempotencyKey: request.idempotencyKey,
        kind: request.kind,
        // Stored as JSON, so what a claim returns is what JSON keeps.
        payload: JSON.parse(JSON.stringify(request.payload ?? null)),
        state: "pending",
        seq: nextSeq++,
        enqueuedAt: iso(at),
        dueAt,
        attempt: 0,
        token: 0,
      };
      if (existing) remove(name);
      create(name, item);
      return { id: item.id, created: true };
    },

    async claim(request: ClaimRequest): Promise<Claim | null> {
      requireOpen();
      requireNonEmpty(request.workerId, "workerId");
      requireLeaseMs(request.leaseMs);
      const at = now();
      sweep(at);
      const best = firstDue(at, request.kinds);
      if (!best) return null;
      const claimed: StoredItem = {
        ...best.item,
        state: "claimed",
        attempt: best.item.attempt + 1,
        token: best.item.token + 1,
        workerId: request.workerId,
        leaseUntil: iso(at + request.leaseMs),
      };
      replace(best.name, claimed);
      return claimOf(claimed);
    },

    async extend(claim: Claim, leaseMs: number): Promise<Claim> {
      requireOpen();
      requireLeaseMs(leaseMs);
      const { name, item } = currentHolder(claim);
      const extended: StoredItem = { ...item, leaseUntil: iso(now() + leaseMs) };
      replace(name, extended);
      return claimOf(extended);
    },

    async complete(claim: Claim): Promise<void> {
      requireOpen();
      const { name, item } = currentHolder(claim);
      const { leaseUntil: _lease, ...rest } = item;
      replace(name, { ...rest, state: "completed", settledAt: iso(now()) });
    },

    async fail(claim: Claim, failOptions: FailOptions): Promise<void> {
      requireOpen();
      const retryAt =
        failOptions.retryAt === undefined ? null : parseInstant(failOptions.retryAt, "retryAt");
      const { name, item } = currentHolder(claim);
      const { leaseUntil: _lease, ...rest } = item;
      replace(
        name,
        retryAt === null
          ? { ...rest, state: "failed", settledAt: iso(now()), error: failOptions.error }
          : { ...rest, state: "pending", dueAt: iso(retryAt), error: failOptions.error },
      );
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      items.clear();
      heldDirs.delete(dir);
      try {
        unlinkSync(join(dir, LOCK_FILE));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
