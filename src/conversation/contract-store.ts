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
 * - **A write settles with the batch that carried it.** Every caller whose
 *   events were in a failed batch is rejected with its error; one the caller
 *   does not await is logged.
 * - **An append is never retried**: the contract has no idempotency key, and a
 *   batch whose answer was lost may have landed.
 * - **A failed batch closes its conversation's queue.** Every later write to
 *   that conversation is refused with the same error, so no event lands after
 *   a gap its writer believes was filled. A completed read of the conversation
 *   (`load`, `readEvents`, `history`), which shows what was stored, opens it
 *   again.
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

/** Events queued for one conversation, and the callers waiting on the batch that carries them. */
interface WriteQueue {
  scope: ContractScope;
  pending: ConversationEvent[];
  waiters: Array<PromiseWithResolvers<void>>;
  /** Settles after every batch queued so far; never rejects. */
  tail: Promise<void>;
  /**
   * Why a batch failed. While set the queue is closed: every write after it is
   * refused with this error, so nothing lands after a gap a caller believes
   * was filled. A completed read of the conversation clears it.
   */
  failed?: unknown;
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

  /**
   * Send what is pending for one conversation as one batch, and settle every
   * caller waiting on it with the batch's outcome. A failed batch closes the
   * queue: what was queued behind it is refused with the same error.
   */
  async function drain(id: string, q: WriteQueue): Promise<void> {
    const events = q.pending.splice(0);
    const waiters = q.waiters.splice(0);
    if (waiters.length === 0) return;
    if (q.failed === undefined) {
      try {
        await call("append_events", { id, events }, q.scope);
      } catch (err) {
        q.failed = err;
      }
    }
    for (const w of waiters) {
      if (q.failed === undefined) w.resolve();
      else w.reject(q.failed);
    }
  }

  /**
   * Queue events for a conversation. Settles with the outcome of the batch that
   * carries them: every caller in a failed batch rejects with its error, and so
   * does every write queued after it until a read clears the queue.
   */
  function enqueue(scope: ContractScope, id: string, events: ConversationEvent[]): Promise<void> {
    for (const e of events) assertNoBinaryPayloads(e, `event(${e.type})`);
    let q = queues.get(id);
    if (!q) {
      q = { scope, pending: [], waiters: [], tail: Promise.resolve() };
      queues.set(id, q);
    }
    const queue = q;
    if (queue.failed !== undefined) return Promise.reject(queue.failed);
    const waiter = Promise.withResolvers<void>();
    queue.pending.push(...events);
    queue.waiters.push(waiter);
    queue.tail = queue.tail.then(() => drain(id, queue));
    void queue.tail.then(() => {
      const idle = queue.waiters.length === 0 && queue.failed === undefined;
      if (queues.get(id) === queue && idle) queues.delete(id);
    });
    return waiter.promise;
  }

  /** Settle one conversation's queued writes. */
  async function settled(id: string): Promise<void> {
    await queues.get(id)?.tail;
  }

  /**
   * A read of the conversation completed after its writes settled: the caller
   * now sees what was stored, so a closed queue opens again.
   */
  function reconciled(id: string): void {
    const q = queues.get(id);
    if (q?.failed !== undefined && q.waiters.length === 0) queues.delete(id);
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
      reconciled(id);
      return conversationOf(out.metadata as Record<string, unknown>);
    } catch (err) {
      if (codeOf(err) !== "conversation_not_found") throw err;
      reconciled(id);
      return null;
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
      if (!last || last.seq >= throughSeq) {
        reconciled(id);
        return out;
      }
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
