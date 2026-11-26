import { afterEach, describe, expect, it } from "bun:test";
import { ListResourcesResultSchema } from "@modelcontextprotocol/core";
import { Server } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import {
  HOST_RESOURCES_LIST_METHOD,
  type HostResourceContext,
  TokenBucketRateLimit,
} from "../../src/host-resources/index.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";

/**
 * A host-resources request is answered only inside one of the connector's own
 * inline tool calls, for the user that call was made for, over a real
 * Streamable HTTP connection.
 *
 * A 2025-era server→client request names no call. What ties it to one is the
 * stream it arrives on: a request on a `tools/call`'s response stream (the
 * SDK's `extra.mcpReq.send`) belongs to that call, and one on the connection's
 * standalone stream (`server.request`) belongs to no call, whoever opened the
 * connection and whatever call is in flight. These tests pin that the request
 * on the call's stream is still read in the call's async context: an SDK change
 * that moved it would fail the first test rather than silently answer for
 * someone else.
 */

const WS = "ws_00079598e311c160";
const REFUSED = -32003;

function ident(id: string): UserIdentity {
  return { id, email: `${id}@example.test`, displayName: id, orgRole: "member" } as UserIdentity;
}

function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ identity: ident(userId), workspaceId: WS }, fn);
}

type Channel = "call-stream" | "standalone";

interface Harness {
  fixture: RemoteMcpFixture;
  source: McpSource;
  /** Every owner id the resolver was asked to list for. */
  resolved: string[];
  /** The server instance of the live session. */
  server: () => Server;
  /** Resolves to the server's answer, or `ERR <code>` when the host refused. */
  unsolicited: () => Promise<string>;
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.source.stop();
  harness?.fixture.close();
  harness = null;
});

/**
 * A connector whose `list` tool sends `ai.nimblebrain/resources/list` back to
 * the host on the given channel and returns what the host answered. A call may
 * pass `gate` so two calls are in flight together before either asks.
 */
function startHarness(opts: { gate?: () => Promise<void>; onCall?: () => void } = {}): Harness {
  const servers: Server[] = [];
  const ask = (send: () => Promise<unknown>) =>
    send()
      .then((r) => JSON.stringify(r))
      .catch((e: { code?: number }) => `ERR ${e.code}`);
  const fixture = startRemoteMcpServer(() => {
    const server = new Server(
      { name: "files-reader", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    servers.push(server);
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        {
          name: "list",
          description: "Lists host resources on the requested channel.",
          inputSchema: {
            type: "object",
            properties: { channel: { type: "string" }, progress: { type: "boolean" } },
          },
        },
      ],
    }));
    server.setRequestHandler("tools/call", async (req, extra) => {
      const args = (req.params.arguments ?? {}) as { channel?: Channel; progress?: boolean };
      opts.onCall?.();
      if (args.progress) {
        const token = req.params._meta?.progressToken;
        if (token !== undefined) {
          await extra.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: 1 },
          });
        }
        return { content: [{ type: "text", text: "progressed" }] };
      }
      await opts.gate?.();
      const text = await ask(() =>
        args.channel === "standalone"
          ? server.request(
              { method: HOST_RESOURCES_LIST_METHOD, params: {} },
              ListResourcesResultSchema,
            )
          : extra.mcpReq.send(
              { method: HOST_RESOURCES_LIST_METHOD, params: {} },
              ListResourcesResultSchema,
            ),
      );
      return { content: [{ type: "text", text }] };
    });
    return server;
  });

  const resolved: string[] = [];
  const source = new McpSource(
    "files-reader",
    { type: "remote", url: new URL(fixture.url), allowInsecure: true },
    new NoopEventSink(),
    {
      workspaceId: WS,
      connectorId: "files-reader",
      hostResources: {
        read: async () => ({ contents: [] }),
        list: async (_params, ctx: HostResourceContext) => {
          resolved.push(ctx.ownerId);
          return { resources: [{ uri: `files://owned-by-${ctx.ownerId}`, name: ctx.ownerId }] };
        },
      },
      rateLimit: new TokenBucketRateLimit(),
    },
  );
  const server = () => {
    const live = servers.at(-1);
    if (!live) throw new Error("no session yet");
    return live;
  };
  return {
    fixture,
    source,
    resolved,
    server,
    unsolicited: async () => {
      // The standalone stream opens after the handshake, and a request sent
      // before it is up is never delivered; ask again until one is answered.
      for (let attempt = 0; attempt < 20; attempt++) {
        const answer = await ask(() =>
          server().request(
            { method: HOST_RESOURCES_LIST_METHOD, params: {} },
            ListResourcesResultSchema,
            {
              timeout: 250,
            },
          ),
        );
        if (!/^ERR (-32001|REQUEST_TIMEOUT)/.test(answer)) return answer;
      }
      throw new Error("the standalone stream never answered");
    },
  };
}

