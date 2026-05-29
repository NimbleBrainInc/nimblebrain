/**
 * Per-conversation SSE client.
 *
 * Connects to GET /v1/conversations/:id/events to receive real-time
 * chat events from other participants in a shared conversation.
 *
 * Same pattern and reliability primitives as `sse.ts`:
 *   - fetch + ReadableStream (for custom auth headers — EventSource
 *     doesn't carry them)
 *   - auto-reconnect with jittered exponential backoff
 *   - heartbeat watchdog (force-reconnect on stale stream)
 *   - visibility-resume (immediate reconnect when the tab returns)
 *   - `onReconnect` for state resync (load missed messages)
 */

import { refreshSession } from "./client";
import {
  clearConversationSubscriberId,
  setConversationSubscriberId,
} from "./conversation-subscribers";

/** Options for connecting to a conversation event stream. */
export interface ConversationSseOptions {
  conversationId: string;
  /** Base URL. Defaults to empty string (same-origin). */
  apiBase?: string;
  /** Bearer token for authorization. */
  token?: string;
  /** Called when an SSE event is received. */
  onEvent: (type: string, data: unknown) => void;
  /** Called on successful reconnection (caller should reload conversation). */
  onReconnect?: () => void;
  /** Called when the connection is lost (before reconnect). */
  onDisconnect?: () => void;
  /** Called on unrecoverable error (e.g. 403 after participant removal). */
  onError?: (error: Error) => void;
}

/** Handle to close the conversation SSE connection. */
export interface ConversationSseConnection {
  close(): void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_JITTER = 0.2;
const STALE_THRESHOLD_MS = 75_000;
const WATCHDOG_TICK_MS = 15_000;

export function connectConversationEvents(
  options: ConversationSseOptions,
): ConversationSseConnection {
  const {
    conversationId,
    apiBase = "",
    token,
    onEvent,
    onReconnect,
    onDisconnect,
    onError,
  } = options;

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

    try {
      const res = await fetch(
        `${apiBase}/v1/conversations/${encodeURIComponent(conversationId)}/events`,
        {
          headers: hdrs,
          credentials: "include",
          signal: abortController.signal,
        },
      );

      if (res.status === 401) {
        // Attempt silent token refresh before giving up
        const refreshed = await refreshSession();
        if (refreshed) {
          scheduleReconnect();
          return;
        }
        onError?.(new Error("Conversation SSE auth failed after token refresh"));
        return;
      }

      if (!res.ok) {
        // 403/404 = access denied or removed — don't reconnect
        if (res.status === 403 || res.status === 404) {
          onError?.(new Error(`Conversation access denied: ${res.status}`));
          return;
        }
        throw new Error(`Conversation SSE failed: ${res.status} ${res.statusText}`);
      }

      // Connected successfully — reset backoff
      backoff = INITIAL_BACKOFF_MS;
      markFrame();
      startWatchdog();

      // If this is a reconnect, notify so caller can reload missed messages
      if (hasConnectedBefore) {
        onReconnect?.();
      }
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
              if (currentEvent === "subscribed") {
                // Server-issued subscriber id — record it so the
                // chat-stream POST can suppress self-echo. We
                // deliberately don't surface this event to onEvent;
                // it's plumbing, not a chat event.
                const subscriberId = (data as { subscriberId?: unknown })?.subscriberId;
                if (typeof subscriberId === "string") {
                  setConversationSubscriberId(conversationId, subscriberId);
                }
              } else {
                onEvent(currentEvent, data);
              }
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
      if (err instanceof DOMException && err.name === "AbortError") {
        // Self-aborted (watchdog / visibility) — reschedule.
        stopWatchdog();
        onDisconnect?.();
        scheduleReconnect();
        return;
      }

      stopWatchdog();
      onDisconnect?.();

      // 403 is unrecoverable (access denied). 401 — try refresh first.
      if (err instanceof Error && err.message.includes("401")) {
        const refreshed = await refreshSession();
        if (refreshed) {
          scheduleReconnect();
          return;
        }
        onError?.(err);
        return;
      }
      if (err instanceof Error && err.message.includes("403")) {
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
      // Drop the cached subscriber id — the next subscription gets a
      // fresh server-issued id, so a stale entry would mislead the
      // chat-stream POST into excluding a subscriber that no longer
      // exists.
      clearConversationSubscriberId(conversationId);
    },
  };
}
