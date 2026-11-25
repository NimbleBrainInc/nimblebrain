/**
 * The runtime's conversation store over the conversations contract
 * (`ai.nimblebrain.conversations`), for an instance whose plugins bind it.
 *
 * It implements the same {@link ConversationEventStore} the filesystem store
 * does, so turns, history reconstruction, compaction and titles run on it
 * unchanged. Every operation is a call to the bound server under the kernel's
 * own (`host`) principal: records through the private tools (`create`,
 * `append_events`, `events`, `delete`, `delete_workspace`), and the
 * projections a public tool already answers (`get` for a conversation's
 * metadata, `list`, `update`).
 *
 * - **Writes are queued per conversation and sent in batches.** The engine
 *   emits events synchronously while it streams; each lands in its
 *   conversation's queue, and the events that arrive while one
 *   `append_events` is in flight go together in the next, in order. The queue
 *   is shared by every store this factory hands out, so a store opened for the
 *   next turn reads what the last one wrote.
 * - **A read waits for its conversation's queued writes**, so the runtime reads
 *   what it wrote.
 * - **The host decides that a workspace exists.** The contract trusts the
 *   workspace the host stamps, so `create` runs only after the kernel's own
 *   workspace check.
 * - **An append is never retried**: the contract has no idempotency key, and a
 *   batch whose answer was lost may have landed. A failed queued write is
 *   logged; one the caller awaits (`append`) throws.
 */

import type { EngineEvent } from "../engine/types.ts";
import { reconstructMessages } from "../history/event-reconstructor.ts";
import { log } from "../observability/log.ts";
import { assertNoBinaryPayloads } from "./binary-guard.ts";
import { conversationEventOf, messageEvents } from "./event-sourced-store.ts";
import type {
  Conversation,
  ConversationAccessContext,
  ConversationEvent,
  ConversationEventStore,
  ConversationListResult,
  ConversationPatch,
  ConversationSummary,
  CreateConversationOptions,
  ListOptions,
  StoredMessage,
} from "./types.ts";

/** The conversations contract's permanent name: what the kernel asks its plugins' bindings for. */
export const CONVERSATIONS_CONTRACT = "ai.nimblebrain.conversations";

/** The workspace and owner a call is walled to. */
export interface ContractScope {
  workspaceId: string;
  ownerId: string;
}

/**
 * One call to the bound server as the host. Resolves to the tool's
 * `structuredContent`; rejects with an error whose `code` is the contract's on
 * a tool error.
 */
export type ContractCall = (
  tool: string,
  args: Record<string, unknown>,
  scope: ContractScope,
) => Promise<Record<string, unknown>>;

/** The largest page `events` serves. */
const EVENTS_PAGE = 5000;

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A row of the contract's `get` metadata, as the runtime's {@link Conversation}. */
function conversationOf(m: Record<string, unknown>): Conversation {
  return {
    id: String(m.id),
    createdAt: String(m.createdAt),
    updatedAt: String(m.updatedAt),
    title: typeof m.title === "string" ? m.title : null,
    model: String(m.model),
    lastModel: typeof m.lastModel === "string" ? m.lastModel : null,
    ownerId: String(m.ownerId),
    ...(typeof m.workspaceId === "string" ? { workspaceId: m.workspaceId } : {}),
  };
}

/** The contract's `list` arguments for the runtime's list options. */
function listArgs(options: ListOptions | undefined): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (options?.limit !== undefined) args.limit = options.limit;
  if (options?.cursor) args.cursor = options.cursor;
  if (options?.search) args.search = options.search;
  if (options?.sortBy) args.sortBy = options.sortBy === "createdAt" ? "created" : "updated";
  return args;
}

/** A row of the contract's `list`, as the runtime's summary. */
function summaryOf(r: Record<string, unknown>, scope: ContractScope): ConversationSummary {
  return {
    id: String(r.id),
    createdAt: String(r.createdAt),
    updatedAt: String(r.updatedAt),
    title: typeof r.title === "string" ? r.title : null,
    messageCount: Number(r.messageCount ?? 0),
    preview: String(r.preview ?? ""),
    totalInputTokens: Number(r.totalInputTokens ?? 0),
    totalOutputTokens: Number(r.totalOutputTokens ?? 0),
    // The contract never prices; nothing that lists through this store reads cost.
    totalCostUsd: 0,
    ownerId: typeof r.ownerId === "string" ? r.ownerId : scope.ownerId,
    workspaceId: scope.workspaceId,
  };
}

interface WriteQueue {
  scope: ContractScope;
  pending: ConversationEvent[];
  /** Settles after every batch queued so far; never rejects. */
  tail: Promise<void>;
}

export interface ContractConversationsOptions {
  /**
   * Throws when the kernel's workspace is gone. Called before every `create`,
   * the one call that makes storage in the plugin.
   */
  assertWorkspace: (scope: ContractScope) => void;
  /** Logging verbosity: "debug" persists full request data, as the filesystem store does. */
  logLevel?: "normal" | "debug";
}

export interface ContractConversations {
  /** The store for one owner's conversations in one workspace. `onMutate` fires on every write. */
  forScope(scope: ContractScope, onMutate?: () => void): ConversationEventStore;
  /** Whether `id` is one of the scope's conversations. */
  has(scope: ContractScope, id: string): Promise<boolean>;
  /** Delete every owner's conversations in a workspace and release it. `ownerId` is any verified identity. */
  deleteWorkspace(scope: ContractScope): Promise<void>;
  /** Settle every queued write. */
  flush(): Promise<void>;
}

