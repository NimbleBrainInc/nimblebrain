/**
 * Project an upstream `ServerDetail` into the platform's
 * `DirectoryEntry` shape. Mechanical per spec §6.3 — every
 * `ConnectorRegistry` runs `ServerDetail` through this same function so
 * the Browse UI and install dispatch see one consistent contract.
 *
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
 * an SSE installer). The aggregator drops nulls with a logged note.
 */

import { getNimbleBrainConnectorMeta, type ServerDetail } from "../connectors/server-detail.ts";
import type { DirectoryEntry, RegistryType } from "./types.ts";

export interface ProjectionContext {
  registryId: string;
  registryType: RegistryType;
}

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
