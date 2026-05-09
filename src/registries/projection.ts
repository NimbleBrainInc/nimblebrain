/**
 * Project the canonical `ServerDetail` wire shape into the platform's
 * row-shaped views. Two projections, one source of truth:
 *
 *   - `projectServerDetailToDirectoryEntry` — the Browse-row contract.
 *     Opaque-id + install-action discriminator. Used by every source
 *     so Browse / install dispatch see one consistent shape.
 *   - `serverDetailToCatalogEntry` — the flat catalog record the
 *     Configure detail page renders for an *installed* connector
 *     matched back to its catalog entry, plus the lookup shape the
 *     setup_operator / remove_operator_setup tool actions consume.
 *
 * Both are pure functions over `ServerDetail` + its
 * `_meta["ai.nimblebrain/connector"]` extension. The directory facade
 * runs them once per call and caches the resulting maps; callers
 * never invoke these directly.
 */

import { getNimbleBrainConnectorMeta, type ServerDetail } from "../connectors/server-detail.ts";
import type { DirectoryEntry, RegistryType } from "./types.ts";

export interface ProjectionContext {
  registryId: string;
  registryType: RegistryType;
}

/**
 * Source-of-truth for each output field:
 *
 *   - `id`            ← `ServerDetail.name` (reverse-DNS string)
 *   - `name`          ← `ServerDetail.title` ?? `ServerDetail.name`
 *   - `description`   ← `ServerDetail.description`
 *   - `iconUrl`       ← `ServerDetail.icons[0].src` (theme-aware picker is a follow-up)
 *   - `tags`          ← `_meta.ai.nimblebrain/connector.tags`
 *   - `defaultScope`  ← `_meta.ai.nimblebrain/connector.defaultScope` ?? `"workspace"`
 *   - `install`       ← derived from `packages[]` (mpak-bundle) or `remotes[]` (remote-oauth)
 *
 * Returns null if the entry isn't installable (no packages, no remotes,
 * or unsupported transport — e.g. an SSE-only remote when we don't ship
 * an SSE installer). The directory drops nulls with a logged note.
 */
export function projectServerDetailToDirectoryEntry(
  s: ServerDetail,
  ctx: ProjectionContext,
): DirectoryEntry | null {
  const install = deriveInstall(s);
  if (!install) return null;

  const meta = getNimbleBrainConnectorMeta(s);
  const iconUrl = s.icons?.[0]?.src;

  return {
    id: s.name,
    registryId: ctx.registryId,
    registryType: ctx.registryType,
    name: s.title ?? s.name,
    description: s.description,
    ...(iconUrl ? { iconUrl } : {}),
    ...(meta?.tags && meta.tags.length > 0 ? { tags: meta.tags } : {}),
    defaultScope: meta?.defaultScope ?? "workspace",
    install,
  };
}

/**
 * Decide which installable variant to surface. Bundles take precedence:
 * the MCP registry spec allows entries to advertise both packages and
 * remotes (a vendor that ships both a bundled CLI and a hosted endpoint),
 * but our Browse install dispatcher is single-action — pick the local
 * one because it's reproducible and doesn't depend on vendor uptime.
 */
function deriveInstall(s: ServerDetail): DirectoryEntry["install"] | null {
  const pkg = s.packages?.[0];
  if (pkg) {
    return { kind: "mpak-bundle", package: pkg.identifier };
  }
  const remote = s.remotes?.[0];
  if (remote && (remote.type === "streamable-http" || remote.type === "sse")) {
    const meta = getNimbleBrainConnectorMeta(s);
    return {
      kind: "remote-oauth",
      url: remote.url,
      auth: meta?.auth ?? "dcr",
      ...(meta?.requiredScopes ? { requiredScopes: meta.requiredScopes } : {}),
      ...(meta?.additionalAuthorizationParams
        ? { additionalAuthorizationParams: meta.additionalAuthorizationParams }
        : {}),
      ...(meta?.operatorSetup ? { operatorSetup: meta.operatorSetup } : {}),
    };
  }
  return null;
}

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

/**
 * Project one `ServerDetail` into the flat catalog entry shape.
 * Returns null when the entry isn't a remote OAuth service (no
 * `remotes[]`) or doesn't carry a renderable icon — those are the
 * minimum fields the Configure page assumes, and surfacing a
 * partial-shape catalog entry would break the call sites that
 * dereference `cat.url` or `cat.iconUrl` unconditionally.
 */
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
