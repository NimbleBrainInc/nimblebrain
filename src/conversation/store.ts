/**
 * The conversation store: the one interface every conversation record is read
 * and written through (ADR-0075).
 *
 * A provider implements it for one medium (`filesystem-store.ts`,
 * `memory-store.ts`); nothing above it builds a path, holds a file handle, or
 * depends on which provider serves it. The conformance suite
 * (`test/unit/conversation/store-conformance/`) is what the interface means:
 * every provider passes it.
 *
 * Every method is asynchronous, none is optional, and every call that touches
 * one owner's records names its {@link ConversationScope}. A conversation
 * outside the scope answers exactly like one that does not exist, so no answer
 * reveals another owner's or another workspace's records.
 */

import type { Conversation, ConversationEvent, ConversationPatch } from "./types.ts";

declare const conversationScopeBrand: unique symbol;

/**
 * The one workspace and owner a call is walled to.
 *
 * Branded so it can only come from `conversationScopeOf`
 * (`src/runtime/conversation-scope.ts`), which builds it from a request
 * context: the workspace the request was admitted to and its verified
 * identity. A tool's input is never a scope, so a value a caller typed cannot
 * reach another owner's records.
 */
export type ConversationScope = Readonly<{ workspaceId: string; ownerId: string }> & {
  readonly [conversationScopeBrand]: "ConversationScope";
};

/** An event as stored. `seq` is assigned by the store: gapless and increasing per conversation, from 1. */
export interface StoredEvent {
  seq: number;
  event: ConversationEvent;
}

/** What a new conversation is created with. Its workspace and owner are the scope's. */
export interface NewConversation {
  /** Create with this id instead of a generated one (`conv_` + 16 hex). */
  id?: string;
  /** The model the conversation is bound to, resolved and provider-qualified. See `Conversation.model`. */
  model: string;
  metadata?: Record<string, unknown>;
}

/** A listing of one owner's conversations in one workspace. */
export interface ListQuery {
  /** Case-insensitive substring of the title or the preview. */
  text?: string;
  /** Inclusive bounds on `lastActivityAt`, ISO 8601. */
  updatedFrom?: string;
  updatedTo?: string;
  /** Newest first by last activity (`updated`, the default) or by creation. */
  sort?: "updated" | "created";
  /** Opaque; from a previous page's `nextCursor`. Stays valid while records are inserted. */
  cursor?: string;
  limit: number;
}

/** Full-text search over one owner's conversations in one workspace. */
export interface SearchQuery {
  /** Case-insensitive substring of a message's text. Required and non-empty. */
  text: string;
  cursor?: string;
  limit: number;
}

/** One page of a listing or search. */
export interface Page<T> {
  items: T[];
  /** Null on the last page. */
  nextCursor: string | null;
  /** How many items match the query across every page. */
  total: number;
}

/** A conversation as a listing shows it. */
export interface ConversationSummary {
  id: string;
  title: string | null;
  /** The first user message's text, capped (`capPreview`). */
  preview: string;
  createdAt: string;
  /** The last event's timestamp, or `createdAt` when there is none. */
  lastActivityAt: string;
  /** User messages plus completed runs. */
  messageCount: number;
  /** Token usage per model. Cost is priced by the runtime at read time, never stored. */
  usage: Record<string, { inputTokens: number; outputTokens: number }>;
}

/** A conversation whose messages match a search. */
export interface SearchHit {
  id: string;
  title: string | null;
  /** Up to three matches, in seq order, each a snippet of the message text around the match. */
  matches: Array<{ seq: number; snippet: string }>;
}

/** What changed, as published to {@link ConversationStore.subscribe} listeners. */
export interface ConversationChange {
  kind: "created" | "appended" | "updated" | "deleted";
  id: string;
  scope: ConversationScope;
}

/**
 * A stored conversation the store cannot read: a header missing its owner or
 * model, or an event line that is not an event. Routes answer
 * `422 conversation_corrupted`.
 */
export class ConversationCorruptError extends Error {
  readonly code = "conversation_corrupted";
  constructor(
    readonly conversationId: string,
    readonly reason: "missing_owner" | "missing_model" | "unreadable_header" | "unreadable_event",
  ) {
    super(corruptMessage(conversationId, reason));
    this.name = "ConversationCorruptError";
  }
}

