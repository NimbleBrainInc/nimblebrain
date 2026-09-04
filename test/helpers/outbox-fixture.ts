/**
 * A fixture MCP server that serves a notifications outbox.
 *
 * The poller's whole contract is with a server it does not control, so the only
 * honest way to test it is against a real MCP server on a real transport. This
 * is one: an in-process `Server` over `InMemoryTransport`, answering
 * `resources/read` on `fixture://outbox` with the poll-result shape the
 * notifications design defines, and — unlike every platform built-in — actually
 * serving `resources/subscribe`, so the update hint has something to exercise.
 *
 * Two properties are deliberate:
 *
 *   - **The cursor is opaque.** It is an encoded token, not the row index it
 *     wraps, so a runtime that tried to derive or compare positions from it
 *     would have to decode it, and the tests would catch that. The real outbox
 *     library packs an epoch and a snapshot horizon in there; nothing about the
 *     runtime's behaviour may depend on knowing that.
 *   - **`fixture://` is the server's own scheme.** An outbox declared under one
 *     of the schemes the runtime already resolves (`ui`, `skill`, …) is refused
 *     at parse, so a fixture using one would be testing the wrong thing.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

/** The outbox URI this fixture declares. */
export const FIXTURE_OUTBOX_URI = "fixture://outbox";

/** The query the runtime expanded the resource template into, as observed. */
export interface ObservedRead {
  cursor?: string;
  maxEvents?: number;
  maxAgeMs?: number;
}

export interface OutboxFixtureOptions {
  name?: string;
  /** Advertise `resources.subscribe` and serve `resources/subscribe`. */
  supportsSubscribe?: boolean;
  /** Answer with this `nextPollMs` on every read. */
  nextPollMs?: number;
}

export interface OutboxFixture {
  source: McpSource;
  /** Every read the runtime issued, oldest first. */
  reads: ObservedRead[];
  /** URIs the runtime subscribed to. */
  subscriptions: string[];
  /** Append events to the outbox, oldest first. */
  emit(...events: Record<string, unknown>[]): void;
  /** Answer the next `count` reads with a body that is not a poll result. */
  answerMalformed(count: number): void;
  /** Report a gap on every subsequent read. */
  setTruncated(truncated: boolean): void;
  /** Recommend a cadence on every subsequent read. */
  setNextPollMs(nextPollMs: number | undefined): void;
  /** Push `notifications/resources/updated` for the outbox. */
  pushUpdate(): void;
  stop(): Promise<void>;
}

/** Encode a delivered-count as a token whose shape says nothing about it. */
function encodeCursor(delivered: number, epoch: string): string {
  return Buffer.from(JSON.stringify({ e: epoch, d: delivered }), "utf8").toString("base64url");
}

/** Decode one, or `null` when it is not this fixture's. */
function decodeCursor(cursor: string, epoch: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      e?: string;
      d?: number;
    };
    if (parsed.e !== epoch || typeof parsed.d !== "number") return null;
    return parsed.d;
  } catch {
    return null;
  }
}

/**
 * Build an outbox fixture, started and ready to read.
 *
 * The caller owns teardown: `stop()` closes the source, which closes the server
 * and its transport pair. A test that leaks one leaves a live MCP session in
 * the process.
 */
export async function makeOutboxFixture(
  options: OutboxFixtureOptions = {},
): Promise<OutboxFixture> {
  const name = options.name ?? "fixture-outbox";
  const epoch = `ep_${Math.random().toString(36).slice(2, 10)}`;
  const events: Record<string, unknown>[] = [];
  const reads: ObservedRead[] = [];
  const subscriptions: string[] = [];
  let malformedReads = 0;
  let truncated = false;
  let nextPollMs = options.nextPollMs;
  let live: Server | null = null;

  const source = new McpSource(
    name,
    {
      type: "inProcess",
      createServer: async () => {
        const server = new Server(
          { name, version: "1.0.0" },
          {
            capabilities: {
              tools: {},
              resources: options.supportsSubscribe
                ? { listChanged: true, subscribe: true }
                : { listChanged: true },
            },
          },
        );

        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
          resourceTemplates: [
            {
              uriTemplate: `${FIXTURE_OUTBOX_URI}{?cursor,maxEvents,maxAgeMs}`,
              name: "outbox",
              mimeType: "application/json",
            },
          ],
        }));

        if (options.supportsSubscribe) {
          server.setRequestHandler(SubscribeRequestSchema, async (request) => {
            subscriptions.push(request.params.uri);
            return {};
          });
          server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
        }

        server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
          const { uri } = request.params;
          const [base, query = ""] = uri.split("?", 2);
          if (base !== FIXTURE_OUTBOX_URI) {
            throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`, { uri });
          }
          const params = new URLSearchParams(query);
          const rawCursor = params.get("cursor") ?? undefined;
          const maxEvents = Number(params.get("maxEvents") ?? "0");
          reads.push({
            ...(rawCursor !== undefined ? { cursor: rawCursor } : {}),
            ...(Number.isFinite(maxEvents) && maxEvents > 0 ? { maxEvents } : {}),
            ...(params.has("maxAgeMs") ? { maxAgeMs: Number(params.get("maxAgeMs")) } : {}),
          });

          if (malformedReads > 0) {
            malformedReads--;
            return {
              contents: [
                { uri, mimeType: "application/json", text: JSON.stringify({ nope: true }) },
              ],
            };
          }

          // No cursor is the bootstrap: establish a position and return nothing.
          const delivered =
            rawCursor === undefined ? events.length : (decodeCursor(rawCursor, epoch) ?? 0);
          const page = events.slice(delivered, delivered + Math.max(maxEvents, 1));
          const nextDelivered = delivered + page.length;
          const body = {
            events: page,
            cursor: encodeCursor(nextDelivered, epoch),
            truncated,
            hasMore: nextDelivered < events.length,
            ...(nextPollMs !== undefined ? { nextPollMs } : {}),
          };
          return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body) }],
          };
        });

        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        live = server;
        return { server, clientTransport };
      },
    },
    new NoopEventSink(),
  );

  await source.start();

  return {
    source,
    reads,
    subscriptions,
    emit(...next) {
      events.push(...next);
    },
    answerMalformed(count) {
      malformedReads = count;
    },
    setTruncated(value) {
      truncated = value;
    },
    setNextPollMs(value) {
      nextPollMs = value;
    },
    pushUpdate() {
      void live?.notification({
        method: "notifications/resources/updated",
        params: { uri: FIXTURE_OUTBOX_URI },
      });
    },
    stop: () => source.stop(),
  };
}

/** One well-formed `EventOccurrence`, with the presentation block filled in. */
export function fixtureEvent(
  eventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId,
    name: "domain.active",
    timestamp: "2026-09-01T18:42:10Z",
    data: { domain: `${eventId}.example` },
    _meta: {
      "ai.nimblebrain/notification": {
        subject: `${eventId}.example`,
        level: "attention",
        title: `${eventId}.example is active`,
      },
    },
    ...overrides,
  };
}
