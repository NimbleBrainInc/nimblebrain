/**
 * Briefing collector — the host side of the `ai.nimblebrain/facets` extension.
 *
 * For each running connector in a workspace whose server advertised the
 * extension, discover the resources it marks as facets and read each one's
 * count. No model is in the path and nothing about a facet is stored anywhere
 * but in memory here: the listing (per workspace and server, for
 * {@link FACET_LISTING_TTL_MS}) and the count (per workspace, server and
 * facet, see `briefing-cache.ts`).
 *
 * Every read goes over the workspace's own connection to the server, which
 * carries the workspace and never a member, so the result is the workspace's
 * and the same for every member who asks.
 */

import type { ConnectorInstance } from "../connectors/runtime/types.ts";
import { log } from "../observability/log.ts";
import type { BriefingItem } from "../platform/schemas/home.ts";
import type { McpSource } from "../tools/mcp-source.ts";
import { createFacetCache, type FacetCache, type FacetReading } from "./briefing-cache.ts";
import {
  type DiscoveredFacet,
  FACETS_EXTENSION_ID,
  facetLevelRank,
  parseFacetCount,
  selectFacets,
} from "./facets-extension.ts";

/**
 * How long a server's facet listing is reused. Discovery does not wait on
 * `notifications/resources/list_changed` (servers may not send it), so a facet
 * added or removed on a server shows within this interval. Same interval as
 * server skill discovery.
 */
export const FACET_LISTING_TTL_MS = 5 * 60_000;
/** Bound on one facet read. A read past it is `unavailable`; its siblings do not wait. */
export const FACET_READ_TIMEOUT_MS = 5_000;

export interface BriefingCollectorDeps {
  /** The workspace's own MCP source for a server, or null when it has none. */
  resolveSource: (wsId: string, serverName: string) => McpSource | null;
  now?: () => number;
  readTimeoutMs?: number;
}

export interface BriefingCollector {
  /**
   * One item per discovered facet of each running connector in `instances`,
   * ordered by level, then the shell's app order, then the server's listing order. Items whose count is
   * zero are omitted. `force` skips cached listings and counts.
   */
  collect(
    wsId: string,
    instances: readonly ConnectorInstance[],
    opts?: { force?: boolean },
  ): Promise<BriefingItem[]>;
  /** The per-facet count cache, for inspection. */
  readonly cache: FacetCache;
}

export function createBriefingCollector(deps: BriefingCollectorDeps): BriefingCollector {
  const now = deps.now ?? Date.now;
  const readTimeoutMs = deps.readTimeoutMs ?? FACET_READ_TIMEOUT_MS;
  const cache = createFacetCache(now);
  const listings = new Map<string, { facets: DiscoveredFacet[]; fetchedAt: number }>();

  /**
   * The server's facets, from the listing cache or a fresh `resources/list`.
   * A server that did not advertise the extension has none, whatever it marks.
   * A failed listing is not cached, so the next load retries it.
   */
  async function discover(
    wsId: string,
    source: McpSource,
    force: boolean,
  ): Promise<DiscoveredFacet[]> {
    if (!(FACETS_EXTENSION_ID in source.serverExtensions())) return [];
    const key = `${wsId}:${source.name}`;
    const cached = listings.get(key);
    if (cached && !force && now() - cached.fetchedAt < FACET_LISTING_TTL_MS) return cached.facets;

    const { resources, ok } = await source.listResources();
    if (!ok) {
      log.warn("[briefing] facet listing failed", { wsId, server: source.name });
      return cached?.facets ?? [];
    }
    const { facets, rejected } = selectFacets(resources);
    for (const { uri, reason } of rejected) {
      log.warn("[briefing] marked resource is not a valid facet", {
        server: source.name,
        uri,
        reason,
      });
    }
    listings.set(key, { facets, fetchedAt: now() });
    return facets;
  }

  /** Read one facet's count, or throw with the reason (logged here, never rendered). */
  async function readCount(source: McpSource, facet: DiscoveredFacet): Promise<number> {
    const signal = AbortSignal.timeout(readTimeoutMs);
    const data = await Promise.race([
      source.readResource(facet.uri, { signal }),
      new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null))),
    ]);
    const parsed = signal.aborted
      ? { ok: false as const, reason: `no answer within ${readTimeoutMs} ms` }
      : parseFacetCount(data);
    if (!parsed.ok) {
      log.warn("[briefing] facet read failed", {
        server: source.name,
        facet: facet.name,
        reason: parsed.reason,
      });
      throw new Error(parsed.reason);
    }
    return parsed.count;
  }

  async function collectConnector(
    wsId: string,
    inst: ConnectorInstance,
    force: boolean,
  ): Promise<BriefingItem[]> {
    const source = deps.resolveSource(wsId, inst.serverName);
    if (!source) return [];
    const facets = await discover(wsId, source, force);
    const app = inst.ui?.name ?? inst.connectorName;
    const route = inst.ui?.placements?.[0]?.route ?? null;
    const readings = await Promise.allSettled(
      facets.map((facet) =>
        cache.read(
          { workspaceId: wsId, serverName: inst.serverName, facetName: facet.name },
          () => readCount(source, facet),
          { force },
        ),
      ),
    );
    return facets.map((facet, i) => {
      const settled = readings[i];
      const reading: FacetReading =
        settled?.status === "fulfilled" ? settled.value : { state: "unavailable" };
      return {
        app,
        facet: facet.name,
        label: facet.title,
        count: reading.state === "ok" ? reading.count : 0,
        level: facet.level,
        route,
        state: reading.state,
      };
    });
  }

  return {
    cache,
    async collect(wsId, instances, opts) {
      const force = opts?.force ?? false;
      // The shell's app order: first placement's priority, lower first (default 100).
      const running = instances
        .filter((inst) => inst.wsId === wsId && inst.state === "running")
        .sort((a, b) => appPriority(a) - appPriority(b));
      const perConnector = await Promise.all(
        running.map((inst) => collectConnector(wsId, inst, force)),
      );
      // Most urgent first; within a level, the order above (sort is stable).
      return perConnector
        .flat()
        .filter((item) => item.state !== "ok" || item.count > 0)
        .sort((a, b) => facetLevelRank(a.level) - facetLevelRank(b.level));
    },
  };
}

function appPriority(inst: ConnectorInstance): number {
  return inst.ui?.placements?.[0]?.priority ?? 100;
}
