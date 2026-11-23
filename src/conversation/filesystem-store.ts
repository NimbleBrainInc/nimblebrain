/**
 * The filesystem conversation store: one JSONL file per conversation at
 * `workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl`.
 *
 * Line 1 is the header (id, owner, model, creation time, metadata); every
 * later line is one event, and an event's seq is its line position (the first
 * event is seq 1). The provider keeps nothing in memory another process could
 * contradict: the seq, the title and every summary are read from the file.
 * Writes are serialized per conversation within this process only, so the
 * provider declares `crossProcess: false`.
 *
 * Paths are built here and in `paths.ts` alone; nothing above the
 * `ConversationStore` interface sees one.
 */

import {
  appendFile,
  link,
  readdir,
  readFile,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { log } from "../observability/log.ts";
import { conversationScopeOf } from "../runtime/conversation-scope.ts";
import { ConversationNotFoundError } from "../runtime/errors.ts";
import { ensureWorkspaceDir } from "../workspace/context.ts";
import { assertNoBinaryPayloads } from "./binary-guard.ts";
import { createChangeFeed } from "./instrument.ts";
import { workspaceConversationsDir, workspaceConversationsRoot } from "./paths.ts";
import {
  type ConversationHeader,
  paginate,
  projectConversation,
  projectSummary,
  searchMatches,
  summaryMatches,
} from "./projection.ts";
import {
  ConversationCorruptError,
  type ConversationScope,
  type ConversationStore,
  type ConversationSummary,
  type SearchHit,
  type StoredEvent,
} from "./store.ts";
import { CONVERSATION_ID_RE, type Conversation, type ConversationEvent } from "./types.ts";

export interface FilesystemConversationStoreConfig {
  /** The work directory; conversations live under its `workspaces/` tree. */
  workDir: string;
}

/** A conversation file read whole: its header, its events, and whether its last line was torn. */
interface ConversationFile {
  header: ConversationHeader;
  /** Parsed only when asked for; an append needs just the count. */
  events: StoredEvent[];
  eventCount: number;
  /** Byte length up to and including the last newline; a torn tail lies past it. */
  completeBytes: number;
  torn: boolean;
}

/** Refuse a scope segment that could leave its directory. */
function assertSegment(value: string, name: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes(sep)) {
    throw new Error(`Invalid ${name} for a conversation path`);
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Parse the header line, or throw the typed corruption. */
function parseHeader(id: string, line: string | undefined): ConversationHeader {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line ?? "") as Record<string, unknown>;
  } catch {
    throw new ConversationCorruptError(id, "unreadable_header");
  }
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") {
    throw new ConversationCorruptError(id, "unreadable_header");
  }
  if (typeof raw.ownerId !== "string" || raw.ownerId.length === 0) {
    throw new ConversationCorruptError(id, "missing_owner");
  }
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw new ConversationCorruptError(id, "missing_model");
  }
  return {
    id: raw.id,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    ownerId: raw.ownerId,
    model: raw.model,
    ...(raw.metadata && typeof raw.metadata === "object"
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  };
}

/**
 * Split a file into its header, its events and its torn tail. A line after the
 * last newline is a write a crash cut short: it is not part of the
 * conversation, and the next append removes it. Any other line that is not
 * JSON is corruption.
 */
function parseFile(id: string, content: string, parseEvents: boolean): ConversationFile {
  const lastNewline = content.lastIndexOf("\n");
  const complete = lastNewline < 0 ? "" : content.slice(0, lastNewline);
  const torn = lastNewline < content.length - 1;
  const lines = complete.split("\n").filter((line) => line.length > 0);
  const header = parseHeader(id, lines[0]);
  const events: StoredEvent[] = [];
  for (let i = 1; parseEvents && i < lines.length; i++) {
    let event: ConversationEvent;
    try {
      event = JSON.parse(lines[i] ?? "") as ConversationEvent;
    } catch {
      throw new ConversationCorruptError(id, "unreadable_event");
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw new ConversationCorruptError(id, "unreadable_event");
    }
    events.push({ seq: i, event });
  }
  return {
    header,
    events,
    eventCount: Math.max(0, lines.length - 1),
    completeBytes: lastNewline < 0 ? 0 : Buffer.byteLength(content.slice(0, lastNewline + 1)),
    torn,
  };
}

