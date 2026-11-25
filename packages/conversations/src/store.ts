/**
 * Conversations on the local filesystem: one JSONL file per conversation, line 1 its header
 * and every later line one event, under the data directory:
 *
 *   <data>/workspaces/<workspaceId>/conversations/<ownerId>/<conversationId>.jsonl
 *
 * The layout is the runtime's own conversation layout under its work directory, so the
 * plugin and a runtime given the same directory read and write the same files.
 *
 * - **The path is the scope.** Every call opens the one owner partition of the one
 *   workspace its scope names; nothing resolves an id across partitions. A conversation in
 *   another partition is never opened, so it answers as one that does not exist.
 * - **A workspace exists when its directory does.** The plugin never creates
 *   `<data>/workspaces/<workspaceId>/`: whoever provisions workspaces does. `create` in a
 *   workspace with no directory fails, so a late write never brings a deleted one back.
 * - **`seq` is position.** An event's `seq` is its place among the file's event lines
 *   (lines after line 1 that are objects with a string `ts` and `type`), from 1. Lines are
 *   only appended, so a `seq` never changes. A torn line is not an event and has no `seq`.
 * - **Writes to one conversation are serialized in this process.** One process owns a data
 *   directory; two processes writing one directory are not serialized against each other.
 */

import { existsSync, statSync } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ConversationHeader } from "./display.ts";
import { CorruptConversationError, isStoredEvent, type Scan, scanFile } from "./scan.ts";

/** The workspace and owner a call is walled to. */
export interface Scope {
  workspaceId: string;
  ownerId: string;
}

export const CONVERSATION_ID_RE = /^conv_[0-9a-f]{16}$/;
const FILE_RE = /^(conv_[0-9a-f]{16})\.jsonl$/;

/**
 * Whether `value` can be one path segment: not empty, not `.` or `..`, no separator or NUL.
 * Scope ids become directory names, so one that is not a segment is no scope.
 */
export function isPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !/[/\\\0]/.test(value)
  );
}

/** A conversation as `create` answers it. */
export interface CreatedConversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: null;
  lastModel: null;
  ownerId: string;
  workspaceId: string;
  model: string;
  metadata?: Record<string, unknown>;
}

export class ConversationExistsError extends Error {}
export class WorkspaceNotFoundError extends Error {}
export class ConversationNotFoundError extends Error {}

/** A conversation found in scope. */
export interface Found {
  id: string;
  path: string;
  scan: Scan;
}

/** One stored event and its `seq`. */
export interface StoredEvent {
  seq: number;
  event: { ts: string; type: string; [key: string]: unknown };
}

export type ConversationStore = ReturnType<typeof createStore>;

/** Each event line of a file's text after line 1, read by the same rule as a scan. */
function eventsOfText(text: string): StoredEvent[] {
  let start = 0;
  while (start < text.length && text[start] === "\n") start++;
  const firstNl = text.indexOf("\n", start);
  if (firstNl < 0) return [];
  const rest = text.slice(firstNl + 1);
  const lastNl = rest.lastIndexOf("\n");
  const lines = rest.slice(0, Math.max(lastNl, 0)).split("\n");
  const tail = rest.slice(lastNl + 1);
  if (tail) lines.push(tail);
  const out: StoredEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isStoredEvent(parsed)) {
      out.push({ seq: out.length + 1, event: parsed as StoredEvent["event"] });
    }
  }
  return out;
}

