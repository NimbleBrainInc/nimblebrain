import { describe, expect, test } from "bun:test";
import type { FetchLike } from "@modelcontextprotocol/client";
import {
  createResponseBudgetFetch,
  RemoteResponseTooLargeError,
} from "../../src/tools/response-budget.ts";

const encoder = new TextEncoder();

/** A body sent as `chunks`, recording how many were read and whether the reader cancelled. */
function streamed(chunks: Uint8Array[]) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulled++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

function answering(body: ReadableStream<Uint8Array>, contentType: string): FetchLike {
  return async () => new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("createResponseBudgetFetch", () => {
  test("an answer within the budget arrives unchanged", async () => {
    const { body } = streamed([encoder.encode('{"jsonrpc":'), encoder.encode('"2.0"}')]);
    const fetch = createResponseBudgetFetch(answering(body, "application/json"), 64);
    const response = await fetch("https://example.com/mcp");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ jsonrpc: "2.0" });
  });

  test("a body past the budget is refused and the connection's read is cancelled", async () => {
    const chunk = new Uint8Array(40);
    const { body, state } = streamed([chunk, chunk, chunk, chunk]);
    const fetch = createResponseBudgetFetch(answering(body, "application/json"), 64);
    const response = await fetch("https://example.com/mcp");
    await expect(response.text()).rejects.toBeInstanceOf(RemoteResponseTooLargeError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });

  test("Content-Length is not trusted", async () => {
    const { body } = streamed([new Uint8Array(100)]);
    const fetch = createResponseBudgetFetch(
      async () =>
        new Response(body, {
          headers: { "content-type": "application/json", "content-length": "1" },
        }),
      64,
    );
    await expect((await fetch("https://example.com/mcp")).arrayBuffer()).rejects.toBeInstanceOf(
      RemoteResponseTooLargeError,
    );
  });

  test("an event stream is budgeted per event, so many small events pass", async () => {
    const event = encoder.encode(`data: ${"x".repeat(40)}\n\n`);
    const crlfEvent = encoder.encode(`data: ${"y".repeat(40)}\r\n\r\n`);
    const { body } = streamed([event, crlfEvent, event, crlfEvent, event]);
    const fetch = createResponseBudgetFetch(answering(body, "text/event-stream"), 64);
    const text = await (await fetch("https://example.com/mcp")).text();
    expect(text.length).toBeGreaterThan(64 * 3);
  });

  test("one event past the budget is refused, across chunk boundaries", async () => {
    const half = encoder.encode(`data: ${"x".repeat(30)}\n`);
    const { body, state } = streamed([half, half, half, encoder.encode("\n")]);
    const fetch = createResponseBudgetFetch(answering(body, "text/event-stream"), 64);
    const response = await fetch("https://example.com/mcp");
    await expect(response.text()).rejects.toBeInstanceOf(RemoteResponseTooLargeError);
    expect(state.cancelled).toBe(true);
  });

  test("one event of CRLF lines past the budget is refused", async () => {
    const line = encoder.encode(`data: ${"x".repeat(20)}\r\n`);
    const { body } = streamed([line, line, line, line, line, encoder.encode("\r\n")]);
    const fetch = createResponseBudgetFetch(answering(body, "text/event-stream"), 64);
    const response = await fetch("https://example.com/mcp");
    await expect(response.text()).rejects.toBeInstanceOf(RemoteResponseTooLargeError);
  });

  test("an answer with no body passes through", async () => {
    const fetch = createResponseBudgetFetch(async () => new Response(null, { status: 202 }), 64);
    const response = await fetch("https://example.com/mcp");
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });
});
