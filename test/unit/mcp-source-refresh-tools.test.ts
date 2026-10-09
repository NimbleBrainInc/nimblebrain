import { describe, expect, it } from "bun:test";
import type { EventSink } from "../../src/engine/types.ts";
import {
  classifyConnectionFailure,
  McpSource,
  REMOTE_TOOL_LIST_MAX_AGE_MS,
  toolListChanged,
} from "../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { Tool } from "../../src/tools/types.ts";

/**
 * Freshness of a remote source's tool list. `cachedTools` is memoized with no
 * TTL and dropped only on stop / restart / native `tools/list_changed`. A
 * remote server redeployed at the SAME url changes its tool surface with none
 * of those signals, so an already-connected source would serve the
 * first-connect list forever — the agent literally can't call the new tools.
 * `refreshTools()` / `toolsWithMaxAge()` are the seam that closes that gap; the
 * hot dispatch path stays on the memo. These build an McpSource with a scripted
 * client (no real transport) and drive the freshness contract directly.
 */

const noopSink: EventSink = { emit: () => {} };

type RawTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };

/** A remote McpSource wired to a scripted `listTools` whose result can be
 *  swapped between calls (simulating an upstream redeploy) and whose
 *  invocation count is observable. */
function buildRemoteSource(initial: RawTool[]) {
  const source = new McpSource(
    "enrich",
    { type: "remote", url: new URL("http://mcp-enrich.example/mcp") },
    noopSink,
  );
  let current: RawTool[] = initial;
  let listCalls = 0;
  const fakeClient = {
    // A connected client: it has the server's capabilities from the handshake.
    getServerCapabilities: () => ({ tools: {} }),
    listTools: async () => {
      listCalls += 1;
      return { tools: current };
    },
    close: async () => {},
  };
  (source as unknown as { client: unknown }).client = fakeClient;
  return {
    source,
    setTools: (t: RawTool[]) => {
      current = t;
    },
    listCalls: () => listCalls,
  };
}

const getFetchedAt = (s: McpSource) =>
  (s as unknown as { toolsFetchedAt: number | null }).toolsFetchedAt;
const setFetchedAt = (s: McpSource, v: number) => {
  (s as unknown as { toolsFetchedAt: number }).toolsFetchedAt = v;
};

describe("McpSource tool-list freshness", () => {
  it("tools() serves the memo without a second tools/list round-trip", async () => {
    const { source, listCalls } = buildRemoteSource([{ name: "validate_email" }]);

    const first = await source.tools();
    const second = await source.tools();

    expect(listCalls()).toBe(1);
    expect(second).toBe(first); // same array reference — the memo
    expect(first.map((t) => t.name)).toEqual(["enrich__validate_email"]);
  });

  it("refreshTools() bypasses the memo, re-fetches, and re-stamps the fetch time", async () => {
    const { source, setTools, listCalls } = buildRemoteSource([{ name: "validate_email" }]);
    await source.tools();
    expect(listCalls()).toBe(1);

    // Force a detectably-old stamp so the re-stamp is unambiguous.
    setFetchedAt(source, 1);
    // Upstream redeploys with a broader surface at the same URL.
    setTools([
      { name: "validate_email" },
      { name: "domain_search" },
      { name: "similar_companies" },
    ]);

    const refreshed = await source.refreshTools();

    expect(listCalls()).toBe(2);
    expect(refreshed.map((t) => t.name).sort()).toEqual([
      "enrich__domain_search",
      "enrich__similar_companies",
      "enrich__validate_email",
    ]);
    expect(getFetchedAt(source)).toBeGreaterThan(1);
    // The dispatch-path memo now reflects the new surface, with no extra round-trip.
    expect(await source.tools()).toBe(refreshed);
    expect(listCalls()).toBe(2);
  });

  it("fans out toolsChanged only when the surface actually changes", async () => {
    const { source, setTools } = buildRemoteSource([{ name: "validate_email" }]);
    let fired = 0;
    source.subscribeToolsChanged(() => {
      fired += 1;
    });

    await source.tools(); // populate the memo (tools() itself does not fan out)
    await source.refreshTools(); // identical surface — must stay silent
    expect(fired).toBe(0);

    setTools([{ name: "validate_email" }, { name: "domain_search" }]);
    await source.refreshTools(); // changed surface — one fan-out
    expect(fired).toBe(1);
  });

  it("toolsWithMaxAge serves the memo while fresh and re-fetches once stale", async () => {
    const { source, setTools, listCalls } = buildRemoteSource([{ name: "validate_email" }]);
    await source.tools();
    expect(listCalls()).toBe(1);

    // Within the max-age window: no round-trip.
    await source.toolsWithMaxAge(30_000);
    expect(listCalls()).toBe(1);

    // Age the memo past the TTL, then redeploy.
    setFetchedAt(source, Date.now() - 60_000);
    setTools([{ name: "validate_email" }, { name: "domain_search" }]);

    const served = await source.toolsWithMaxAge(30_000);
    expect(listCalls()).toBe(2);
    expect(served.map((t) => t.name).sort()).toEqual([
      "enrich__domain_search",
      "enrich__validate_email",
    ]);
  });

  it("falls back to the cached tools when a stale re-fetch fails", async () => {
    const { source } = buildRemoteSource([{ name: "validate_email" }]);
    const first = await source.tools();

    // Next tools/list throws; age the memo so the gate tries to refresh.
    (source as unknown as { client: { listTools: () => Promise<unknown> } }).client.listTools =
      async () => {
        throw new Error("transport blip");
      };
    setFetchedAt(source, Date.now() - 60_000);

    const served = await source.toolsWithMaxAge(30_000);
    expect(served).toBe(first); // stale memo, not a throw or an empty list
  });

  it("scopes the age-gated refresh to remote sources", () => {
    const { source: remote } = buildRemoteSource([{ name: "validate_email" }]);
    expect(remote.isRemote()).toBe(true);

    const local = new McpSource(
      "local",
      {
        type: "inProcess",
        createServer: () => {
          throw new Error("not started in this test");
        },
      },
      noopSink,
    );
    expect(local.isRemote()).toBe(false);
  });

  it("dedupes concurrent refreshTools to a single tools/list round-trip", async () => {
    const { source, listCalls } = buildRemoteSource([{ name: "validate_email" }]);
    await source.tools();
    expect(listCalls()).toBe(1);

    const [a, b] = await Promise.all([source.refreshTools(), source.refreshTools()]);

    expect(listCalls()).toBe(2); // one shared round-trip, not two
    expect(a).toBe(b);
  });
});

