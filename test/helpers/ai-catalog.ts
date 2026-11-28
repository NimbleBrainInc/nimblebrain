/**
 * AI Catalog listings for tests, in the shape NimbleBrain's catalog publishes
 * at `/.well-known/ai-catalog.json` (ADR-0077): one `application/agent-plugins+zip`
 * entry per plugin, its archive under `/plugins/`, and the `ai.nimblebrain`
 * extension carrying `iconUrl`, `category`, `servers` and `nimblebrainOnly`.
 */

import { createHash } from "node:crypto";
import type { ResolvedCatalog } from "../../src/config/catalogs.ts";

export interface FixtureItem {
  /** The `urn:air` name segment. */
  name: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  category?: string;
  /** Server key → `{name, auth}`. Default: one server `<name>` named `com.<name>/mcp`, `dcr`. */
  servers?: Record<string, { name: string; auth: string }>;
  nimblebrainOnly?: boolean;
}

/** One listing entry as the live catalog writes it. */
export function listingEntry(
  item: FixtureItem,
  base = "https://catalog.test",
): Record<string, unknown> {
  const digest = createHash("sha256").update(item.name).digest("hex");
  const servers = item.servers ?? { [item.name]: { name: `com.${item.name}/mcp`, auth: "dcr" } };
  return {
    identifier: `urn:air:nimblebrain.ai:${item.name}:plugin`,
    displayName: item.displayName ?? item.name[0]?.toUpperCase() + item.name.slice(1),
    type: "application/agent-plugins+zip",
    url: `${base}/plugins/${item.name}/${digest}.zip`,
    digest: `sha256:${digest}`,
    description: item.description ?? `${item.name} tools`,
    ...(item.tags ? { tags: item.tags } : {}),
    extensions: {
      "ai.nimblebrain": {
        ...(item.nimblebrainOnly ? { nimblebrainOnly: true } : {}),
        iconUrl: `https://static.test/logos/${item.name}/light.svg`,
        category: item.category ?? "Productivity",
        servers,
      },
    },
    publisher: { identifier: "nimblebrain.ai", displayName: "NimbleBrain", identityType: "dns" },
  };
}

/** A whole AI Catalog document over `entries`. */
export function listingDocument(entries: unknown[]): Record<string, unknown> {
  return {
    specVersion: "0.9",
    host: { displayName: "NimbleBrain", identifier: "nimblebrain.ai" },
    entries,
  };
}

export function listingBytes(entries: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(listingDocument(entries)));
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A resolved URL catalog, as `resolveCatalogs` would produce it. */
export function urlCatalog(
  name: string,
  url: string,
  over: Partial<ResolvedCatalog> = {},
): ResolvedCatalog {
  return {
    name,
    source: { kind: "url", url },
    label: url,
    policy: "available",
    refreshMs: 15 * 60_000,
    ...over,
  };
}

/** A resolved path catalog. */
export function pathCatalog(
  name: string,
  path: string,
  over: Partial<ResolvedCatalog> = {},
): ResolvedCatalog {
  return {
    name,
    source: { kind: "path", path },
    label: path,
    policy: "available",
    refreshMs: 15 * 60_000,
    ...over,
  };
}
