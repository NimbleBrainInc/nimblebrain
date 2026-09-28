/**
 * SSE comment frames: the one a stream writes when it opens, and the
 * keepalive for request-scoped streams.
 *
 * Emits `: ping\n\n` comment frames on an SSE stream's controller at a
 * fixed interval so AWS ALB (and anything else enforcing TCP idle
 * timeouts) doesn't drop long-running streams during silent engine
 * periods. SSE comment lines are ignored by the client per spec.
 *
 * Not to be confused with `SseEventManager`/`ConversationEventManager`'s
 * `heartbeat` broadcast: those emit a named `heartbeat` SSE *event* at
 * 30s to every subscriber on a shared workspace/conversation channel.
 * This helper emits comment frames at 20s on a single request-scoped
 * stream (currently only `/v1/workspaces/:wsId/chat/stream`). Same word, different
 * paradigm.
 */

const encoder = new TextEncoder();
const PING_FRAME = encoder.encode(": ping\n\n");

/**
 * The comment a long-lived SSE stream writes the moment it opens. A server
 * sends a streamed response's status and headers with its first chunk, so a
 * stream that waits for its first event leaves the client's request pending
 * until something happens to be broadcast (up to a full heartbeat). The
 * parser ignores comment lines, so this reaches no event handler.
 */
export const CONNECTED_FRAME = encoder.encode(": connected\n\n");

export interface SseHeartbeat {
  /** Cancel the heartbeat. Idempotent. */
  stop(): void;
}

/**
 * Start a heartbeat on `controller`, firing every `intervalMs`.
 * Returns a handle with `stop()` to cancel. Enqueue failures (e.g.
 * controller already closed) are swallowed — callers own controller
 * lifecycle.
 */
export function startSseHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  intervalMs: number,
): SseHeartbeat {
  const timer = setInterval(() => {
    try {
      controller.enqueue(PING_FRAME);
    } catch {
      // Controller already closed; the timer will be cleared by stop().
    }
  }, intervalMs);
  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
