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
import { validateAdditionalAuthorizationParams } from "../tools/workspace-oauth-provider.ts";
import { isHttpUrl } from "../util/url.ts";
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
 *   - `defaultBinding` ← `_meta.ai.nimblebrain/connector.defaultBinding` ?? `"workspace"`
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
    defaultBinding: meta?.defaultBinding ?? "workspace",
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
      transportType: remote.type,
      auth: meta?.auth ?? "dcr",
      ...(meta?.requiredScopes ? { requiredScopes: meta.requiredScopes } : {}),
      ...(meta?.additionalAuthorizationParams
        ? { additionalAuthorizationParams: meta.additionalAuthorizationParams }
        : {}),
      ...(meta?.operatorSetup ? { operatorSetup: meta.operatorSetup } : {}),
      ...(meta?.composio ? { composio: meta.composio } : {}),
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
  auth: "dcr" | "static" | "composio";
  defaultBinding: "workspace" | "personal";
  requiredScopes?: string[];
  additionalAuthorizationParams?: Record<string, string>;
  operatorSetup?: { portalUrl: string; hint: string; clientSecretKey: string };
  /**
   * Composio-specific config for `auth: "composio"` entries. The
   * platform reads these to call `composio.create()` at install
   * time and to look up the toolkit slug when persisting
   * `connection.json`. Absent on dcr/static entries.
   */
  composio?: { toolkit: string; authConfigEnv: string; tools?: string[] };
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
    defaultBinding: meta?.defaultBinding ?? "workspace",
    ...(meta?.requiredScopes ? { requiredScopes: meta.requiredScopes } : {}),
    ...(meta?.additionalAuthorizationParams
      ? { additionalAuthorizationParams: meta.additionalAuthorizationParams }
      : {}),
    ...(meta?.operatorSetup ? { operatorSetup: meta.operatorSetup } : {}),
    ...(meta?.composio ? { composio: meta.composio } : {}),
    ...(meta?.tags ? { tags: meta.tags } : {}),
    ...(typeof meta?.interactive === "boolean" ? { interactive: meta.interactive } : {}),
    ...(meta?.docsUrl ? { docsUrl: meta.docsUrl } : {}),
  };
}

/**
 * Defense-in-depth safety check on a `ServerDetail` regardless of which
 * source emitted it. Runs at the directory boundary so mpak-published
 * entries are scrubbed identically to bundled-static / NB_REGISTRIES
 * static entries — pre-fix only static-source ran this check, so a
 * malicious mpak publisher (or any non-curated mpak scope) could ship
 * `_meta.docsUrl: "javascript:..."` and the Configure page would render
 * it as a clickable `<a href>`. `target="_blank" rel="noopener noreferrer"`
 * does NOT block `javascript:` URI execution.
 *
 * Returns the first violation message, or null when the entry is safe.
 * Caller drops on non-null + logs with the source-tagged registry id.
 *
 * Catches:
 *   - icons[].src non-http(s) (would XSS the Browse `<img src>`)
 *   - operatorSetup.portalUrl non-http(s) (clickable in Set-up modal)
 *   - docsUrl non-http(s) (clickable in Configure page hero)
 *   - additionalAuthorizationParams reserved-key smuggling (RFC 6749
 *     params client_id, redirect_uri, state, etc. — would let a
 *     catalog override OAuth-flow-critical parameters)
 */
export function validateServerDetailSafety(s: ServerDetail): string | null {
  for (const icon of s.icons ?? []) {
    if (!isHttpUrl(icon.src)) {
      return `icon src must be http(s): "${icon.src}"`;
    }
  }
  const meta = getNimbleBrainConnectorMeta(s);
  if (meta?.operatorSetup) {
    if (!isHttpUrl(meta.operatorSetup.portalUrl)) {
      return `operatorSetup.portalUrl must be http(s): "${meta.operatorSetup.portalUrl}"`;
    }
  }
  if (meta?.additionalAuthorizationParams) {
    try {
      validateAdditionalAuthorizationParams(meta.additionalAuthorizationParams);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (meta?.docsUrl !== undefined && !isHttpUrl(meta.docsUrl)) {
    return `docsUrl must be http(s): "${meta.docsUrl}"`;
  }
  return null;
}
