/**
 * What every conversation-store provider shares and is not the medium: the
 * change feed its subscribers listen on, and the tracing and metrics each
 * operation is measured by (ADR-0075).
 */

import { storeOperationSeconds } from "../api/metrics.ts";
import { log } from "../observability/log.ts";
import { withSpan } from "../observability/tracing.ts";
import type { ConversationChange, ConversationStore, StoredEvent } from "./store.ts";

/** A provider's subscriber list. `publish` calls each listener; one that throws is logged and skipped. */
export interface ChangeFeed {
  subscribe(listener: (change: ConversationChange) => void): () => void;
  publish(change: ConversationChange): void;
}

export function createChangeFeed(): ChangeFeed {
  const listeners = new Set<(change: ConversationChange) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(change) {
      for (const listener of listeners) {
        try {
          listener(change);
        } catch (err) {
          log.warn("[conversations] change listener threw", {
            kind: change.kind,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}

/**
 * Time one operation under `conversations.<op>`: a span (attributes are the
 * operation and provider only, never a conversation's contents) and a sample
 * of `nb_store_operation_seconds`.
 */
async function measured<T>(provider: string, op: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  let outcome: "ok" | "error" = "error";
  try {
    const value = await withSpan(
      `conversations.${op}`,
      { "store.name": "conversations", "store.op": op, "store.provider": provider },
      () => fn(),
    );
    outcome = "ok";
    return value;
  } finally {
    storeOperationSeconds.observe(
      { store: "conversations", op, provider, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/** `events` measured from the first read to the last event yielded (or the throw). */
async function* measuredEvents(
  provider: string,
  source: () => AsyncIterable<StoredEvent>,
): AsyncIterable<StoredEvent> {
  const started = performance.now();
  let outcome: "ok" | "error" = "error";
  try {
    yield* source();
    outcome = "ok";
  } finally {
    storeOperationSeconds.observe(
      { store: "conversations", op: "events", provider, outcome },
      (performance.now() - started) / 1000,
    );
  }
}

/** Wrap a provider so every operation is traced and measured, whichever provider it is. */
export function instrumentConversationStore(
  provider: string,
  store: ConversationStore,
): ConversationStore {
  return {
    crossProcess: store.crossProcess,
    create: (scope, init) => measured(provider, "create", () => store.create(scope, init)),
    get: (scope, id) => measured(provider, "get", () => store.get(scope, id)),
    events: (scope, id, opts) => measuredEvents(provider, () => store.events(scope, id, opts)),
    appendEvents: (scope, id, events) =>
      measured(provider, "appendEvents", () => store.appendEvents(scope, id, events)),
    update: (scope, id, patch) =>
      measured(provider, "update", () => store.update(scope, id, patch)),
    delete: (scope, id) => measured(provider, "delete", () => store.delete(scope, id)),
    deleteWorkspace: (workspaceId) =>
      measured(provider, "deleteWorkspace", () => store.deleteWorkspace(workspaceId)),
    list: (scope, query) => measured(provider, "list", () => store.list(scope, query)),
    search: (scope, query) => measured(provider, "search", () => store.search(scope, query)),
    subscribe: (listener) => store.subscribe(listener),
  };
}

/** Read a conversation's events into an array (a convenience over `events`). */
export async function collectEvents(
  store: ConversationStore,
  ...args: Parameters<ConversationStore["events"]>
): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for await (const stored of store.events(...args)) out.push(stored);
  return out;
}