function corruptMessage(id: string, reason: ConversationCorruptError["reason"]): string {
  switch (reason) {
    case "missing_owner":
      return (
        `Conversation ${id} is corrupted (${reason}): its record has no ownerId. ` +
        `Add an ownerId to its line-1 metadata or remove the file.`
      );
    case "missing_model":
      return (
        `Conversation ${id} is corrupted (${reason}): its record has no model. ` +
        `Add a provider-qualified model to its line-1 metadata or remove the file.`
      );
    case "unreadable_header":
      return `Conversation ${id} is corrupted (${reason}): its header is not a conversation record.`;
    case "unreadable_event":
      return `Conversation ${id} is corrupted (${reason}): an event in it is not readable.`;
  }
}

export interface ConversationStore {
  /**
   * Create a conversation in `scope`. Rejects an id already stored in the scope.
   * Consistency: atomic; a concurrent `get` sees the conversation whole or not at all.
   */
  create(scope: ConversationScope, init: NewConversation): Promise<Conversation>;

  /**
   * The conversation, with its title, last model and last activity projected
   * from its events. `null` when absent or outside `scope`, indistinguishable.
   * Throws {@link ConversationCorruptError} when present but unreadable.
   * Consistency: reads the latest completed write.
   */
  get(scope: ConversationScope, id: string): Promise<Conversation | null>;

  /**
   * Events in seq order, after `afterSeq` when given. Yields nothing when the
   * conversation is absent or outside `scope`. Throws
   * {@link ConversationCorruptError} for an unreadable event.
   * Consistency: a snapshot as of the call; events appended while iterating are
   * not yielded.
   */
  events(
    scope: ConversationScope,
    id: string,
    opts?: { afterSeq?: number },
  ): AsyncIterable<StoredEvent>;

  /**
   * Append events in order, all or none, and return the last one's seq.
   * Concurrent callers on one conversation are serialized and their batches
   * never interleave. Rejects when the conversation is absent or outside
   * `scope`, or an event carries binary bytes, and then writes nothing. An
   * empty batch writes nothing and returns the current last seq.
   * Consistency: single process. The filesystem provider serializes within
   * its process only, and a crash mid-write can keep a prefix of the batch's
   * whole events (the torn last line is dropped on the next append).
   */
  appendEvents(scope: ConversationScope, id: string, events: ConversationEvent[]): Promise<number>;

  /**
   * Apply `patch` and return the conversation as `get` would, or `null` when
   * absent or outside `scope`. A title is recorded as a `metadata.title` event.
   * Consistency: last writer wins; no compare-and-set.
   */
  update(
    scope: ConversationScope,
    id: string,
    patch: ConversationPatch,
  ): Promise<Conversation | null>;

  /**
   * Remove a conversation and its events. `false` when absent or outside `scope`.
   * Consistency: atomic; afterwards `get` answers `null`.
   */
  delete(scope: ConversationScope, id: string): Promise<boolean>;

  /**
   * Remove every conversation in a workspace, every owner's, for a workspace
   * delete. Idempotent: a workspace with none (or already removed) resolves.
   * Resumable: a call interrupted part way is finished by calling it again.
   * Publishes a `deleted` change per conversation removed.
   */
  deleteWorkspace(workspaceId: string): Promise<void>;

  /**
   * One page of `scope`'s conversations, newest first by the query's sort,
   * ties broken by id. An unreadable conversation is left out of the listing
   * rather than failing it, so one bad record never hides the rest.
   * Consistency: each page reads the latest completed writes; a cursor resumes
   * strictly after the last item it was issued for, so inserts between pages
   * neither repeat nor skip the items already paged past.
   */
  list(scope: ConversationScope, query: ListQuery): Promise<Page<ConversationSummary>>;

  /**
   * Conversations in `scope` whose message text contains `query.text`, newest
   * activity first, ties broken by id. Unreadable conversations are left out.
   * Consistency: as for `list`.
   */
  search(scope: ConversationScope, query: SearchQuery): Promise<Page<SearchHit>>;

  /**
   * Listen for changes; returns the unsubscribe. A listener is called once per
   * completed create, append (one per batch), update and delete, after the write.
   * A listener that throws is logged and does not stop the others.
   */
  subscribe(listener: (change: ConversationChange) => void): () => void;

  /** Whether another process's writes reach this store's subscribers. */
  readonly crossProcess: boolean;
}
