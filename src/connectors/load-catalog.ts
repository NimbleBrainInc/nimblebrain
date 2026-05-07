import { existsSync, readFileSync } from "node:fs";
import { log } from "../cli/log.ts";
import { validateAdditionalAuthorizationParams } from "../tools/workspace-oauth-provider.ts";
import { type ConnectorCatalogEntry, DEFAULT_CONNECTOR_CATALOG } from "./catalog.ts";

/**
 * Load the connector catalog. Resolution order:
 *
 *   1. `NB_CATALOG_PATH` env var, when set + file exists. The JSON at
 *      that path **fully replaces** the default catalog.
 *   2. `DEFAULT_CONNECTOR_CATALOG` (in code).
 *
 * Why **replace** rather than merge by id:
 *
 *   - Merge has confusing semantics (which side wins on conflicts? is
 *     `disabled: true` a valid override? what about partial overrides
 *     of a single field?). Replace keeps the contract obvious — what
 *     the operator mounts is the entire catalog.
 *   - Operators who want to start from defaults can copy the default
 *     out of a running container (kubectl cp from src/connectors/catalog.ts),
 *     edit, and mount.
 *
 * Validation: malformed entries are dropped with a logged warning that
 * names the entry id (or its index when no id is present). Duplicate
 * ids are rejected (second one wins a logged warning, first one
 * keeps). The whole catalog falls back to the default if the JSON is
 * unparseable or the top-level shape isn't an array.
 */
export function loadCatalog(): ConnectorCatalogEntry[] {
  const overridePath = process.env.NB_CATALOG_PATH;
  if (!overridePath) return DEFAULT_CONNECTOR_CATALOG;
  if (!existsSync(overridePath)) {
    log.warn(`[catalog] NB_CATALOG_PATH=${overridePath} not found — using default catalog`);
    return DEFAULT_CONNECTOR_CATALOG;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(overridePath, "utf-8"));
  } catch (err) {
    log.warn(
      `[catalog] failed to parse ${overridePath}: ${err instanceof Error ? err.message : String(err)} — using default catalog`,
    );
    return DEFAULT_CONNECTOR_CATALOG;
  }
  if (!Array.isArray(raw)) {
    log.warn(`[catalog] ${overridePath} is not a JSON array — using default catalog`);
    return DEFAULT_CONNECTOR_CATALOG;
  }
  return validateCatalog(raw as unknown[], overridePath);
}

/**
 * Validate a catalog candidate. Drops malformed entries (with logged
 * warning) and rejects duplicate ids. Returns the surviving entries
 * in their original order.
 *
 * Rules per entry:
 *   - id, name, description, iconUrl, url all required (string, non-empty)
 *   - auth ∈ {"dcr", "static"}
 *   - defaultScope ∈ {"workspace", "user"}
 *   - id matches `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?` (kebab, lowercase)
 *   - operatorSetup required + well-formed when auth === "static"
 *   - requiredScopes / additionalAuthorizationParams / tags optional;
 *     dropped silently when wrong shape (the entry survives with the
 *     bad field omitted)
 */
