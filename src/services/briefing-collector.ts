/**
 * BriefingCollector — reads briefing facet declarations from installed
 * connectors and resolves them into structured data for the BriefingGenerator.
 *
 * Resolution order per facet:
 *   1. resource → readResource() on the app's MCP server
 *   2. tool     → callTool() via the tool registry
 *
 * Only one of resource/tool per facet. Falls back to description string. Both
 * go over MCP: a facet is answered by the server that declared it, never by
 * the runtime reading that server's files.
 */

import type { BriefingBlock, BriefingFacet, BundleInstance } from "../bundles/types.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolSource } from "../tools/types.ts";

/** Result of resolving a single facet. */
export interface FacetResult {
  /** The original facet declaration. */
  facet: BriefingFacet;
  /** App display name (from host manifest). */
  appName: string;
  /** MCP server name (e.g., "synapse-crm"). */
  serverName: string;
  /** App route from placement declaration (e.g., "@nimblebraininc/synapse-crm"). */
  appRoute: string | null;
  /** App category (from host manifest). */
  appCategory?: string;
  /** Resolved data — count, sample entities, or tool/resource output. */
  data: string;
  /** Whether resolution succeeded. */
  ok: boolean;
}

/** Collected briefing context — all resolved facets grouped by priority. */
export interface BriefingContext {
  /** Resolved facets sorted by app priority (high → medium → low). */
  facets: FacetResult[];
  /** Period covered. */
  period: { since: string; until: string };
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Collect briefing data from installed connectors.
 * Each connector with a briefing block in _meta["ai.nimblebrain/host"] contributes facets.
 */
export async function collectBriefingFacets(
  instances: BundleInstance[],
  registry: ToolRegistry,
  period: { since: string; until: string },
): Promise<BriefingContext> {
  // Gather apps with briefing declarations, sorted by priority
  const appsWithBriefing: Array<{
    instance: BundleInstance;
    briefing: BriefingBlock;
  }> = [];

  for (const inst of instances) {
    if (inst.briefing && inst.state === "running") {
      appsWithBriefing.push({ instance: inst, briefing: inst.briefing });
    }
  }

  appsWithBriefing.sort(
    (a, b) =>
      (PRIORITY_ORDER[a.briefing.priority ?? "medium"] ?? 1) -
      (PRIORITY_ORDER[b.briefing.priority ?? "medium"] ?? 1),
  );

  // Resolve all facets (concurrently per app, sequentially between apps to limit load)
  const results: FacetResult[] = [];

  for (const { instance, briefing } of appsWithBriefing) {
    const appName = instance.ui?.name ?? instance.bundleName;
    const appRoute = instance.ui?.placements?.[0]?.route ?? null;

    const facetPromises = briefing.facets.map((facet) =>
      resolveFacet(facet, {
        appName,
        appCategory: undefined,
        appRoute,
        registry,
        period,
        serverName: instance.serverName,
      }),
    );

    const resolved = await Promise.all(facetPromises);
    results.push(...resolved);
  }

  return { facets: results, period };
}

// ---------------------------------------------------------------------------
// Facet resolvers
// ---------------------------------------------------------------------------

interface ResolveContext {
  appName: string;
  appCategory?: string;
  appRoute: string | null;
  registry: ToolRegistry;
  period: { since: string; until: string };
  serverName: string;
}

async function resolveFacet(facet: BriefingFacet, ctx: ResolveContext): Promise<FacetResult> {
  const base = {
    facet,
    appName: ctx.appName,
    serverName: ctx.serverName,
    appRoute: ctx.appRoute,
    appCategory: ctx.appCategory,
  };

  try {
    if (facet.resource) {
      const data = await resolveResourceFacet(facet, ctx.registry, ctx.serverName);
      return { ...base, data, ok: true };
    }

    if (facet.tool) {
      const data = await resolveToolFacet(facet, ctx.registry);
      return { ...base, data, ok: true };
    }

    // No resolution method — use description as fallback
    return {
      ...base,
      data: facet.description ?? `${facet.label}: no data source configured`,
      ok: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, data: `Error resolving ${facet.name}: ${msg}`, ok: false };
  }
}

/**
 * Resolve a resource facet by reading an MCP resource from the app's server.
 */
async function resolveResourceFacet(
  facet: BriefingFacet,
  registry: ToolRegistry,
  serverName: string,
): Promise<string> {
  const source = registry.getSources().find((s: ToolSource) => s.name === serverName);
  if (!source) {
    return `Server ${serverName} not found`;
  }
  if (!(source instanceof McpSource)) {
    return `Server ${serverName} does not support resource reads`;
  }

  const result = await source.readResource(facet.resource!);
  if (!result) return `Resource ${facet.resource} returned empty`;
  if (typeof result.text === "string") return result.text;
  return JSON.stringify(result);
}

/**
 * Resolve a tool facet by calling an MCP tool via the registry.
 */
async function resolveToolFacet(facet: BriefingFacet, registry: ToolRegistry): Promise<string> {
  const result = await registry.execute({
    id: `briefing-${facet.name}`,
    name: facet.tool!,
    input: facet.tool_input ?? {},
  });

  // Extract text from tool result
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n")
      .slice(0, 2000); // Limit to prevent token explosion
  }
  return JSON.stringify(result).slice(0, 2000);
}