async function endsWithNewline(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** mkdir one level; an existing directory is fine, a missing parent is not. */
async function mkdirOne(dir: string): Promise<void> {
  try {
    await mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** mkdir each directory in turn; a missing parent means the workspace is gone. */
async function mkdirInWorkspace(workspaceId: string, dirs: string[]): Promise<void> {
  try {
    for (const dir of dirs) await mkdirOne(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceNotFoundError(`no workspace ${workspaceId}`);
    }
    throw err;
  }
}

/** Write a file that must not exist yet. */
async function writeNew(path: string, text: string, id: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConversationExistsError(`conversation ${id} already exists`);
    }
    throw err;
  }
}

export function createStore(dataDir: string) {
  const root = resolve(dataDir);
  const scans = new Map<string, Scan>();
  const queues = new Map<string, Promise<unknown>>();

  const workspaceDir = (workspaceId: string) => join(root, "workspaces", workspaceId);
  const conversationsDir = (workspaceId: string) =>
    join(workspaceDir(workspaceId), "conversations");
  const ownerDir = (s: Scope) => join(conversationsDir(s.workspaceId), s.ownerId);
  const fileOf = (s: Scope, id: string) => join(ownerDir(s), `${id}.jsonl`);

  /** Run `fn` after every earlier write to `path` has settled. */
  function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prior = queues.get(path) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(path, settled);
    void settled.then(() => {
      if (queues.get(path) === settled) queues.delete(path);
    });
    return next;
  }

  async function scanOf(path: string): Promise<Scan | null> {
    try {
      const scan = await scanFile(path, scans.get(path));
      if (scan) scans.set(path, scan);
      else scans.delete(path);
      return scan;
    } catch (err) {
      scans.delete(path);
      throw err;
    }
  }

  /**
   * The conversation `id` in scope, or null when it is not there. A file whose header does
   * not read throws {@link CorruptConversationError}; one whose header names another owner
   * or id is not this conversation, and reads as absent.
   */
  async function find(scope: Scope, id: string): Promise<Found | null> {
    if (!CONVERSATION_ID_RE.test(id)) return null;
    const path = fileOf(scope, id);
    const scan = await scanOf(path);
    if (!scan || scan.header.id !== id || scan.header.ownerId !== scope.ownerId) return null;
    return { id, path, scan };
  }

  /** Every readable conversation in scope. A file that does not read is left out. */
  async function list(scope: Scope): Promise<Found[]> {
    const out: Found[] = [];
    for (const name of await readdirOrEmpty(ownerDir(scope))) {
      const id = FILE_RE.exec(name)?.[1];
      if (!id) continue;
      try {
        const found = await find(scope, id);
        if (found) out.push(found);
      } catch (err) {
        if (!(err instanceof CorruptConversationError)) throw err;
      }
    }
    return out;
  }

  async function create(
    scope: Scope,
    input: { id?: string; model: string; metadata?: Record<string, unknown> },
  ): Promise<CreatedConversation> {
    const wsDir = workspaceDir(scope.workspaceId);
    if (!existsSync(wsDir) || !statSync(wsDir).isDirectory()) {
      throw new WorkspaceNotFoundError(`no workspace ${scope.workspaceId}`);
    }
    const id = input.id ?? `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const path = fileOf(scope, id);
    return serialized(path, async () => {
      // One level at a time: a workspace removed meanwhile fails here, never re-created.
      await mkdirInWorkspace(scope.workspaceId, [
        conversationsDir(scope.workspaceId),
        ownerDir(scope),
      ]);
      const now = new Date().toISOString();
      const header = {
        id,
        createdAt: now,
        updatedAt: now,
        title: null,
        lastModel: null,
        ownerId: scope.ownerId,
        model: input.model,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      await writeNew(path, `${JSON.stringify(header)}\n`, id);
      scans.delete(path);
      return { ...header, workspaceId: scope.workspaceId };
    });
  }

  /** Append events in order, all in one write; returns the last one's `seq`. */
  async function append(
    scope: Scope,
    id: string,
    events: ReadonlyArray<Record<string, unknown>>,
  ): Promise<number> {
    if (!CONVERSATION_ID_RE.test(id)) throw new ConversationNotFoundError(id);
    return serialized(fileOf(scope, id), async () => {
      const found = await find(scope, id);
      if (!found) throw new ConversationNotFoundError(id);
      if (events.length === 0) return found.scan.events;
      // A torn last line stays its own line, so the batch never splices onto it.
      const separator = (await endsWithNewline(found.path)) ? "" : "\n";
      const body = events.map((e) => JSON.stringify(e)).join("\n");
      await appendFile(found.path, `${separator}${body}\n`);
      return found.scan.events + events.length;
    });
  }

  /** Every event of a conversation in scope, with its `seq`; null when it is not there. */
  async function events(scope: Scope, id: string): Promise<StoredEvent[] | null> {
    const found = await find(scope, id);
    if (!found) return null;
    let text: string;
    try {
      text = await readFile(found.path, "utf-8");
    } catch {
      return null;
    }
    return eventsOfText(text);
  }

  /** A conversation's header and raw text, for the public reads; null when not there. */
  async function load(
    scope: Scope,
    id: string,
  ): Promise<{ found: Found; header: ConversationHeader; text: string } | null> {
    const found = await find(scope, id);
    if (!found) return null;
    let text: string;
    try {
      text = await readFile(found.path, "utf-8");
    } catch {
      return null;
    }
    return { found, header: found.scan.header, text };
  }

  async function remove(scope: Scope, id: string): Promise<boolean> {
    if (!CONVERSATION_ID_RE.test(id)) return false;
    const path = fileOf(scope, id);
    return serialized(path, async () => {
      // A file in the owner's partition that does not read is still theirs to delete.
      const found = await find(scope, id).catch((err: unknown) => {
        if (err instanceof CorruptConversationError) return { path };
        throw err;
      });
      if (!found) return false;
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
      scans.delete(path);
      return true;
    });
  }

  /** Remove every owner's conversations in a workspace; returns what was removed. */
  async function removeWorkspace(
    workspaceId: string,
  ): Promise<Array<{ id: string; ownerId: string }>> {
    const removed: Array<{ id: string; ownerId: string }> = [];
    const convDir = conversationsDir(workspaceId);
    for (const ownerId of await readdirOrEmpty(convDir)) {
      const dir = join(convDir, ownerId);
      for (const name of await readdirOrEmpty(dir)) {
        const id = FILE_RE.exec(name)?.[1];
        if (!id) continue;
        const path = join(dir, name);
        const gone = await serialized(path, async () => {
          try {
            await unlink(path);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw err;
          }
          scans.delete(path);
          return true;
        });
        if (gone) removed.push({ id, ownerId });
      }
      await rmdir(dir).catch(() => {});
    }
    await rmdir(convDir).catch(() => {});
    return removed;
  }

  return { root, find, list, create, append, events, load, remove, removeWorkspace };
}
