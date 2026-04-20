/**
 * SSE keepalive helper.
 *
 * Emits `: ping\n\n` comment frames on an SSE stream's controller at a
 * fixed interval so AWS ALB (and anything else enforcing TCP idle
 * timeouts) doesn't drop long-running streams during silent engine
 * periods. SSE comment lines are ignored by the client per spec.
 */

const encoder = new TextEncoder();
const PING_FRAME = encoder.encode(": ping\n\n");

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
