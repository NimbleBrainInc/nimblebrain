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
 */

import { refreshSession } from "./client";

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
  const { conversationId, apiBase = "", token, onEvent, onSubscribed, onError } = options;

  let closed = false;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  // Track the resume point so a reconnect picks up exactly where we left off.
  let lastSeq = options.afterSeq ?? 0;

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
        onError?.(new Error("Conversation stream auth failed after token refresh"));
        return;
      }
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          onError?.(new Error(`Conversation stream access denied: ${res.status}`));
          return;
        }
        throw new Error(`Conversation stream failed: ${res.status} ${res.statusText}`);
      }

      backoff = INITIAL_BACKOFF_MS;
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentSeq: number | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;
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

      if (!closed) scheduleReconnect();
    } catch (err) {
      if (closed) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message.includes("403")) {
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
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      abortController?.abort();
      abortController = null;
    },
  };
}
