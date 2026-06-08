// ---------------------------------------------------------------------------
// conversation-stream.ts — transport robustness (watchdog + visibility-resume)
//
// The seq-based replay path (afterSeq resume) is exercised end-to-end by the
// chat-store suite. These tests pin the transport-layer behavior ported from
// the former conversation-sse.ts: a silently-stalled stream (no error, no
// close — just no frames) must be force-reconnected, and a foregrounded tab
// must reconnect immediately rather than wait for the next watchdog tick.
//
// Determinism: thresholds are injected tiny (stale=30ms, tick=10ms) so the
// watchdog fires within the test window using real timers. The fetch mock
// returns a stream that emits the `subscribed` frame then goes silent, which
// is exactly the stall the watchdog exists to recover from.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// Use the real module captured in the preload (test/setup.ts), NOT a direct
// `import from "./conversation-stream"`: sibling suites (chat-store.test,
// chatBleed, inlineError) `mock.module` this path with a watchdog-less fake,
// and that mock is process-global + permanent. Importing directly would
// resolve to their fake whenever this file runs after them.
import { realConversationStream } from "../../test/setup";

const { connectConversationStream } = realConversationStream;

let originalFetch: typeof globalThis.fetch;

/** Poll `predicate` every 10ms up to `timeoutMs`. Resolves true as soon as it
 *  holds, false on timeout. Load-tolerant — the watchdog fires on a real timer
 *  whose callback can be delayed under a busy event loop (full-suite runs), so
 *  a fixed sleep races; polling waits exactly as long as needed. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

/** Build an SSE Response whose body emits `subscribed` then stays open and
 *  silent forever (until aborted). Mirrors a proxy that holds the connection
 *  but stops forwarding bytes. */
function silentStreamResponse(signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(
        enc.encode(
          `event: subscribed\ndata: ${JSON.stringify({ isActive: false, activeSeq: 0 })}\n\n`,
        ),
      );
      // Never enqueue again. On abort, error the stream with an AbortError —
      // exactly what a real aborted fetch body does — so the client takes its
      // immediate-reconnect path (vs the backoff path used for clean EOF).
      signal.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("Aborted", "AbortError"));
        } catch {
          // already closed/errored
        }
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("conversation-stream watchdog", () => {
  test("force-reconnects a silently-stalled stream", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      return silentStreamResponse(init?.signal as AbortSignal);
    }) as typeof fetch;

    const conn = connectConversationStream({
      conversationId: "conv_abc",
      onEvent: () => {},
      staleThresholdMs: 30,
      watchdogTickMs: 10,
    });

    // First connect is immediate; the watchdog detects staleness (>30ms with
    // no frame) and force-reconnects. Poll so a busy event loop doesn't race.
    const reconnected = await waitFor(() => urls.length >= 2);
    conn.close();

    expect(reconnected).toBe(true);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    // Every (re)connect carries the afterSeq resume param — gapless by design.
    for (const u of urls) expect(u).toContain("afterSeq=");
  });

  test("does not reconnect after close()", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return silentStreamResponse(init?.signal as AbortSignal);
    }) as typeof fetch;

    const conn = connectConversationStream({
      conversationId: "conv_abc",
      onEvent: () => {},
      staleThresholdMs: 30,
      watchdogTickMs: 10,
    });

    // Wait for the first connect to land (poll, not a fixed sleep), then close.
    await waitFor(() => calls >= 1);
    conn.close();
    const afterClose = calls;

    // Wait well past several watchdog ticks — the count must not grow.
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(afterClose);
  });

  test("visibility-resume reconnects a stale backgrounded tab on foreground", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);
      return silentStreamResponse(init?.signal as AbortSignal);
    }) as typeof fetch;

    // Big watchdog tick so the ONLY thing that can trigger a reconnect within
    // the window is the visibility handler — isolates the behavior under test.
    const conn = connectConversationStream({
      conversationId: "conv_abc",
      onEvent: () => {},
      staleThresholdMs: 20,
      watchdogTickMs: 10_000,
    });

    // Wait for the first connect to land, then let it go stale (>20ms idle).
    await waitFor(() => urls.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    const beforeVisibility = urls.length;

    // Simulate tab returning to foreground. Construct the event from the
    // happy-dom window realm (globalThis.Event is Bun-native and would fail
    // happy-dom's cross-realm instanceof check in dispatchEvent).
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new window.Event("visibilitychange"));

    // The big watchdog tick (10s) can't fire in-window, so any reconnect here
    // is the visibility handler's doing.
    const resumed = await waitFor(() => urls.length > beforeVisibility);
    conn.close();

    expect(resumed).toBe(true);
  });
});