/** Age a source's memo past the max age, as if its last tools/list were long ago. */
const ageMemo = (s: McpSource) => setFetchedAt(s, Date.now() - REMOTE_TOOL_LIST_MAX_AGE_MS - 1);
const setWait = (s: McpSource, ms: number) => {
  (s as unknown as { toolsRefreshWaitMs: number }).toolsRefreshWaitMs = ms;
};
const setListTools = (s: McpSource, fn: () => Promise<unknown>) => {
  (s as unknown as { client: { listTools: () => Promise<unknown> } }).client.listTools = fn;
};

describe("McpSource.tools() revalidates a stale remote memo", () => {
  it("returns a redeployed server's new parameter once the memo is past the max age", async () => {
    const { source, setTools, listCalls } = buildRemoteSource([
      { name: "memory_search", inputSchema: { type: "object", properties: { query: {} } } },
    ]);
    await source.tools();
    ageMemo(source);
    setTools([
      {
        name: "memory_search",
        inputSchema: { type: "object", properties: { query: {}, include_content: {} } },
      },
    ]);

    const served = await source.tools();

    expect(listCalls()).toBe(2);
    expect(Object.keys((served[0]?.inputSchema.properties ?? {}) as object)).toContain(
      "include_content",
    );
    // Fresh again: the next read is the memo, with no round-trip.
    expect(await source.tools()).toBe(served);
    expect(listCalls()).toBe(2);
  });

  it("serves the memo when the re-fetch outlasts the wait, and the next read sees it", async () => {
    const { source } = buildRemoteSource([{ name: "validate_email" }]);
    const first = await source.tools();
    setWait(source, 5);
    let release: (v: unknown) => void = () => {};
    let calls = 0;
    setListTools(source, () => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    ageMemo(source);

    expect(await source.tools()).toBe(first); // the wait ran out
    // A read while the re-fetch is in flight is served the memo without starting another.
    expect(await source.tools()).toBe(first);
    expect(calls).toBe(1);

    release({ tools: [{ name: "validate_email" }, { name: "domain_search" }] });
    await new Promise((r) => setTimeout(r, 0));

    const after = await source.tools();
    expect(after.map((t) => t.name).sort()).toEqual([
      "enrich__domain_search",
      "enrich__validate_email",
    ]);
    expect(calls).toBe(1);
  });

  it("serves the memo on a failed re-fetch and does not retry it before the max age", async () => {
    const { source } = buildRemoteSource([{ name: "validate_email" }]);
    const first = await source.tools();
    let calls = 0;
    setListTools(source, async () => {
      calls += 1;
      throw new Error("transport blip");
    });
    ageMemo(source);

    expect(await source.tools()).toBe(first);
    expect(await source.tools()).toBe(first);
    expect(calls).toBe(1);
  });

  it("restarts the source when the re-fetch finds its session lost", async () => {
    const { source } = buildRemoteSource([{ name: "validate_email" }]);
    await source.tools();
    const lost = new Error("Session not found");
    expect(classifyConnectionFailure(lost)).toBe("session-lost");
    let restarts = 0;
    (source as unknown as { tryRestart: () => Promise<boolean> }).tryRestart = async () => {
      restarts += 1;
      return true;
    };
    setListTools(source, async () => {
      throw lost;
    });
    ageMemo(source);

    await source.tools();

    expect(restarts).toBe(1);
  });

  it("drops a re-fetch answer that lands after stop() cleared it", async () => {
    const { source } = buildRemoteSource([{ name: "validate_email" }]);
    await source.tools();
    let release: (v: unknown) => void = () => {};
    setListTools(
      source,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = source.refreshTools();
    await source.stop();
    const internals = source as unknown as {
      cachedTools: unknown;
      toolsFetchedAt: number | null;
    };
    release({ tools: [{ name: "from_the_old_connection" }] });
    await pending;

    expect(internals.cachedTools).toBeNull();
    expect(internals.toolsFetchedAt).toBeNull();
  });

  it("keeps the memo's array when a re-fetch lists the same tools in another order", async () => {
    const { source, setTools } = buildRemoteSource([{ name: "a" }, { name: "b" }]);
    const first = await source.tools();
    let fired = 0;
    source.subscribeToolsChanged(() => {
      fired += 1;
    });
    setTools([{ name: "b" }, { name: "a" }]);

    expect(await source.refreshTools()).toBe(first);
    expect(await source.tools()).toBe(first);
    expect(fired).toBe(0);
  });

  it("never revalidates a local source", async () => {
    const local = new McpSource(
      "local",
      {
        type: "inProcess",
        createServer: () => {
          throw new Error("not started in this test");
        },
      },
      noopSink,
    );
    const memo: Tool[] = [
      { name: "local__x", description: "", inputSchema: {}, source: "mcp:local" },
    ];
    (local as unknown as { cachedTools: Tool[] }).cachedTools = memo;
    ageMemo(local);

    // No client: a re-fetch would throw "not started".
    expect(await local.tools()).toBe(memo);
  });

  it("reaches the registry's listing, which an agent run's schemas are built from", async () => {
    const { source, setTools } = buildRemoteSource([
      { name: "memory_list", inputSchema: { type: "object", properties: { namespace: {} } } },
    ]);
    const registry = new ToolRegistry();
    registry.addSource(source);
    await registry.availableTools();
    ageMemo(source);
    setTools([
      {
        name: "memory_list",
        inputSchema: { type: "object", properties: { namespace: {}, include_content: {} } },
      },
    ]);

    const listed = await registry.availableTools();
    const schema = listed.find((t) => t.name === "enrich__memory_list");

    expect(Object.keys((schema?.inputSchema.properties ?? {}) as object)).toContain(
      "include_content",
    );
  });
});

describe("toolListChanged", () => {
  const t = (name: string, description = "", inputSchema: Record<string, unknown> = {}): Tool => ({
    name,
    description,
    inputSchema,
    source: "mcp:x",
  });

  it("is false for identical sets regardless of order", () => {
    expect(toolListChanged([t("a"), t("b")], [t("b"), t("a")])).toBe(false);
  });

  it("is true when a tool is added or removed", () => {
    expect(toolListChanged([t("a")], [t("a"), t("b")])).toBe(true);
    expect(toolListChanged([t("a"), t("b")], [t("a")])).toBe(true);
  });

  it("is true when a tool's annotations, _meta or output schema change", () => {
    expect(toolListChanged([t("a")], [{ ...t("a"), annotations: { destructiveHint: true } }])).toBe(
      true,
    );
    expect(toolListChanged([t("a")], [{ ...t("a"), meta: { k: 1 } }])).toBe(true);
    expect(toolListChanged([t("a")], [{ ...t("a"), outputSchema: { type: "object" } }])).toBe(true);
  });

  it("is true when a tool's description or schema changes", () => {
    expect(toolListChanged([t("a", "old")], [t("a", "new")])).toBe(true);
    expect(toolListChanged([t("a", "", { x: 1 })], [t("a", "", { x: 2 })])).toBe(true);
  });
});
