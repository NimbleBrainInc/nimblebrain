import { describe, expect, it } from "bun:test";
import {
  registerLiveness,
  unregisterLiveness,
  wrapFetchWithLiveness,
} from "../../src/model/fetch-liveness.ts";

function streamingResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe("wrapFetchWithLiveness", () => {
  it("pokes the registered callback on every body chunk and forwards bytes unchanged", async () => {
    const controller = new AbortController();
    let pokes = 0;
    registerLiveness(controller.signal, () => {
      pokes++;
    });
    // A ping frame followed by two data frames — the ping is exactly the
    // keep-alive the decoder would swallow, and it must still count as liveness.
    const base = async () =>
      streamingResponse(["event: ping\n\n", "data: a\n\n", "data: b\n\n"]);

    const res = await wrapFetchWithLiveness(base)("https://example.test", {
      signal: controller.signal,
    });
    const text = await drain(res);

    expect(text).toBe("event: ping\n\ndata: a\n\ndata: b\n\n");
    expect(pokes).toBe(3);
    unregisterLiveness(controller.signal);
  });

  it("passes the response through untouched when no poke is registered", async () => {
    const controller = new AbortController();
    const base = async () => streamingResponse(["x"]);
    const res = await wrapFetchWithLiveness(base)("https://example.test", {
      signal: controller.signal,
    });
    expect(await drain(res)).toBe("x");
  });

  it("stops poking once the signal is unregistered", async () => {
    const controller = new AbortController();
    let pokes = 0;
    registerLiveness(controller.signal, () => {
      pokes++;
    });
    unregisterLiveness(controller.signal);
    const base = async () => streamingResponse(["a", "b"]);
    const res = await wrapFetchWithLiveness(base)("https://example.test", {
      signal: controller.signal,
    });
    await drain(res);
    expect(pokes).toBe(0);
  });

  it("passes a bodyless response through without error", async () => {
    const controller = new AbortController();
    registerLiveness(controller.signal, () => {});
    const base = async () => new Response(null, { status: 204 });
    const res = await wrapFetchWithLiveness(base)("https://example.test", {
      signal: controller.signal,
    });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    unregisterLiveness(controller.signal);
  });
});