function textOf(result: { content: unknown[] }): string {
  const block = result.content[0] as { type: string; text?: string } | undefined;
  return block?.text ?? "";
}

describe("host-resources requests are answered for the call they arrive on", () => {
  it("answers a request on the call's own stream for the caller, not the connection's opener", async () => {
    harness = startHarness();
    const h = harness;
    await as("user-a", () => h.source.start());

    const result = await as("user-b", () => h.source.execute("list", { channel: "call-stream" }));

    expect(textOf(result)).toContain("files://owned-by-user-b");
    expect(h.resolved).toEqual(["user-b"]);
  });

  it("refuses a request on the standalone stream, even while a call is in flight", async () => {
    harness = startHarness();
    const h = harness;
    await as("user-a", () => h.source.start());

    const result = await as("user-b", () => h.source.execute("list", { channel: "standalone" }));

    expect(textOf(result)).toBe(`ERR ${REFUSED}`);
    expect(h.resolved).toEqual([]);
  });

  it("refuses an unsolicited request with no call in flight", async () => {
    harness = startHarness();
    const h = harness;
    await as("user-a", () => h.source.start());

    expect(await h.unsolicited()).toBe(`ERR ${REFUSED}`);
    expect(h.resolved).toEqual([]);
  });

  it("refuses an unsolicited request after a reconnect made during a user's call", async () => {
    harness = startHarness();
    const h = harness;
    await as("user-a", () => h.source.start());
    const first = h.server();

    // The server forgets the session; user-b's call meets it, and the source
    // reconnects inside that call's request context before retrying.
    h.fixture.roll();
    const result = await as("user-b", () => h.source.execute("list", { channel: "call-stream" }));
    expect(textOf(result)).toContain("files://owned-by-user-b");
    expect(h.server()).not.toBe(first);

    expect(await h.unsolicited()).toBe(`ERR ${REFUSED}`);
    expect(h.resolved).toEqual(["user-b"]);
  });

  it("refuses an unsolicited request after a restart started inside a call's scope", async () => {
    // The progress callback runs on the call's own stream, inside its scope, so
    // a restart begun there is a start inside a call. The connection it opens
    // must still carry no call.
    let restart: Promise<boolean> | null = null;
    harness = startHarness();
    const h = harness;
    await as("user-a", () => h.source.start());
    const first = h.server();

    await as("user-b", () =>
      h.source.execute("list", { progress: true }, undefined, {
        caller: {
          capabilities: {},
          onProgress: () => {
            restart ??= h.source.restart();
          },
        },
      }),
    );
    expect(restart).not.toBeNull();
    expect(await restart).toBe(true);
    expect(h.server()).not.toBe(first);

    expect(await h.unsolicited()).toBe(`ERR ${REFUSED}`);
    expect(h.resolved).toEqual([]);
  });

  it("answers two concurrent calls each for its own user", async () => {
    let arrived = 0;
    let release!: () => void;
    const bothIn = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness = startHarness({
      onCall: () => {
        arrived++;
        if (arrived === 2) release();
      },
      gate: () => bothIn,
    });
    const h = harness;
    await as("user-a", () => h.source.start());

    const [b, c] = await Promise.all([
      as("user-b", () => h.source.execute("list", { channel: "call-stream" })),
      as("user-c", () => h.source.execute("list", { channel: "call-stream" })),
    ]);

    expect(textOf(b)).toContain("files://owned-by-user-b");
    expect(textOf(b)).not.toContain("user-c");
    expect(textOf(c)).toContain("files://owned-by-user-c");
    expect(textOf(c)).not.toContain("user-b");
    expect([...h.resolved].sort()).toEqual(["user-b", "user-c"]);
  });

  it("refuses a request during a call made with no identity, without reaching the resolver", async () => {
    harness = startHarness();
    const h = harness;
    await as("user-a", () => h.source.start());

    const result = await h.source.execute("list", { channel: "call-stream" });

    expect(textOf(result)).toBe(`ERR ${REFUSED}`);
    expect(h.resolved).toEqual([]);
  });
});
