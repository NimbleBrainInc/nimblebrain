// ---------------------------------------------------------------------------
// sse.ts — frame parsing across network chunks
//
// A read can end anywhere in the byte stream, including between a frame's
// `event:` line and its `data:` line. The parser must carry the frame it is
// accumulating into the next read, or that frame is silently lost.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, expect, test } from "bun:test";
// The real module, captured in the preload: sibling suites `mock.module` this
// path with a fake `connectEvents`, and that mock is process-global.
import { realSse } from "../../test/setup";

const { connectEvents } = realSse;

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A 200 SSE response whose body arrives as exactly these chunks, then stays open. */
function chunkedResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
        // Yield so each chunk is its own read.
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a frame whose event and data lines arrive in separate reads is delivered", async () => {
  const data = { conversationId: "conv_1", title: "Plans", ownerId: "usr_1" };
  globalThis.fetch = (async () =>
    chunkedResponse([
      "event: conversation.title\n",
      `data: ${JSON.stringify(data)}\n\n`,
    ])) as unknown as typeof fetch;

  const received: Array<{ type: string; data: unknown }> = [];
  const conn = connectEvents({
    onEvent: (type, payload) => {
      received.push({ type, data: payload });
    },
  });

  const deadline = Date.now() + 2_000;
  while (received.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  conn.close();

  expect(received).toEqual([{ type: "conversation.title", data }]);
});
