/**
 * BriefingCollector — reads briefing facet declarations from installed bundles
 * and resolves them into structured data for the BriefingGenerator.
 *
 * Resolution order per facet:
 *   1. entity  → read entity JSON files from disk, count/sample by timestamps
 *   2. resource → readResource() on the app's MCP server
 *   3. tool    → callTool() via the tool registry
 *
 * Only one of entity/resource/tool per facet. Falls back to description string.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sift from "sift";
import type { BriefingBlock, BriefingFacet, BundleInstance } from "../bundles/types.ts";
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
 * Collect briefing data from installed bundle manifests.
 * Each bundle with a briefing block in _meta["ai.nimblebrain/host"] contributes facets.
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
    const entityDataRoot = instance.entityDataRoot ?? null;

    const facetPromises = briefing.facets.map((facet) =>
      resolveFacet(facet, {
        appName,
        appCategory: undefined,
        appRoute,
        entityDataRoot,
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
  /** Full path to the entity data root (e.g., {dataDir}/{namespace}/data). */
  entityDataRoot: string | null;
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
    if (facet.entity && ctx.entityDataRoot) {
      const data = resolveEntityFacet(facet, ctx.entityDataRoot, ctx.period);
      return { ...base, data, ok: true };
    }

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
 * Resolve an entity facet by reading JSON files from disk.
 * Counts entities and samples recent ones based on created_at/updated_at.
 */
function resolveEntityFacet(
  facet: BriefingFacet,
  entityDataRoot: string,
  period: { since: string },
): string {
  // Entity files live at {entityDataRoot}/{plural}/*.json
  if (!existsSync(entityDataRoot)) {
    return `No data directory at ${entityDataRoot}`;
  }

  // Find the entity directory — try common pluralization
  const entityDir = findEntityDir(entityDataRoot, facet.entity!);
  if (!entityDir) {
    return `No ${facet.entity} entities found`;
  }

  // Read all entity files
  const files = readdirSync(entityDir).filter((f) => f.endsWith(".json"));
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  // Resolve query variables and build sift filter
  const vars = { "period.since": period.since, today, now };
  const resolvedQuery = facet.query ? resolveQueryVars(facet.query, vars) : {};
  const filter = sift(resolvedQuery);

  let total = 0;
  let matchingCount = 0;
  const samples: Array<Record<string, unknown>> = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(entityDir, file), "utf-8");
      const entity = JSON.parse(raw) as Record<string, unknown>;
      total++;

      if (filter(entity)) {
        matchingCount++;
        if (samples.length < 5) {
          samples.push(summarizeEntity(entity, facet.entity!));
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  const parts: string[] = [];
  parts.push(`${matchingCount} matching ${facet.entity} entities (${total} total)`);
  if (samples.length > 0) {
    parts.push(`Matching: ${JSON.stringify(samples)}`);
  }
  return parts.join(". ");
}

/**
 * Resolve a resource facet by reading an MCP resource from the app's server.
 */
async function resolveResourceFacet(
  facet: BriefingFacet,
  registry: ToolRegistry,
  serverName: string,
): Promise<string> {
  // Find the source by name
  const source = registry.getSources().find((s: ToolSource) => s.name === serverName);
  if (!source) {
    return `Server ${serverName} not found`;
  }

  // readResource is only available on McpSource — check if the method exists
  if (!("readResource" in source)) {
    return `Server ${serverName} does not support resource reads`;
  }

  const result = await (source as { readResource: (uri: string) => Promise<unknown> }).readResource(
    facet.resource!,
  );
  if (!result) return `Resource ${facet.resource} returned empty`;

  // Extract text content
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "text" in result) {
    return (result as { text: string }).text;
  }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the entity directory — tries exact plural, +s, +es, +ies. */
function findEntityDir(dataDir: string, entityName: string): string | null {
  const candidates = [
    `${entityName}s`,
    `${entityName}es`,
    entityName.replace(/y$/, "ies"),
    entityName,
  ];

  const dirs = readdirSync(dataDir);
  for (const candidate of candidates) {
    if (dirs.includes(candidate)) {
      const path = join(dataDir, candidate);
      return path;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Query variable resolver — walks a MongoDB-style query object and replaces
// "${var}" strings with runtime values before passing to sift.
// ---------------------------------------------------------------------------

function resolveQueryVars(
  query: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
      const varName = value.slice(2, -1);
      resolved[key] = vars[varName] ?? value;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      resolved[key] = resolveQueryVars(value as Record<string, unknown>, vars);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** Extract key fields from an entity for sampling (limit tokens). */
function summarizeEntity(entity: Record<string, unknown>, _type: string): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // Always include these if present
  const keyFields = [
    "id",
    "name",
    "title",
    "status",
    "stage",
    "priority",
    "severity",
    "value",
    "type",
  ];
  for (const field of keyFields) {
    if (entity[field] !== undefined) {
      summary[field] = entity[field];
    }
  }

  // Include timestamps
  if (entity.created_at) summary.created_at = entity.created_at;
  if (entity.updated_at) summary.updated_at = entity.updated_at;

  return summary;
}
