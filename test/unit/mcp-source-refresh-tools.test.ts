import { describe, expect, it } from "bun:test";
import type { EventSink } from "../../src/engine/types.ts";
import { McpSource, toolListChanged } from "../../src/tools/mcp-source.ts";
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

const getFetchedAt = (s: McpSource) => (s as unknown as { toolsFetchedAt: number | null }).toolsFetchedAt;
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
    setTools([{ name: "validate_email" }, { name: "domain_search" }, { name: "similar_companies" }]);

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

    const stdio = new McpSource(
      "local",
      { type: "stdio", spawn: { command: "echo", args: [], env: {} } },
      noopSink,
    );
    expect(stdio.isRemote()).toBe(false);
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

describe("toolListChanged", () => {
  const t = (name: string, description = "", inputSchema: Record<string, unknown> = {}): Tool => ({
    name,
    description,
    inputSchema,
    source: "mcpb:x",
  });

  it("is false for identical sets regardless of order", () => {
    expect(toolListChanged([t("a"), t("b")], [t("b"), t("a")])).toBe(false);
  });

  it("is true when a tool is added or removed", () => {
    expect(toolListChanged([t("a")], [t("a"), t("b")])).toBe(true);
    expect(toolListChanged([t("a"), t("b")], [t("a")])).toBe(true);
  });

  it("is true when a tool's description or schema changes", () => {
    expect(toolListChanged([t("a", "old")], [t("a", "new")])).toBe(true);
    expect(toolListChanged([t("a", "", { x: 1 })], [t("a", "", { x: 2 })])).toBe(true);
  });
});
