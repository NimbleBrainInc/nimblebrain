/**
 * Aggregates every active `StaticRegistry`'s `ServerDetail[]` into a
 * single flattened list and exposes a UI-friendly per-entry projection.
 *
 * Why this exists separately from the registry → DirectoryEntry path:
 *
 *   - `DirectoryEntry` is the Browse-row contract — opaque-id +
 *     install-action discriminator. Good for one-click install; thin
 *     on the connector-metadata fields the Configure page needs
 *     (operatorSetup, requiredScopes, additionalAuthorizationParams,
 *     interactive flag, etc.).
 *   - `ConnectorCatalogEntry` (this file) is the flat record the
 *     Configure detail page renders for an *installed* connector
 *     matched back to its catalog entry, plus the lookup shape the
 *     setup_operator / remove_operator_setup tool actions consume.
 *
 * Both are server-side projections of one canonical source —
 * `ServerDetail[]` from active static registries. Mpak entries are
 * stdio bundles; they don't show up here (no remote URL, no operator
 * setup).
 */

import type { RegistryStore } from "../registries/registry-store.ts";
import { getNimbleBrainConnectorMeta, type ServerDetail } from "./server-detail.ts";
import { readStaticServers } from "./static-registry.ts";

/**
 * Flat per-entry record consumed by the platform's connector handlers.
 * Mirrors the wire shape the web shell expects under
 * `InstalledConnector.catalog`. Fields are derived mechanically from
 * `ServerDetail` + its `_meta["ai.nimblebrain/connector"]` extension.
 */
export interface ConnectorCatalogEntry {
  /** Stable identifier — upstream `ServerDetail.name` (reverse-DNS). */
  id: string;
  /** Display name from `title` (falling back to `name`). */
  name: string;
  description: string;
  /** First icon src; the platform-bundled catalog ships at least one. */
  iconUrl: string;
  /** Remote MCP server URL — the value that goes into the bundle `url`. */
  url: string;
  auth: "dcr" | "static";
  defaultScope: "workspace" | "user";
  requiredScopes?: string[];
  additionalAuthorizationParams?: Record<string, string>;
  operatorSetup?: { portalUrl: string; hint: string; clientSecretKey: string };
  tags?: string[];
  interactive?: boolean;
  docsUrl?: string;
}

/** Project one `ServerDetail` into the flat catalog entry shape. Returns null when the entry isn't a remote OAuth service (no `remotes[]`). */
export function serverDetailToCatalogEntry(s: ServerDetail): ConnectorCatalogEntry | null {
  const remote = s.remotes?.[0];
  if (!remote) return null;
  const iconUrl = s.icons?.[0]?.src;
  if (!iconUrl) return null;
  const meta = getNimbleBrainConnectorMeta(s);
  return {
    id: s.name,
    name: s.title ?? s.name,
    description: s.description,
    iconUrl,
    url: remote.url,
    auth: meta?.auth ?? "dcr",
    defaultScope: meta?.defaultScope ?? "workspace",
    ...(meta?.requiredScopes ? { requiredScopes: meta.requiredScopes } : {}),
    ...(meta?.additionalAuthorizationParams
      ? { additionalAuthorizationParams: meta.additionalAuthorizationParams }
      : {}),
    ...(meta?.operatorSetup ? { operatorSetup: meta.operatorSetup } : {}),
    ...(meta?.tags ? { tags: meta.tags } : {}),
    ...(typeof meta?.interactive === "boolean" ? { interactive: meta.interactive } : {}),
    ...(meta?.docsUrl ? { docsUrl: meta.docsUrl } : {}),
  };
}

/**
 * Read every active static registry's `ServerDetail[]` and flatten
 * them into a single list. Used by handlers that need to look up a
 * catalog entry by id or by URL — these are first-party handlers, so
 * we trust the registry-store config and read every static source it
 * lists.
 */
export async function loadStaticServers(store: RegistryStore): Promise<ServerDetail[]> {
  const configs = await store.list();
  const out: ServerDetail[] = [];
  for (const cfg of configs) {
    if (cfg.type !== "static" || !cfg.enabled || !cfg.url) continue;
    out.push(...readStaticServers(cfg.url));
  }
  return out;
}

/**
 * Convenience wrapper: load every static `ServerDetail`, project each
 * to the flat `ConnectorCatalogEntry` shape, and return only the
 * entries that successfully projected (i.e. carry a remote URL and
 * an icon). Drops mpak-package-only static entries — those don't have
 * an OAuth catalog identity.
 */
export async function loadStaticConnectorEntries(
  store: RegistryStore,
): Promise<ConnectorCatalogEntry[]> {
  const servers = await loadStaticServers(store);
  const out: ConnectorCatalogEntry[] = [];
  for (const s of servers) {
    const entry = serverDetailToCatalogEntry(s);
    if (entry) out.push(entry);
  }
  return out;
}