export function validateCatalog(
  raw: unknown[],
  source: string = "<inline>",
): ConnectorCatalogEntry[] {
  const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const out: ConnectorCatalogEntry[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i] as Partial<ConnectorCatalogEntry> | undefined;
    const tag = `${source}[${i}${candidate?.id ? `:${candidate.id}` : ""}]`;

    if (!candidate || typeof candidate !== "object") {
      log.warn(`[catalog] ${tag} dropped — not an object`);
      continue;
    }

    if (typeof candidate.id !== "string" || !ID_RE.test(candidate.id)) {
      log.warn(`[catalog] ${tag} dropped — id missing or invalid (must match ${ID_RE})`);
      continue;
    }
    if (seenIds.has(candidate.id)) {
      log.warn(`[catalog] ${tag} dropped — duplicate id`);
      continue;
    }
    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      log.warn(`[catalog] ${tag} dropped — name missing`);
      continue;
    }
    if (typeof candidate.description !== "string") {
      log.warn(`[catalog] ${tag} dropped — description missing`);
      continue;
    }
    if (typeof candidate.iconUrl !== "string" || candidate.iconUrl.length === 0) {
      log.warn(`[catalog] ${tag} dropped — iconUrl missing`);
      continue;
    }
    // iconUrl renders as <img src=...> in the Connectors page. React's
    // JSX doesn't sanitize <img src> — a malicious / misconfigured catalog
    // entry with `iconUrl: "javascript:..."` or
    // `iconUrl: "data:image/svg+xml;..."` (SVGs can carry <script>) is a
    // real vector. Allow only http(s) absolute URLs and same-origin
    // relative paths (anything starting with `/`).
    if (!isSafeIconUrl(candidate.iconUrl)) {
      log.warn(`[catalog] ${tag} dropped — iconUrl must be http(s) absolute or '/'-relative`);
      continue;
    }
    if (typeof candidate.url !== "string" || candidate.url.length === 0) {
      log.warn(`[catalog] ${tag} dropped — url missing`);
      continue;
    }
    if (candidate.auth !== "dcr" && candidate.auth !== "static") {
      log.warn(`[catalog] ${tag} dropped — auth must be 'dcr' or 'static'`);
      continue;
    }
    if (candidate.defaultScope !== "workspace" && candidate.defaultScope !== "user") {
      log.warn(`[catalog] ${tag} dropped — defaultScope must be 'workspace' or 'user'`);
      continue;
    }
    if (candidate.auth === "static") {
      const setup = candidate.operatorSetup;
      if (
        !setup ||
        typeof setup !== "object" ||
        typeof setup.portalUrl !== "string" ||
        typeof setup.hint !== "string" ||
        typeof setup.credentialKey !== "string"
      ) {
        log.warn(
          `[catalog] ${tag} dropped — auth='static' requires operatorSetup.{portalUrl,hint,credentialKey}`,
        );
        continue;
      }
    }
    // Defense-in-depth: reserved-key collisions in
    // additionalAuthorizationParams are caught at provider construction,
    // but failing here at catalog-load gives operators a clearer error
    // (entry id + reserved key names) than a runtime OAuth-flow stack
    // trace. Drop the entry on collision rather than the whole catalog.
    if (
      candidate.additionalAuthorizationParams &&
      typeof candidate.additionalAuthorizationParams === "object"
    ) {
      try {
        validateAdditionalAuthorizationParams(
          candidate.additionalAuthorizationParams as Record<string, string>,
        );
      } catch (err) {
        log.warn(`[catalog] ${tag} dropped — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    seenIds.add(candidate.id);
    out.push({
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      iconUrl: candidate.iconUrl,
      url: candidate.url,
      auth: candidate.auth,
      defaultScope: candidate.defaultScope,
      ...(Array.isArray(candidate.requiredScopes) &&
      candidate.requiredScopes.every((s) => typeof s === "string")
        ? { requiredScopes: candidate.requiredScopes }
        : {}),
      ...(candidate.additionalAuthorizationParams &&
      typeof candidate.additionalAuthorizationParams === "object" &&
      Object.values(candidate.additionalAuthorizationParams).every((v) => typeof v === "string")
        ? { additionalAuthorizationParams: candidate.additionalAuthorizationParams }
        : {}),
      ...(candidate.operatorSetup ? { operatorSetup: candidate.operatorSetup } : {}),
      ...(Array.isArray(candidate.tags) && candidate.tags.every((t) => typeof t === "string")
        ? { tags: candidate.tags }
        : {}),
      ...(typeof candidate.interactive === "boolean" ? { interactive: candidate.interactive } : {}),
    });
  }

  return out;
}

/**
 * iconUrl protocol allowlist: http(s) absolute or `/`-relative.
 * Rejects `javascript:`, `data:`, `file:`, `vbscript:`, etc. — anything
 * that could let a catalog ConfigMap inject script execution via the
 * Connectors page's `<img src>`.
 */
function isSafeIconUrl(url: string): boolean {
  if (url.startsWith("/")) return true; // relative path served from same origin
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
