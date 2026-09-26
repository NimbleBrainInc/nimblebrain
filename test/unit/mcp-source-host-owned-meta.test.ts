/**
 * The `_meta` boundary `McpSource` owns, in both directions.
 *
 * OUT: a call made with no one attending (an unattended dispatch) carries no
 * `_meta` the host added. A server is not told which configuration fired the
 * call, or that no one is watching: that would tell a hostile server when it
 * is safe to misbehave. The audit line is where the provenance lives.
 *
 * IN: a key the engine acts on is host-owned, so a connector's copy is stripped
 * while the platform's own in-process sources carry theirs through.
 */

import { describe, expect, it } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EventSink } from "../../src/engine/types.ts";
import { NON_ADVANCING_META_KEY } from "../../src/engine/types.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

const noopSink: EventSink = { emit: () => {} };

interface Harness {
  source: McpSource;
  /** The full `tools/call` params the client was handed. */
  lastParams: () => Record<string, unknown> | undefined;
}

/**
 * An `McpSource` with a scripted inline client. `cachedTools` is pre-seeded so
 * `execute()` resolves without a live `start()`; no `execution` field keeps it
 * on the inline (non-task) dispatch path.
 */
function buildSource(
  resultMeta?: Record<string, unknown>,
  mode: ConstructorParameters<typeof McpSource>[1] = {
    type: "remote",
    url: new URL("http://localhost:0/mcp"),
  },
): Harness {
  const source = new McpSource("crm", mode, noopSink);

  let captured: Record<string, unknown> | undefined;
  const fakeClient = {
    callTool: async (req: Record<string, unknown>) => {
      captured = req;
      const result: CallToolResult = {
        content: [{ type: "text", text: "ok" }],
        isError: false,
        ...(resultMeta ? { _meta: resultMeta } : {}),
      };
      return result;
    },
    close: async () => {},
  };

  const internals = source as unknown as { client: unknown; cachedTools: unknown };
  internals.client = fakeClient;
  internals.cachedTools = [
    {
      name: "crm__search",
      description: "",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      source: "mcp:crm",
    },
  ];

  return { source, lastParams: () => captured };
}

describe("McpSource — nothing about the caller on the way out", () => {
  it("sends no _meta on a call made inside an unattended dispatch", async () => {
    const { source, lastParams } = buildSource();

    await runWithRequestContext({ identity: null, unattended: true }, () =>
      source.execute("search", { q: "acme" }),
    );

    expect(lastParams()).not.toHaveProperty("_meta");
    expect(lastParams()?.arguments).toEqual({ q: "acme" });
  });

  it("sends no _meta for an ordinary call", async () => {
    const { source, lastParams } = buildSource();

    await source.execute("search", { q: "acme" });

    expect(lastParams()).not.toHaveProperty("_meta");
  });
});

describe("McpSource — the non-advancing marker is host-owned", () => {
  // Accepting it could only tighten the guard on the connector that sent it, but
  // no connector sets it, and accepting it would make the supervisor's internals
  // a contract with every server.
  it("strips a connector-supplied marker and forwards the rest of _meta", async () => {
    const { source } = buildSource({ [NON_ADVANCING_META_KEY]: true, keep: "mine" });

    const result = await source.execute("search", {});

    expect(result._meta).toEqual({ keep: "mine" });
  });

  // The platform's own `nb__search` is an in-process MCP server, so its marker
  // crosses this same boundary and must survive it.
  it("carries the marker through from an in-process source", async () => {
    const { source } = buildSource(
      { [NON_ADVANCING_META_KEY]: true },
      {
        type: "inProcess",
        createServer: async () => {
          throw new Error("unused");
        },
      },
    );

    const result = await source.execute("search", {});

    expect(result._meta).toEqual({ [NON_ADVANCING_META_KEY]: true });
  });
});