export function createFilesystemConversationStore(
  config: FilesystemConversationStoreConfig,
): ConversationStore {
  const feed = createChangeFeed();
  /** The tail of each conversation's write chain, by path; removed once idle. */
  const chains = new Map<string, Promise<unknown>>();

  function dirOf(scope: ConversationScope): string {
    assertSegment(scope.workspaceId, "workspace");
    assertSegment(scope.ownerId, "owner");
    return workspaceConversationsDir(config.workDir, scope.workspaceId, scope.ownerId);
  }

  /** The file for `id` in `scope`, or null for an id that is not a conversation id. */
  function pathOf(scope: ConversationScope, id: string): string | null {
    if (!CONVERSATION_ID_RE.test(id)) return null;
    return join(dirOf(scope), `${id}.jsonl`);
  }

  /** Run `fn` after every earlier write to `path` in this process has settled. */
  function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(path) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => undefined);
    chains.set(path, tail);
    void tail.then(() => {
      if (chains.get(path) === tail) chains.delete(path);
    });
    return run;
  }

  /** The file read whole, or null when absent or owned by someone outside `scope`. */
  async function readConversation(
    scope: ConversationScope,
    id: string,
    parseEvents = true,
  ): Promise<ConversationFile | null> {
    const path = pathOf(scope, id);
    if (!path) return null;
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const file = parseFile(id, content, parseEvents);
    if (file.header.ownerId !== scope.ownerId || file.header.id !== id) return null;
    return file;
  }

  /** The ids stored in one directory. A directory that was never written lists none. */
  async function idsIn(dir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    return names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length))
      .filter((id) => CONVERSATION_ID_RE.test(id));
  }

  /** Every readable conversation in `scope`; an unreadable one is logged and left out. */
  async function readAll(scope: ConversationScope): Promise<ConversationFile[]> {
    const out: ConversationFile[] = [];
    for (const id of await idsIn(dirOf(scope))) {
      try {
        const file = await readConversation(scope, id);
        if (file) out.push(file);
      } catch (err) {
        if (!(err instanceof ConversationCorruptError)) throw err;
        log.warn("[conversations] unreadable conversation left out of a listing", {
          conversation_id: id,
          reason: err.reason,
        });
      }
    }
    return out;
  }

  async function appendLocked(
    scope: ConversationScope,
    id: string,
    path: string,
    events: ConversationEvent[],
  ): Promise<number> {
    const file = await readConversation(scope, id, false);
    if (!file) throw new ConversationNotFoundError(id, scope.workspaceId);
    const last = file.eventCount;
    if (events.length === 0) return last;
    // A torn tail is a write a crash cut short; it is no event, so drop it
    // before appending rather than splice the batch onto it.
    if (file.torn) await truncate(path, file.completeBytes);
    // One write for the whole batch, so a concurrent reader sees all of it or
    // none of it short of a crash mid-write.
    await appendFile(path, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    return last + events.length;
  }

  async function get(scope: ConversationScope, id: string): Promise<Conversation | null> {
    const file = await readConversation(scope, id);
    if (!file) return null;
    return projectConversation(
      file.header,
      scope,
      file.events.map((stored) => stored.event),
    );
  }

  return {
    crossProcess: false,
    get,

    async create(scope, init) {
      const id = init.id ?? `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const path = pathOf(scope, id);
      if (!path) throw new Error("Invalid conversation ID: must match conv_ + 16 hex chars");
      const now = new Date().toISOString();
      const header: ConversationHeader & { updatedAt: string; title: null; lastModel: null } = {
        id,
        createdAt: now,
        updatedAt: now,
        title: null,
        lastModel: null,
        ownerId: scope.ownerId,
        model: init.model,
        ...(init.metadata ? { metadata: init.metadata } : {}),
      };
      // Created only inside a live workspace root, never as a way to bring a
      // deleted one back (`ensureWorkspaceDir`).
      ensureWorkspaceDir(dirOf(scope));
      // Written aside and linked into place: `link` fails when the id is taken,
      // and a reader never sees a header half written.
      const staging = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(staging, `${JSON.stringify(header)}\n`);
      try {
        await link(staging, path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Conversation ${id} already exists`);
        }
        throw err;
      } finally {
        await unlink(staging).catch(() => undefined);
      }
      feed.publish({ kind: "created", id, scope });
      return projectConversation(header, scope, []);
    },

    async *events(scope, id, opts) {
      const file = await readConversation(scope, id);
      if (!file) return;
      const after = opts?.afterSeq ?? 0;
      for (const stored of file.events) {
        if (stored.seq > after) yield stored;
      }
    },

    async appendEvents(scope, id, events) {
      for (const event of events) assertNoBinaryPayloads(event, `event(${event.type})`);
      const path = pathOf(scope, id);
      if (!path) throw new ConversationNotFoundError(id, scope.workspaceId);
      const seq = await serialized(path, () => appendLocked(scope, id, path, events));
      if (events.length > 0) feed.publish({ kind: "appended", id, scope });
      return seq;
    },

    async update(scope, id, patch): Promise<Conversation | null> {
      const path = pathOf(scope, id);
      if (!path) return null;
      if (patch.title !== undefined) {
        const event: ConversationEvent = {
          ts: new Date().toISOString(),
          type: "metadata.title",
          title: patch.title,
        };
        try {
          await serialized(path, () => appendLocked(scope, id, path, [event]));
        } catch (err) {
          if (err instanceof ConversationNotFoundError) return null;
          throw err;
        }
        feed.publish({ kind: "updated", id, scope });
      }
      return get(scope, id);
    },

    async delete(scope, id) {
      const path = pathOf(scope, id);
      if (!path) return false;
      const removed = await serialized(path, async () => {
        if (!(await readConversation(scope, id, false))) return false;
        await unlink(path);
        return true;
      });
      if (removed) feed.publish({ kind: "deleted", id, scope });
      return removed;
    },

    async deleteWorkspace(workspaceId) {
      assertSegment(workspaceId, "workspace");
      const root = workspaceConversationsRoot(config.workDir, workspaceId);
      let owners: string[];
      try {
        owners = await readdir(root);
      } catch (err) {
        if (isMissing(err)) return;
        throw err;
      }
      // One file at a time, each announced once it is gone, so an interrupted
      // call leaves only conversations a second call finds and finishes.
      for (const ownerId of owners) {
        const dir = join(root, ownerId);
        for (const id of await idsIn(dir)) {
          const path = join(dir, `${id}.jsonl`);
          const removed = await serialized(path, async () => {
            try {
              await unlink(path);
              return true;
            } catch (err) {
              if (isMissing(err)) return false;
              throw err;
            }
          });
          if (removed) {
            const scope = conversationScopeOf({ workspaceId, identity: { id: ownerId } });
            feed.publish({ kind: "deleted", id, scope });
          }
        }
      }
      await rm(root, { recursive: true, force: true });
    },

    async list(scope, query) {
      const summaries: ConversationSummary[] = [];
      for (const file of await readAll(scope)) {
        const summary = projectSummary(
          file.header,
          file.events.map((stored) => stored.event),
        );
        if (summaryMatches(summary, query)) summaries.push(summary);
      }
      const key = query.sort === "created" ? "createdAt" : "lastActivityAt";
      return paginate(summaries, (s) => s[key], query.cursor, query.limit);
    },

    async search(scope, query) {
      const text = query.text.trim();
      if (!text) throw new Error("A search needs non-empty text");
      const hits: Array<SearchHit & { lastActivityAt: string }> = [];
      for (const file of await readAll(scope)) {
        const summary = projectSummary(
          file.header,
          file.events.map((stored) => stored.event),
        );
        const hit = searchMatches(file.header.id, summary.title, file.events, text);
        if (hit) hits.push({ ...hit, lastActivityAt: summary.lastActivityAt });
      }
      const page = paginate(hits, (h) => h.lastActivityAt, query.cursor, query.limit);
      return {
        ...page,
        items: page.items.map(({ lastActivityAt: _at, ...hit }) => hit),
      };
    },

    subscribe: (listener) => feed.subscribe(listener),
  };
}