export function createContractConversations(
  call: ContractCall,
  opts: ContractConversationsOptions,
): ContractConversations {
  const debug = opts.logLevel === "debug";
  const { assertWorkspace } = opts;
  const queues = new Map<string, WriteQueue>();

  /** Send what is pending for one conversation, as one batch. */
  async function drain(id: string, q: WriteQueue): Promise<void> {
    const events = q.pending.splice(0);
    if (events.length === 0) return;
    await call("append_events", { id, events }, q.scope);
  }

  /** Queue events for a conversation; resolves when the batch carrying them has landed. */
  function enqueue(scope: ContractScope, id: string, events: ConversationEvent[]): Promise<void> {
    for (const e of events) assertNoBinaryPayloads(e, `event(${e.type})`);
    let q = queues.get(id);
    if (!q) {
      q = { scope, pending: [], tail: Promise.resolve() };
      queues.set(id, q);
    }
    const queue = q;
    queue.pending.push(...events);
    const sent = queue.tail.then(() => drain(id, queue));
    queue.tail = sent.then(
      () => undefined,
      () => undefined,
    );
    void queue.tail.then(() => {
      if (queues.get(id) === queue && queue.pending.length === 0) queues.delete(id);
    });
    return sent;
  }

  /** Settle one conversation's queued writes. */
  async function settled(id: string): Promise<void> {
    await queues.get(id)?.tail;
  }

  function logFailed(id: string) {
    return (err: unknown) =>
      log.error("[conversations] a queued write failed", {
        conversationId: id,
        error: err instanceof Error ? err.message : String(err),
      });
  }

  async function load(scope: ContractScope, id: string): Promise<Conversation | null> {
    await settled(id);
    try {
      const out = await call("get", { id, expand: "metadata" }, scope);
      return conversationOf(out.metadata as Record<string, unknown>);
    } catch (err) {
      if (codeOf(err) === "conversation_not_found") return null;
      throw err;
    }
  }

  async function readEvents(scope: ContractScope, id: string): Promise<ConversationEvent[]> {
    await settled(id);
    const out: ConversationEvent[] = [];
    let afterSeq = 0;
    let throughSeq: number | undefined;
    for (;;) {
      const page = await call(
        "events",
        { id, afterSeq, limit: EVENTS_PAGE, ...(throughSeq !== undefined ? { throughSeq } : {}) },
        scope,
      );
      const rows = page.events as Array<{ seq: number; event: ConversationEvent }>;
      throughSeq ??= page.lastSeq as number;
      for (const row of rows) out.push(row.event);
      const last = rows[rows.length - 1];
      if (!last || last.seq >= throughSeq) return out;
      afterSeq = last.seq;
    }
  }

  function forScope(scope: ContractScope, onMutate?: () => void): ConversationEventStore {
    let active: string | null = null;
    const written = <T>(p: Promise<T>): Promise<T> => p.finally(() => onMutate?.());

    const store: ConversationEventStore = {
      setActiveConversation(id) {
        active = id;
      },

      emit(event: EngineEvent) {
        if (!active) return;
        const mapped = conversationEventOf(event, debug);
        if (mapped) store.appendEvent(active, mapped);
      },

      appendEvent(id, event) {
        void written(enqueue(scope, id, [event])).catch(logFailed(id));
      },

      async create(options: CreateConversationOptions) {
        // The plugin trusts the workspace the host stamps, so the host stamps
        // only a live one: a deleted workspace gets no conversation.
        assertWorkspace(scope);
        const out = await call(
          "create",
          {
            model: options.model,
            ...(options.id ? { id: options.id } : {}),
            ...(options.metadata ? { metadata: options.metadata } : {}),
          },
          scope,
        );
        onMutate?.();
        const created = out.conversation as Record<string, unknown>;
        return {
          ...conversationOf(created),
          ...(options.metadata ? { metadata: options.metadata } : {}),
        };
      },

      async load(id: string, access?: ConversationAccessContext) {
        const conversation = await load(scope, id);
        if (!conversation) return null;
        if (access && conversation.ownerId !== access.userId) return null;
        return conversation;
      },

      async append(conversation: Conversation, message: StoredMessage) {
        await written(enqueue(scope, conversation.id, messageEvents(message)));
      },

      readEvents: (id) => readEvents(scope, id),

      async history(conversation: Conversation, limit?: number): Promise<StoredMessage[]> {
        const messages = reconstructMessages(await readEvents(scope, conversation.id));
        return limit ? messages.slice(-limit) : messages;
      },

      async list(options?: ListOptions): Promise<ConversationListResult> {
        const out = await call("list", listArgs(options), scope);
        const rows = out.conversations as Array<Record<string, unknown>>;
        return {
          conversations: rows.map((r) => summaryOf(r, scope)),
          nextCursor: (out.nextCursor as string | null) ?? null,
          totalCount: Number(out.totalCount ?? rows.length),
        };
      },

      async delete(id: string) {
        await settled(id);
        const out = await call("delete", { id }, scope);
        onMutate?.();
        return out.deleted === true;
      },

      async update(id: string, patch: ConversationPatch) {
        if (patch.title !== undefined) {
          await settled(id);
          try {
            await call("update", { id, title: patch.title }, scope);
          } catch (err) {
            if (codeOf(err) === "conversation_not_found") return null;
            throw err;
          }
          onMutate?.();
        }
        return load(scope, id);
      },

      flush,
    };
    return store;
  }

  async function flush(): Promise<void> {
    await Promise.all([...queues.values()].map((q) => q.tail));
  }

  return {
    forScope,
    has: async (scope, id) => (await load(scope, id)) !== null,
    async deleteWorkspace(scope) {
      await flush();
      await call("delete_workspace", {}, scope);
    },
    flush,
  };
}
