/**
 * The `subscriptions/listen` stream a 2026-07-28 connection receives change
 * notifications on: it is kept open for the life of the connection, it carries
 * every resource the source watches, and tearing the source down never waits
 * on it.
 *
 * The server is hand-rolled rather than the SDK's `createMcpHandler`, because
 * these tests end the stream on purpose — gracefully (the listen result) or
 * abruptly (a dropped connection) — and fail a re-listen with a 503, and the
 * SDK's handler offers no seam for either.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encoder = new TextEncoder();
const sse = (message: unknown) =>
  encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);

interface OpenListen {
  id: string;
  filter: { resourceSubscriptions?: string[] };
  stream: ReadableStreamDefaultController<Uint8Array>;
}

const listens: OpenListen[] = [];
let down = false;
let hangCancel = false;
let endAfterAck = false;

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (down) return new Response("down", { status: 503 });
    const body = (await request.json()) as {
      id?: string | number;
      method?: string;
      params?: { notifications?: { resourceSubscriptions?: string[] } };
    };
    const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    switch (body.method) {
      case "server/discover":
        return answer({
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
          serverInfo: { name: "listen-fixture", version: "1.0.0" },
        });
      case "tools/list":
        return answer({ resultType: "complete", tools: [] });
      case "subscriptions/listen": {
        const id = String(body.id);
        const filter = body.params?.notifications ?? {};
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            listens.push({ id, filter, stream: controller });
            // A one-URI filter is acknowledged late, so two racing subscribes
            // see the narrower stream acknowledged after the wider one.
            if (filter.resourceSubscriptions?.length === 1) await sleep(300);
            controller.enqueue(
              sse({
                jsonrpc: "2.0",
                method: "notifications/subscriptions/acknowledged",
                params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: id }, notifications: filter },
              }),
            );
            if (endAfterAck) controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      default:
        if (body.method === "notifications/cancelled" && hangCancel) {
          return new Promise<Response>(() => {});
        }
        if (body.id === undefined) return new Response(null, { status: 202 });
        return answer({ resultType: "complete" });
    }
  },
});

afterAll(() => server.stop(true));

beforeEach(() => {
  listens.length = 0;
  down = false;
  hangCancel = false;
  endAfterAck = false;
});

async function connect(): Promise<McpSource> {
  const source = new McpSource(
    "listen",
    { type: "remote", url: new URL(`http://localhost:${server.port}/mcp`), allowInsecure: true },
    new NoopEventSink(),
  );
  await source.start();
  await sleep(200);
  return source;
}

/** Past this, a stream that ends counts as one that was held, and is re-listened at once. */
const HELD_MS = 1_100;

/** The filter of the stream the source currently holds, as the server acknowledged it. */
function liveFilter(source: McpSource): unknown {
  return (source as unknown as { subscription: { honoredFilter: unknown } | null }).subscription
    ?.honoredFilter;
}

describe("the listen stream on a 2026-07-28 connection", () => {
  it("re-listens when the server ends the stream gracefully", async () => {
    const source = await connect();
    try {
      expect(listens).toHaveLength(1);
      await sleep(HELD_MS);
      const first = listens[0]!;
      first.stream.enqueue(
        sse({ jsonrpc: "2.0", id: first.id, result: { resultType: "complete" } }),
      );
      first.stream.close();
      await sleep(400);
      expect(listens).toHaveLength(2);
      expect(liveFilter(source)).toBeDefined();
    } finally {
      await source.stop();
    }
  });

  it("keeps retrying a re-listen that fails until the server is back", async () => {
    const source = await connect();
    try {
      await sleep(HELD_MS);
      down = true;
      listens[0]!.stream.close();
      await sleep(300);
      down = false;
      // The first retry is a second after the failed re-listen.
      await sleep(1_500);
      expect(listens).toHaveLength(2);
      expect(liveFilter(source)).toBeDefined();
    } finally {
      await source.stop();
    }
  });

  it("backs off from a server that ends every stream as soon as it opens", async () => {
    endAfterAck = true;
    const source = await connect();
    try {
      // Listens at 0 s and 1 s, then waits 2 s; without the backoff this is a
      // re-listen every round trip.
      await sleep(1_500);
      expect(listens.length).toBeLessThanOrEqual(2);
    } finally {
      await source.stop();
    }
  });

  it("carries every resource two racing subscribes asked for", async () => {
    const source = await connect();
    try {
      const results = await Promise.all([
        source.subscribeResourceUpdates("ui://a"),
        source.subscribeResourceUpdates("ui://b"),
      ]);
      expect(results).toEqual([true, true]);
      await sleep(400);
      expect(
        (liveFilter(source) as { resourceSubscriptions?: string[] }).resourceSubscriptions?.sort(),
      ).toEqual(["ui://a", "ui://b"]);
    } finally {
      await source.stop();
    }
  });

  it("stops without waiting on a server that never answers the stream's cancel", async () => {
    const source = await connect();
    hangCancel = true;
    const outcome = await Promise.race([
      source.stop().then(() => "stopped"),
      sleep(2_000).then(() => "still stopping"),
    ]);
    expect(outcome).toBe("stopped");
  });
});
