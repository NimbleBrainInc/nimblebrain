/**
 * The unattended `_meta` key, on both channels `McpSource` owns.
 *
 * OUT: a dispatch made from stored configuration stamps
 * `ai.nimblebrain/unattended` on the `tools/call` params, carrying the caller's
 * own opaque reason, so a server that cares can tell it from a chat turn. It
 * comes from the ambient request context — `ToolSource.execute` takes the
 * tool's input and nothing else, and this is metadata about the CALLER.
 *
 * IN: the same key is host-owned, so it is stripped off any result arriving
 * from a bundle. A server echoing it back would be asserting a provenance only
 * the host is in a position to know, and the audit line — not the result — is
 * where that provenance lives.
 */

import { describe, expect, it } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EventSink } from "../../src/engine/types.ts";
import { UNATTENDED_META_KEY } from "../../src/engine/types.ts";
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
function buildSource(resultMeta?: Record<string, unknown>): Harness {
  const source = new McpSource(
    "crm",
    { type: "stdio", spawn: { command: "echo", args: [], env: {} } },
    noopSink,
  );

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
      source: "mcpb:crm",
    },
  ];

  return { source, lastParams: () => captured };
}

describe("McpSource — the unattended marker on the way out", () => {
  // Naive failure: thread the reason through `execute`'s arguments, which would
  // put host metadata in the tool's own input where a schema validator will
  // reject it — or drop it entirely, leaving a server unable to tell a
  // configuration-fired call from a chat turn.
  it("stamps the caller's reason on the call params inside an unattended dispatch", async () => {
    const { source, lastParams } = buildSource();

    await runWithRequestContext(
      { identity: null, unattended: true, unattendedReason: "route:rt_abc" },
      () => source.execute("search", { q: "acme" }),
    );

    expect(lastParams()?._meta).toEqual({ [UNATTENDED_META_KEY]: "route:rt_abc" });
    // The tool's own input is untouched — the marker never leaks into `arguments`.
    expect(lastParams()?.arguments).toEqual({ q: "acme" });
  });

  it("sends no _meta at all for an ordinary call", async () => {
    const { source, lastParams } = buildSource();

    await source.execute("search", { q: "acme" });

    expect(lastParams()).not.toHaveProperty("_meta");
  });
});

describe("McpSource — the unattended marker on the way in", () => {
  // The key asserts something about the caller. A bundle setting it on its own
  // result is claiming a provenance it cannot have, so it never reaches the
  // engine — the same treatment `ai.nimblebrain/infra-error` gets, and for the
  // same reason.
  it("strips a bundle-supplied unattended marker from the result", async () => {
    const { source } = buildSource({ [UNATTENDED_META_KEY]: "route:forged", keep: "mine" });

    const result = await source.execute("search", {});

    expect(result._meta).toEqual({ keep: "mine" });
  });

  it("strips it from a result returned during a real unattended dispatch too", async () => {
    const { source } = buildSource({ [UNATTENDED_META_KEY]: "route:echoed" });

    const result = await runWithRequestContext(
      { identity: null, unattended: true, unattendedReason: "route:rt_abc" },
      () => source.execute("search", {}),
    );

    expect(result._meta).toEqual({});
  });
});
