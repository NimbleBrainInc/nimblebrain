import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { AcpConnectionTarget } from "../../../src/execution/acp/driver.ts";
import { createHttpConnection } from "../../../src/execution/acp/http-connection.ts";
import type { ResolvedRun } from "../../../src/execution/types.ts";

// The worker connection marks itself lost when the worker no longer holds it,
// and only then: a scripted fetch stands in for the worker, so each way a
// connection ends is played exactly.

const CONNECTION_ID = "conn-1";
const RUN: ResolvedRun = {
  runId: "run_lost",
  conversationId: null,
  system: "",
  messages: [],
  tools: [],
  config: { model: "test:echo", maxIterations: 1, maxInputTokens: 1000, maxOutputTokens: 100 },
};

/** How the scripted worker answers a request on the established connection. */
type Answer = (method: string) => Promise<Response> | Response;

interface Worker {
  fetch: typeof fetch;
  /** End the connection's server stream, as a worker that stops does. */
  endStream(): void;
  methods: string[];
}

/**
 * A worker that accepts `initialize` with `initStatus`, holds the connection's
 * server stream open until `endStream`, and answers every other request on the
 * connection with `answer`.
 */
function scriptedWorker(answer: Answer, initStatus = 200): Worker {
  let end = () => {};
  const methods: string[] = [];
  const handler = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (!headers.has("acp-connection-id")) {
      if (initStatus !== 200) return new Response("draining", { status: initStatus });
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Response.json(
        { jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } },
        { headers: { "acp-connection-id": CONNECTION_ID } },
      );
    }
    methods.push(method);
    if (method === "GET") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          end = () => controller.close();
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return answer(method);
  };
  return { fetch: handler as typeof fetch, endStream: () => end(), methods };
}

/** Open the connection and complete `initialize` on it. */
async function connect(worker: Worker): Promise<{
  target: AcpConnectionTarget;
  writer: WritableStreamDefaultWriter<acp.AnyMessage>;
}> {
  const target = await createHttpConnection({
    url: "http://worker.test/acp",
    credential: null,
    fetch: worker.fetch,
  }).open(RUN);
  const stream = target.target as acp.Stream;
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  await writer.write({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await reader.read();
  reader.releaseLock();
  return { target, writer };
}

const request = (id: number): acp.AnyMessage => ({
  jsonrpc: "2.0",
  id,
  method: "session/new",
  params: { cwd: "/", mcpServers: [] },
});

describe("a worker connection", () => {
  test("is lost when the worker answers that it does not know the connection", async () => {
    const worker = scriptedWorker(() => new Response("Unknown Acp-Connection-Id", { status: 404 }));
    const { target, writer } = await connect(worker);
    expect(target.lost?.()).toBe(false);
    await writer.write(request(1)).catch(() => {});
    expect(target.lost?.()).toBe(true);
  });

  test("is lost when a request on it is refused or reset", async () => {
    const worker = scriptedWorker(() => Promise.reject(new TypeError("socket closed")));
    const { target, writer } = await connect(worker);
    await writer.write(request(1)).catch(() => {});
    expect(target.lost?.()).toBe(true);
  });

  test("is lost when its server stream ends", async () => {
    const worker = scriptedWorker(() => new Response(null, { status: 202 }));
    const { target } = await connect(worker);
    await Bun.sleep(5);
    worker.endStream();
    await Bun.sleep(5);
    expect(target.lost?.()).toBe(true);
  });

  test("is not lost when the worker refuses a new connection", async () => {
    const worker = scriptedWorker(() => new Response(null, { status: 202 }), 503);
    const target = await createHttpConnection({
      url: "http://worker.test/acp",
      credential: null,
      fetch: worker.fetch,
    }).open(RUN);
    const writer = (target.target as acp.Stream).writable.getWriter();
    await writer.write({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }).catch(() => {});
    expect(target.lost?.()).toBe(false);
  });

  test("is not lost when the runtime closes it, even if the worker is gone by then", async () => {
    const worker = scriptedWorker(() => new Response("Unknown Acp-Connection-Id", { status: 404 }));
    const { target, writer } = await connect(worker);
    // The DELETE's 404 fails the close; the connection is still not lost.
    await writer.close().catch(() => {});
    expect(worker.methods).toContain("DELETE");
    expect(target.lost?.()).toBe(false);
  });

  test("is not lost by a request error the worker answers on a live connection", async () => {
    const worker = scriptedWorker(() => new Response("bad request", { status: 400 }));
    const { target, writer } = await connect(worker);
    await writer.write(request(1));
    expect(target.lost?.()).toBe(false);
  });
});
