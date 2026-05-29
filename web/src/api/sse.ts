import type { SseEventMap, SseEventType } from "../types";
import { refreshSession } from "./client";

/** Options for connecting to the workspace event stream. */
export interface ConnectEventsOptions {
  /** Base URL. Defaults to empty string (same-origin). */
  apiBase?: string;
  /** Bearer token for authorization. */
  token?: string;
  /**
   * @deprecated The `/v1/events` route is identity-scoped server-side
   * (see `src/api/routes/events.ts`); the server reads memberships from
   * `WorkspaceStore` and ignores any client-sent `X-Workspace-Id`. The
   * option is preserved for callers we haven't migrated, but is a no-op.
   */
  workspaceId?: string;
  /** Called when a typed SSE event is received. */
  onEvent: <K extends SseEventType>(type: K, data: SseEventMap[K]) => void;
  /** Called when the connection is established (each open, not just the first). */
  onOpen?: () => void;
  /** Called when the connection is lost (before reconnect). */
  onDisconnect?: () => void;
  /**
   * Called on successful reconnection (NOT the initial connect). Lets
   * consumers refetch state that may have drifted during the gap —
   * bundles, config, skills. Mirrors the same hook on
   * `conversation-sse.ts` so call sites can route both with one pattern.
   */
  onReconnect?: () => void;
  /** Called on unrecoverable error. */
  onError?: (error: Error) => void;
}

/** Handle returned by connectEvents, used to close the connection. */
export interface EventConnection {
  close(): void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
/**
 * ±20% jitter on the reconnect delay. Prevents the thundering-herd
 * pattern where every tab the server rolled retries on the same beat
 * after a process bounce.
 */
const BACKOFF_JITTER = 0.2;
/**
 * Force-disconnect threshold. Server emits a `heartbeat` every 30s
 * (`SseEventManager.start`), so 75s without any frame means the link
 * is dead but the TCP socket hasn't reported it yet — common on
 * laptop wake / wifi resume. Triggering a reconnect from the client
 * side recovers in seconds instead of minutes.
 */
const STALE_THRESHOLD_MS = 75_000;
/** Watchdog poll interval. */
const WATCHDOG_TICK_MS = 15_000;

/**
 * Connect to the workspace-level SSE event stream at GET /v1/events.
 *
 * Uses fetch + ReadableStream to support the Authorization header
 * (EventSource does not support custom headers).
 *
 * Reliability primitives:
 *
 *   - **Auto-reconnect** with exponential backoff (1s → 30s), jittered
 *     ±20% to avoid thundering herd against a freshly-rolled server.
 *   - **Heartbeat watchdog** — if no frame arrives for ~75s the
 *     connection is force-aborted and reconnected. Catches dead links
 *     that TCP hasn't surfaced yet (laptop wake, wifi resume).
 *   - **Visibility-resume** — when the tab comes back to the
 *     foreground, if the last frame is stale we trigger an immediate
 *     reconnect instead of waiting for the watchdog to tick.
 *   - **`onReconnect` callback** — fires on every successful
 *     re-establishment so consumers can refetch state that may have
 *     drifted during the gap.
 */
export function connectEvents(options: ConnectEventsOptions): EventConnection {
  const { apiBase = "", token, onEvent, onOpen, onDisconnect, onReconnect, onError } = options;

  let closed = false;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  let hasConnectedBefore = false;
  let lastFrameAt = Date.now();

  function markFrame(): void {
    lastFrameAt = Date.now();
  }

  function isStale(): boolean {
    return Date.now() - lastFrameAt > STALE_THRESHOLD_MS;
  }

  function forceReconnect(): void {
    // Aborting the in-flight fetch unwinds the read loop in `connect()`;
    // the catch branch reschedules from the aborted state.
    abortController?.abort();
  }

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (closed) return;
      if (isStale()) forceReconnect();
    }, WATCHDOG_TICK_MS);
  }

  function stopWatchdog(): void {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function onVisibilityChange(): void {
    if (closed) return;
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    if (isStale()) forceReconnect();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  async function connect(): Promise<void> {
    if (closed) return;

    abortController = new AbortController();
    const hdrs: Record<string, string> = {};
    if (token && token !== "__cookie__") {
      hdrs.Authorization = `Bearer ${token}`;
    }
    // Note: no `X-Workspace-Id`. `/v1/events` is identity-scoped — the
    // server reads memberships from the workspace store and broadcasts
    // accordingly.

    try {
      const res = await fetch(`${apiBase}/v1/events`, {
        headers: hdrs,
        credentials: "include",
        signal: abortController.signal,
      });

      if (res.status === 401) {
        // Attempt silent token refresh before giving up
        const refreshed = await refreshSession();
        if (refreshed) {
          // Token refreshed — reconnect immediately
          scheduleReconnect();
          return;
        }
        onError?.(new Error("SSE auth failed after token refresh"));
        return;
      }

      if (!res.ok) {
        throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
      }

      // Connected successfully — reset backoff
      backoff = INITIAL_BACKOFF_MS;
      markFrame();
      startWatchdog();
      onOpen?.();
      if (hasConnectedBefore) onReconnect?.();
      hasConnectedBefore = true;

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        markFrame();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              onEvent(currentEvent as SseEventType, data);
            } catch {
              // Skip malformed data lines
            }
            currentEvent = "";
          }
        }
      }

      // Stream ended — reconnect unless closed
      if (!closed) {
        stopWatchdog();
        onDisconnect?.();
        scheduleReconnect();
      }
    } catch (err) {
      if (closed) return;

      // AbortError: either a user-initiated close (handled above via
      // `closed`) or a watchdog/visibility force-reconnect. In the
      // latter case the connection is dead and we reschedule a fresh
      // attempt from the same backoff state.
      if (err instanceof DOMException && err.name === "AbortError") {
        stopWatchdog();
        onDisconnect?.();
        scheduleReconnect();
        return;
      }

      stopWatchdog();
      onDisconnect?.();

      // Auth errors: try refresh before giving up
      if (err instanceof Error && err.message.includes("401")) {
        const refreshed = await refreshSession();
        if (refreshed) {
          scheduleReconnect();
          return;
        }
        onError?.(err);
        return;
      }

      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    if (reconnectTimer) return;
    const jittered = backoff * (1 - BACKOFF_JITTER + Math.random() * 2 * BACKOFF_JITTER);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
      connect();
    }, jittered);
  }

  // Start initial connection
  connect();

  return {
    close() {
      closed = true;
      stopWatchdog();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },
  };
}
