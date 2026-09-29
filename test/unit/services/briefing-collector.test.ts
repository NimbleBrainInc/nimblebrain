/**
 * The host side of the `ai.nimblebrain/facets` extension: discover the
 * resources a server marks as facets, read each one's count, and cache it per
 * workspace, server and facet. Each case runs against a real in-process MCP
 * server through a real `McpSource`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ConnectorInstance } from "../../../src/connectors/runtime/types.ts";
import { runWithRequestContext } from "../../../src/runtime/request-context.ts";
import { facetCacheKey } from "../../../src/services/briefing-cache.ts";
import {
  createBriefingCollector,
  FACET_LISTING_TTL_MS,
} from "../../../src/services/briefing-collector.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";
import { facetEntry, startFacetsSource } from "../../helpers/facets-server.ts";

const WS = "ws_facets";

function instance(serverName: string, route: string | null = "@acme/app"): ConnectorInstance {
  return {
    serverName,
    connectorName: serverName,
    version: "1.0.0",
    state: "running",
    ui: {
      name: `App ${serverName}`,
      placements: route ? [{ slot: "sidebar.apps", resourceUri: "ui://x/main", route }] : [],
    },
    wsId: WS,
  } as ConnectorInstance;
}

const started: McpSource[] = [];
afterEach(async () => {
  for (const source of started.splice(0)) await source.stop();
});

async function serve(name: string, opts: Parameters<typeof startFacetsSource>[1]) {
  const fixture = await startFacetsSource(name, opts);
  started.push(fixture.source);
  return fixture;
}

function collectorFor(
  sources: McpSource[],
  extra: { now?: () => number; readTimeoutMs?: number } = {},
) {
  return createBriefingCollector({
    resolveSource: (_wsId, serverName) => sources.find((s) => s.name === serverName) ?? null,
    ...extra,
  });
}

const counts: Record<string, string> = {
  "test://facets/drafts": '{"count": 3}',
  "test://facets/blocked": '{"count": 2, "extra": "ignored"}',
  "test://facets/zero": '{"count": 0}',
};

describe("discovery", () => {
  it("takes the marked resources of a server that advertises the extension", async () => {
    const { source } = await serve("outbound", {
      resources: () => [
        facetEntry("drafts", "Drafts awaiting review"),
        facetEntry("blocked", "Tasks blocked"),
        { uri: "test://plain/readme", name: "readme", mimeType: "application/json" },
      ],
      read: (uri) => counts[uri] ?? "{}",
    });

    const items = await collectorFor([source]).collect(WS, [instance("outbound")]);

    expect(items).toEqual([
      {
        app: "App outbound",
        facet: "drafts",
        label: "Drafts awaiting review",
        count: 3,
        level: "action",
        route: "@acme/app",
        state: "ok",
      },
      {
        app: "App outbound",
        facet: "blocked",
        label: "Tasks blocked",
        count: 2,
        level: "action",
        route: "@acme/app",
        state: "ok",
      },
    ]);
  });

  it("reads nothing from a server that marks resources without advertising", async () => {
    const { source, reads, lists } = await serve("quiet", {
      advertises: false,
      resources: () => [facetEntry("drafts", "Drafts awaiting review")],
      read: (uri) => counts[uri] ?? "{}",
    });

    expect(await collectorFor([source]).collect(WS, [instance("quiet")])).toEqual([]);
    expect(lists()).toBe(0);
    expect(reads).toEqual([]);
  });

  it("drops a marked entry without a title or with another MIME type", async () => {
    const { source, reads } = await serve("sloppy", {
      resources: () => [
        { ...facetEntry("drafts", "Drafts awaiting review"), title: undefined },
        { ...facetEntry("blocked", "Tasks blocked"), mimeType: "text/plain" },
      ],
      read: (uri) => counts[uri] ?? "{}",
    });

    expect(await collectorFor([source]).collect(WS, [instance("sloppy")])).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("shows a facet added on the server once the listing cache expires", async () => {
    const listed = [facetEntry("drafts", "Drafts awaiting review")];
    const { source } = await serve("growing", {
      resources: () => listed,
      read: (uri) => counts[uri] ?? "{}",
    });
    let clock = 1_000_000;
    const collector = collectorFor([source], { now: () => clock });
    const facets = async () =>
      (await collector.collect(WS, [instance("growing")])).map((item) => item.facet);

    expect(await facets()).toEqual(["drafts"]);
    listed.push(facetEntry("blocked", "Tasks blocked"));
    clock += FACET_LISTING_TTL_MS - 1;
    expect(await facets()).toEqual(["drafts"]);
    clock += 2;
    expect(await facets()).toEqual(["drafts", "blocked"]);
  });
});

describe("reads", () => {
  it("orders apps as the shell does, by first placement priority", async () => {
    const low = await serve("second", {
      resources: () => [facetEntry("drafts", "Drafts")],
      read: (uri) => counts[uri] ?? "{}",
    });
    const high = await serve("first", {
      resources: () => [facetEntry("blocked", "Blocked")],
      read: (uri) => counts[uri] ?? "{}",
    });
    const withPriority = (name: string, priority: number): ConnectorInstance => {
      const inst = instance(name);
      return {
        ...inst,
        ui: { ...inst.ui!, placements: [{ ...inst.ui!.placements![0]!, priority }] },
      };
    };

    const items = await collectorFor([low.source, high.source]).collect(WS, [
      withPriority("second", 200),
      withPriority("first", 10),
    ]);

    expect(items.map((i) => i.facet)).toEqual(["blocked", "drafts"]);
  });

  it("orders by declared level before app order, reading an unknown level as action", async () => {
    const first = await serve("first", {
      resources: () => [
        facetEntry("drafts", "Drafts", "info"),
        facetEntry("blocked", "Blocked", "action"),
      ],
      read: (uri) => counts[uri] ?? "{}",
    });
    const second = await serve("second", {
      resources: () => [
        facetEntry("drafts", "Stopped", "blocked"),
        facetEntry("x", "Odd", "urgent"),
      ],
      read: () => '{"count": 1}',
    });

    const items = await collectorFor([first.source, second.source]).collect(WS, [
      instance("first"),
      instance("second"),
    ]);

    expect(items.map((i) => [i.label, i.level])).toEqual([
      ["Stopped", "blocked"],
      ["Blocked", "action"],
      ["Odd", "action"],
      ["Drafts", "info"],
    ]);
  });

  it("omits a zero count and renders no action for an app without a route", async () => {
    const { source } = await serve("mixed", {
      resources: () => [facetEntry("zero", "Nothing"), facetEntry("drafts", "Drafts")],
      read: (uri) => counts[uri] ?? "{}",
    });

    const items = await collectorFor([source]).collect(WS, [instance("mixed", null)]);

    expect(items.map((i) => [i.facet, i.count, i.route])).toEqual([["drafts", 3, null]]);
  });

  it.each([
    ["a fractional count", '{"count": 2.5}'],
    ["a negative count", '{"count": -1}'],
    ["a string count", '{"count": "3"}'],
    ["no count", '{"total": 3}'],
    ["a JSON array", "[3]"],
    ["text that is not JSON", "three"],
  ])("reads %s as unavailable", async (_label, text) => {
    const { source } = await serve("bad", {
      resources: () => [facetEntry("drafts", "Drafts awaiting review")],
      read: () => text,
    });

    const items = await collectorFor([source]).collect(WS, [instance("bad")]);

    expect(items).toEqual([
      {
        app: "App bad",
        facet: "drafts",
        label: "Drafts awaiting review",
        count: 0,
        level: "action",
        route: "@acme/app",
        state: "unavailable",
      },
    ]);
  });

  it("marks a read past its timeout unavailable without delaying its sibling", async () => {
    const { source } = await serve("slow", {
      resources: () => [facetEntry("stuck", "Stuck"), facetEntry("drafts", "Drafts")],
      read: async (uri) => {
        if (uri.endsWith("/stuck")) await Bun.sleep(2_000);
        return counts[uri] ?? '{"count": 1}';
      },
    });

    const began = performance.now();
    const items = await collectorFor([source], { readTimeoutMs: 100 }).collect(WS, [
      instance("slow"),
    ]);
    const elapsed = performance.now() - began;

    expect(items.map((i) => [i.facet, i.state])).toEqual([
      ["stuck", "unavailable"],
      ["drafts", "ok"],
    ]);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("skips a connector that is not running", async () => {
    const { source, reads } = await serve("down", {
      resources: () => [facetEntry("drafts", "Drafts")],
      read: (uri) => counts[uri] ?? "{}",
    });

    const items = await collectorFor([source]).collect(WS, [
      { ...instance("down"), state: "reauth_required" },
    ]);

    expect(items).toEqual([]);
    expect(reads).toEqual([]);
  });
});

describe("the cache", () => {
  it("keys and stores nothing about the member who asked", async () => {
    const { source, reads } = await serve("shared", {
      resources: () => [facetEntry("drafts", "Drafts awaiting review")],
      read: (uri) => counts[uri] ?? "{}",
    });
    const collector = collectorFor([source]);
    const asMember = (id: string) =>
      runWithRequestContext(
        { identity: { id, email: `${id}@example.com`, displayName: id } as never, workspaceId: WS },
        () => collector.collect(WS, [instance("shared")]),
      );

    const a = await asMember("user_alice");
    const b = await asMember("user_bob");

    expect(b).toEqual(a);
    expect(reads).toHaveLength(1);
    const entries = [...collector.cache.entries()];
    expect(entries.map(([key]) => key)).toEqual([
      facetCacheKey({ workspaceId: WS, serverName: "shared", facetName: "drafts" }),
    ]);
    expect(Object.keys(entries[0]![1]).sort()).toEqual(["at", "count"]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("bob");
  });

  it("re-reads on force", async () => {
    const { source, reads } = await serve("forced", {
      resources: () => [facetEntry("drafts", "Drafts")],
      read: (uri) => counts[uri] ?? "{}",
    });
    const collector = collectorFor([source]);

    await collector.collect(WS, [instance("forced")]);
    await collector.collect(WS, [instance("forced")]);
    await collector.collect(WS, [instance("forced")], { force: true });

    expect(reads).toHaveLength(2);
  });
});
