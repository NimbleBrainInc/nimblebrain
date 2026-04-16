import type { SseEventMap, SseEventType } from "../types";
import { refreshSession } from "./client";

/** Options for connecting to the workspace event stream. */
export interface ConnectEventsOptions {
  /** Base URL. Defaults to empty string (same-origin). */
  apiBase?: string;
  /** Bearer token for authorization. */
  token?: string;
  /** Workspace ID sent as X-Workspace-Id header. */
  workspaceId?: string;
  /** Called when a typed SSE event is received. */
  onEvent: <K extends SseEventType>(type: K, data: SseEventMap[K]) => void;
  /** Called when the connection is established. */
  onOpen?: () => void;
  /** Called when the connection is lost (before reconnect). */
  onDisconnect?: () => void;
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
 * Connect to the workspace-level SSE event stream at GET /v1/events.
 *
 * Uses fetch + ReadableStream to support the Authorization header
 * (EventSource does not support custom headers).
 *
 * Auto-reconnects on disconnect with exponential backoff.
 */
export function connectEvents(options: ConnectEventsOptions): EventConnection {
  const { apiBase = "", token, workspaceId, onEvent, onOpen, onDisconnect, onError } = options;

  let closed = false;
  let abortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = INITIAL_BACKOFF_MS;

  async function connect(): Promise<void> {
    if (closed) return;

    abortController = new AbortController();
    const hdrs: Record<string, string> = {};
    if (token && token !== "__cookie__") {
      hdrs.Authorization = `Bearer ${token}`;
    }
    if (workspaceId) {
      hdrs["X-Workspace-Id"] = workspaceId;
    }

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
      onOpen?.();

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done || closed) break;

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
        onDisconnect?.();
        scheduleReconnect();
      }
    } catch (err) {
      if (closed) return;

      // AbortError means we called close() — don't reconnect
      if (err instanceof DOMException && err.name === "AbortError") return;

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
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
      connect();
    }, backoff);
  }

  // Start initial connection
  connect();

  return {
    close() {
      closed = true;
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
