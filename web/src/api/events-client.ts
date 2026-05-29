// ---------------------------------------------------------------------------
// Workspace Event Stream — singleton client
//
// One `/v1/events` SSE connection per tab, fanned out to many subscribers
// via the typed `subscribe` API. Same shape as `mcp-bridge-client.ts` —
// lazy module-level singleton with lifecycle reset.
//
// Why this exists. Pre-singleton, `useEvents` opened its own
// `connectEvents()` inside the hook's `useEffect`. Every component that
// mounted the hook (App, WorkspaceAppIconsProvider, ConnectorList, …)
// held an independent SSE connection to the same endpoint, receiving
// identical broadcasts. On localhost HTTP/1.1 this exhausted Chrome's
// 6-per-origin connection budget once a second tab joined; in production
// the duplication still fanned every global event out N× per tab.
//
// The contract:
//   - subscribe<K>(type, handler) → unsubscribe
//   - onReconnect(handler)        → unsubscribe   (state-resync hook)
//   - closeEventsClient()         — for `pagehide` + tests
//
// Lifecycle:
//   - Lazy open on first `subscribe()`.
//   - **Does NOT close on last unsubscribe.** Closing on momentary zero
//     thrashes the connection across React StrictMode double-mounts;
//     there's always a subscriber in practice. Auth lifecycle and
//     `pagehide` are the only canonical close triggers.
//   - `addAuthLifecycleHandler` (multi-listener; see api/client.ts)
//     drops the connection on logout / token rotation, then immediately
//     re-opens if subscribers remain and a token is present. The next
//     SSE fetch reads the fresh token via the closure captured at
//     `ensureOpen()`.
// ---------------------------------------------------------------------------

import type { SseEventMap, SseEventType } from "../types";
import { addAuthLifecycleHandler, getAuthToken } from "./client";
import { connectEvents, type EventConnection } from "./sse";

type Handler<K extends SseEventType> = (data: SseEventMap[K]) => void;
type ReconnectHandler = () => void;

// biome-ignore lint/suspicious/noExplicitAny: subscriber set is keyed by event type; type-safety is enforced by `subscribe<K>` at the public boundary
const eventHandlers = new Map<SseEventType, Set<Handler<any>>>();
const reconnectHandlers = new Set<ReconnectHandler>();

let connection: EventConnection | null = null;

function hasAnySubscribers(): boolean {
  if (reconnectHandlers.size > 0) return true;
  for (const set of eventHandlers.values()) {
    if (set.size > 0) return true;
  }
  return false;
}

function ensureOpen(): void {
  if (connection) return;
  connection = connectEvents({
    token: getAuthToken() ?? undefined,
    onEvent: <K extends SseEventType>(type: K, data: SseEventMap[K]) => {
      const set = eventHandlers.get(type);
      if (!set) return;
      for (const h of set) {
        try {
          (h as Handler<K>)(data);
        } catch (err) {
          console.warn("[events-client] event handler threw for", type, err);
        }
      }
    },
    onReconnect: () => {
      for (const h of reconnectHandlers) {
        try {
          h();
        } catch (err) {
          console.warn("[events-client] reconnect handler threw:", err);
        }
      }
    },
  });
}

/**
 * Close the underlying connection. The singleton's subscribers stay
 * registered — the next `ensureOpen()` (via subscribe or auth-lifecycle
 * recycle) re-establishes with fresh creds. Safe when no connection
 * exists.
 *
 * Exported for `pagehide` cleanup in `App.tsx` and for test isolation.
 */
export function closeEventsClient(): void {
  const c = connection;
  connection = null;
  c?.close();
}

// Auth lifecycle: identity rotation closes the connection and (if
// subscribers remain + we still have a token) immediately re-opens
// under the new identity. Logout (token → null) closes without
// re-opening; the next `subscribe()` will lazy-open if a token reappears.
const authLifecycleHandler = (): void => {
  closeEventsClient();
  if (hasAnySubscribers() && getAuthToken() !== null) {
    ensureOpen();
  }
};
addAuthLifecycleHandler(authLifecycleHandler);

/**
 * Subscribe a handler to a typed event. The first call across all event
 * types lazily opens the underlying SSE connection; subsequent calls
 * share it. Returns an unsubscribe function — calling it removes the
 * handler but does NOT close the connection (the workspace stream
 * persists for tab life — see file header).
 *
 * Handler errors are caught so a buggy subscriber can't strand
 * subsequent handlers for the same event.
 */
export function subscribe<K extends SseEventType>(type: K, handler: Handler<K>): () => void {
  ensureOpen();
  let set = eventHandlers.get(type);
  if (!set) {
    set = new Set();
    eventHandlers.set(type, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}

/**
 * Register a handler invoked after every successful reconnection (NOT
 * the initial connect). Consumers wire this to refetch state that may
 * have drifted during the disconnect gap — bundles, workspace config —
 * since the workspace stream has no `Last-Event-Id` replay. `useEvents`
 * routes this through to its `onReconnect` option (currently consumed
 * by `App.tsx` to call `refreshShell` + `refreshConfig`).
 */
export function onReconnect(handler: ReconnectHandler): () => void {
  reconnectHandlers.add(handler);
  return () => {
    reconnectHandlers.delete(handler);
  };
}

// ── Test seams ───────────────────────────────────────────────────────
// Internal helpers used only by `web/__tests__/events-client.test.ts`.
// Kept out of the public surface above so production callers don't
// reach for them; test files import from `__internal__`.

export const __internal__ = {
  hasConnection(): boolean {
    return connection !== null;
  },
  subscriberCount(): number {
    let n = reconnectHandlers.size;
    for (const set of eventHandlers.values()) n += set.size;
    return n;
  },
  resetForTest(): void {
    closeEventsClient();
    eventHandlers.clear();
    reconnectHandlers.clear();
    // Other test files in the suite may have called
    // `setAuthLifecycleHandler(null)` to neutralize the MCP bridge's
    // handler — which also clears ours. Re-register idempotently so
    // events-client tests can rely on the lifecycle hook firing.
    addAuthLifecycleHandler(authLifecycleHandler);
  },
};
