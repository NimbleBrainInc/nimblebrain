import { describe, expect, it } from "bun:test";
import type { FetchLike, JSONRPCMessage } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createInBandAuthRejectionFetch } from "../../src/tools/in-band-auth-rejection-fetch.ts";

/**
 * The fetch that reads a declared in-band token rejection of a `tools/call` as
 * a 401. It waits for the answer's first message only, so a server's own
 * request on an SSE answer reaches the client while the tool waits for the
 * reply. The full refresh-and-retry path runs in
 * `test/integration/mcp-source-in-band-auth.test.ts`.
 */

const PHRASE = "authentication token has expired or is invalid";
const REJECTION =
  "Query failed: Your authentication token has expired or is invalid. Please refresh your token and retry.";
const encoder = new TextEncoder();
const event = (m: unknown) => `event: message\ndata: ${JSON.stringify(m)}\n\n`;
const rejected = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: REJECTION }], isError: true },
});
const toolCall = (id: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "q", arguments: {} },
  });

/** An SSE answer that delivers `chunks` as separate reads. */
function sse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const wrap = (answer: () => Response) =>
  createInBandAuthRejectionFetch((async () => answer()) as FetchLike, [PHRASE]);

describe("createInBandAuthRejectionFetch", () => {
  it("test_sse_server_request_reaches_the_client_before_the_answer_ends", async () => {
    // The server asks the client for a host resource on the tools/call stream
    // and answers the call only once the client replies.
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const inner: FetchLike = async (_url, init) => {
      const m = JSON.parse(String(init?.body));
      if (m.method === "tools/call") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              stream = c;
              c.enqueue(
                encoder.encode(
                  event({
                    jsonrpc: "2.0",
                    id: 99,
                    method: "ai.nimblebrain/resources/read",
                    params: { uri: "files://x" },
                  }),
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (m.id === 99) {
        stream.enqueue(
          encoder.encode(
            event({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }),
          ),
        );
        stream.close();
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected ${init?.body}`);
    };
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.com/mcp"), {
      fetch: createInBandAuthRejectionFetch(inner, [PHRASE]),
    });
    const answered = Promise.withResolvers<JSONRPCMessage>();
    transport.onmessage = (m) => {
      if (!("method" in m)) answered.resolve(m);
      else if ("id" in m && m.id !== undefined) {
        void transport.send({ jsonrpc: "2.0", id: m.id, result: {} });
      }
    };
    await transport.start();
    // Not awaited: a fetch that holds the stream back never resolves the send.
    const sent = transport.send(JSON.parse(toolCall(1)));

    const result = await Promise.race([
      answered.promise,
      new Promise((r) => setTimeout(() => r("stalled"), 1_000)),
    ]);

    expect(result).toMatchObject({ id: 1, result: { content: [{ text: "ok" }] } });
    await sent;
    await transport.close();
  });

  it("test_sse_first_message_rejection_becomes_401", async () => {
    const res = await wrap(() => sse([event(rejected(1))]))("https://x/mcp", {
      method: "POST",
      body: toolCall(1),
    });
    expect(res.status).toBe(401);
  });

  it("test_sse_rejection_after_a_priming_event_split_across_reads_becomes_401", async () => {
    const body = `id: e0\n\n${event(rejected(1))}`;
    const mid = body.length - 20;
    const res = await wrap(() => sse([body.slice(0, mid), body.slice(mid)]))("https://x/mcp", {
      method: "POST",
      body: toolCall(1),
    });
    expect(res.status).toBe(401);
  });

  it("test_sse_answer_that_is_not_a_rejection_streams_through_whole", async () => {
    const chunks = [
      event({ jsonrpc: "2.0", method: "notifications/progress", params: {} }),
      event({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } }),
    ];
    const res = await wrap(() => sse(chunks))("https://x/mcp", {
      method: "POST",
      body: toolCall(1),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(chunks.join(""));
  });

  it("test_json_rejection_becomes_401", async () => {
    const res = await wrap(() => Response.json(rejected(1)))("https://x/mcp", {
      method: "POST",
      body: toolCall(1),
    });
    expect(res.status).toBe(401);
  });

  it("test_rejection_answering_another_method_passes_through", async () => {
    const answer = Response.json(rejected(1));
    const res = await wrap(() => answer)("https://x/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} }),
    });
    expect(res).toBe(answer);
  });
});
