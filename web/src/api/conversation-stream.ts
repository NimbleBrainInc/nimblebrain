/**
 * Conversation turn-stream client (server-authoritative streaming).
 *
 * Connects to GET /v1/conversations/:id/events?afterSeq=N. The server replays
 * the in-flight turn from the RunBus (events with seq > afterSeq), then tails
 * live. This is the ONE rendering path: send, resume-after-refresh, switch
 * back, and cross-tab all watch the same stream.
 *
 * Each frame carries a sequence number in the SSE `id:` line. We track the
 * highest seq seen and reconnect with `afterSeq=<lastSeq>`, so a dropped
 * connection resumes seamlessly with no gap or duplication — no full reload.
 *
 * Transport robustness (ported from the former conversation-sse.ts):
 *   - stale-stream watchdog: a silent connection (proxy idle-timeout, dead
 *     NAT binding, laptop sleep) stops delivering frames without surfacing an
 *     error. A periodic watchdog force-reconnects when no frame has arrived
 *     within `staleThresholdMs`. The reconnect carries `afterSeq=lastSeq`, so
 *     it's gapless — the seq machinery makes the recovery free.
 *   - visibility-resume: when a backgrounded tab returns to foreground and the
 *     stream is stale, reconnect immediately instead of waiting for the next
 *     watchdog tick.
 *
 * This viewer assumes the RunBus (seq'd) path. The legacy `/v1/chat` and
 * `/v1/chat/stream` endpoints fan out to the same conversation subscribers via
 * `broadcastToConversation`, which is seq-less (no `id:` line) and not RunBus-
 * backed — those frames apply live but don't advance `lastSeq` and have no
 * replay/resume. The web shell doesn't use those endpoints; only an external
 * caller hitting them while a web tab watches the same conversation would mix
 * the two streams.
 */

import { refreshSession } from "./client";

/** No-frame interval after which the watchdog force-reconnects. Slightly above
 *  the server's 30s heartbeat so a single missed heartbeat doesn't churn. */
const DEFAULT_STALE_THRESHOLD_MS = 75_000;
/** How often the watchdog checks for staleness. */
const DEFAULT_WATCHDOG_TICK_MS = 15_000;

export interface ConversationStreamOptions {
  conversationId: string;
  apiBase?: string;
  token?: string;
  /** Highest seq the caller has already applied (resume point). Default 0. */
  afterSeq?: number;
  /** Called for each turn event. `seq` is monotonic within a turn. */
  onEvent: (type: string, data: unknown, seq: number) => void;
  /** Called once per (re)connect with the server's current turn state, before
   *  any replayed events. Lets the caller trim a stale in-flight turn. */
  onSubscribed?: (info: { isActive: boolean; activeSeq: number }) => void;
  /** Called on unrecoverable error (403/404/auth). */
  onError?: (error: Error) => void;
  /** No-frame interval before the watchdog force-reconnects. Default 75s.
   *  Exposed for tests to drive staleness deterministically. */
  staleThresholdMs?: number;
  /** Watchdog poll interval. Default 15s. Exposed for tests. */
  watchdogTickMs?: number;
}

export interface ConversationStreamConnection {
  close(): void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

export function connectConversationStream(
  options: ConversationStreamOptions,
): ConversationStreamConnection {
  const {
    conversationId,
    apiBase = "",
    token,
    onEvent,
    onSubscribed,
    onError,
    staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
    watchdogTickMs = DEFAULT_WATCHDOG_TICK_MS,
  } = options;

  let closed = false;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  // Track the resume point so a reconnect picks up exactly where we left off.
  let lastSeq = options.afterSeq ?? 0;
  // Timestamp of the last byte received; drives stale-stream detection.
  let lastFrameAt = Date.now();

  function markFrame(): void {
    lastFrameAt = Date.now();
  }

  function isStale(): boolean {
    return Date.now() - lastFrameAt > staleThresholdMs;
  }

  /** Abort the live fetch. The read loop's catch path reschedules a reconnect
   *  (with afterSeq=lastSeq), so this is the single "force a fresh stream" lever
   *  shared by the watchdog and the visibility handler. */
  function forceReconnect(): void {
    abortController?.abort();
  }

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (closed) return;
      if (isStale()) forceReconnect();
    }, watchdogTickMs);
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

  /** Release every resource: stop reconnects, the watchdog, the document
   *  listener, and the in-flight fetch. Idempotent. Both `close()` (caller
   *  teardown) and the terminal-error branches go through this so a stream
   *  that gives up never leaks its `visibilitychange` listener. */
  function teardown(): void {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopWatchdog();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    abortController?.abort();
    abortController = null;
  }

  async function connect(): Promise<void> {
    if (closed) return;
    abortController = new AbortController();
    const hdrs: Record<string, string> = {};
    if (token && token !== "__cookie__") hdrs.Authorization = `Bearer ${token}`;

    try {
      const url = `${apiBase}/v1/conversations/${encodeURIComponent(conversationId)}/events?afterSeq=${lastSeq}`;
      const res = await fetch(url, {
        headers: hdrs,
        credentials: "include",
        signal: abortController.signal,
      });

      if (res.status === 401) {
        const refreshed = await refreshSession();
        if (refreshed) return void scheduleReconnect();
        teardown();
        onError?.(new Error("Conversation stream auth failed after token refresh"));
        return;
      }
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          teardown();
          onError?.(new Error(`Conversation stream access denied: ${res.status}`));
          return;
        }
        throw new Error(`Conversation stream failed: ${res.status} ${res.statusText}`);
      }

      backoff = INITIAL_BACKOFF_MS;
      markFrame();
      startWatchdog();
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentSeq: number | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        markFrame();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("id: ")) {
            const n = Number.parseInt(line.slice(4).trim(), 10);
            currentSeq = Number.isFinite(n) ? n : null;
          } else if (line.startsWith("data: ") && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === "subscribed") {
                const info = data as { isActive?: boolean; activeSeq?: number };
                onSubscribed?.({
                  isActive: info.isActive ?? false,
                  activeSeq: info.activeSeq ?? 0,
                });
              } else {
                const seq = currentSeq ?? 0;
                if (seq > lastSeq) lastSeq = seq;
                onEvent(currentEvent, data, seq);
              }
            } catch {
              // Skip malformed frames.
            }
            currentEvent = "";
            currentSeq = null;
          }
        }
      }

      stopWatchdog();
      if (!closed) scheduleReconnect();
    } catch (err) {
      stopWatchdog();
      if (closed) return;
      if (err instanceof DOMException && err.name === "AbortError") {
        // Self-aborted by the watchdog / visibility handler — reconnect
        // immediately (no backoff; the stream was stale, not erroring).
        connect();
        return;
      }
      if (err instanceof Error && err.message.includes("403")) {
        teardown();
        onError?.(err);
        return;
      }
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
      connect();
    }, backoff);
  }

  connect();

  return {
    close: teardown,
  };
}
