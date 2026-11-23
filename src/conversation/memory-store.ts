/**
 * The in-memory conversation store: a test double held to the same contract
 * as every provider (the conformance suite runs against it). Single-process
 * like the filesystem provider, so it declares `crossProcess: false` and proves
 * nothing about another process.
 */

import { conversationScopeOf } from "../runtime/conversation-scope.ts";
import { ConversationNotFoundError } from "../runtime/errors.ts";
import { assertNoBinaryPayloads } from "./binary-guard.ts";
import { createChangeFeed } from "./instrument.ts";
import {
  type ConversationHeader,
  paginate,
  projectConversation,
  projectSummary,
  searchMatches,
  summaryMatches,
} from "./projection.ts";
import type {
  ConversationScope,
  ConversationStore,
  ConversationSummary,
  SearchHit,
  StoredEvent,
} from "./store.ts";
import { CONVERSATION_ID_RE, type Conversation, type ConversationEvent } from "./types.ts";

interface StoredRecord {
  workspaceId: string;
  header: ConversationHeader;
  events: ConversationEvent[];
}

/** A deep copy, so a caller holding a returned value cannot change what is stored. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryConversationStore(): ConversationStore {
  const feed = createChangeFeed();
  /** Keyed by workspace, owner and id, so a scope reaches only its own records. */
  const records = new Map<string, StoredRecord>();
  const keyOf = (scope: ConversationScope, id: string) =>
    JSON.stringify([scope.workspaceId, scope.ownerId, id]);

  function find(scope: ConversationScope, id: string): StoredRecord | null {
    return records.get(keyOf(scope, id)) ?? null;
  }

  function stored(record: StoredRecord): StoredEvent[] {
    return record.events.map((event, i) => ({ seq: i + 1, event: copy(event) }));
  }

  function inScope(scope: ConversationScope): StoredRecord[] {
    return [...records.entries()]
      .filter(([key]) => {
        const [ws, owner] = JSON.parse(key) as [string, string];
        return ws === scope.workspaceId && owner === scope.ownerId;
      })
      .map(([, record]) => record);
  }

  async function get(scope: ConversationScope, id: string): Promise<Conversation | null> {
    const record = find(scope, id);
    return record ? projectConversation(copy(record.header), scope, record.events) : null;
  }

  /** Synchronous, so a batch lands between two awaits and never interleaves another. */
  function append(scope: ConversationScope, id: string, events: ConversationEvent[]): number {
    const record = find(scope, id);
    if (!record) throw new ConversationNotFoundError(id, scope.workspaceId);
    record.events.push(...events.map(copy));
    return record.events.length;
  }

  return {
    crossProcess: false,
    get,

    async create(scope, init) {
      const id = init.id ?? `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      if (!CONVERSATION_ID_RE.test(id)) {
        throw new Error("Invalid conversation ID: must match conv_ + 16 hex chars");
      }
      if (find(scope, id)) throw new Error(`Conversation ${id} already exists`);
      const header: ConversationHeader = {
        id,
        createdAt: new Date().toISOString(),
        ownerId: scope.ownerId,
        model: init.model,
        ...(init.metadata ? { metadata: copy(init.metadata) } : {}),
      };
      records.set(keyOf(scope, id), { workspaceId: scope.workspaceId, header, events: [] });
      feed.publish({ kind: "created", id, scope });
      return projectConversation(copy(header), scope, []);
    },

    async *events(scope, id, opts) {
      const record = find(scope, id);
      if (!record) return;
      const after = opts?.afterSeq ?? 0;
      for (const event of stored(record)) {
        if (event.seq > after) yield event;
      }
    },

    async appendEvents(scope, id, events) {
      for (const event of events) assertNoBinaryPayloads(event, `event(${event.type})`);
      const seq = append(scope, id, events);
      if (events.length > 0) feed.publish({ kind: "appended", id, scope });
      return seq;
    },

    async update(scope, id, patch) {
      if (!find(scope, id)) return null;
      if (patch.title !== undefined) {
        append(scope, id, [
          { ts: new Date().toISOString(), type: "metadata.title", title: patch.title },
        ]);
        feed.publish({ kind: "updated", id, scope });
      }
      return get(scope, id);
    },

    async delete(scope, id) {
      if (!records.delete(keyOf(scope, id))) return false;
      feed.publish({ kind: "deleted", id, scope });
      return true;
    },

    async deleteWorkspace(workspaceId) {
      for (const [key, record] of [...records.entries()]) {
        if (record.workspaceId !== workspaceId) continue;
        records.delete(key);
        const [, ownerId] = JSON.parse(key) as [string, string];
        feed.publish({
          kind: "deleted",
          id: record.header.id,
          scope: conversationScopeOf({ workspaceId, identity: { id: ownerId } }),
        });
      }
    },

    async list(scope, query) {
      const summaries: ConversationSummary[] = inScope(scope)
        .map((record) => projectSummary(record.header, record.events))
        .filter((summary) => summaryMatches(summary, query));
      const key = query.sort === "created" ? "createdAt" : "lastActivityAt";
      return paginate(summaries, (s) => s[key], query.cursor, query.limit);
    },

    async search(scope, query) {
      const text = query.text.trim();
      if (!text) throw new Error("A search needs non-empty text");
      const hits: Array<SearchHit & { lastActivityAt: string }> = [];
      for (const record of inScope(scope)) {
        const summary = projectSummary(record.header, record.events);
        const hit = searchMatches(record.header.id, summary.title, stored(record), text);
        if (hit) hits.push({ ...hit, lastActivityAt: summary.lastActivityAt });
      }
      const page = paginate(hits, (h) => h.lastActivityAt, query.cursor, query.limit);
      return { ...page, items: page.items.map(({ lastActivityAt: _at, ...hit }) => hit) };
    },

    subscribe: (listener) => feed.subscribe(listener),
  };
}
