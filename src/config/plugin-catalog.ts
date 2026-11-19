/**
 * Operator config for the plugin catalog the runtime reads connector skills
 * from (ADR-0068). Env-driven and pure, so the policy is unit-testable without
 * touching `process.env`.
 *
 * A catalog is addressed by its base URL and pinned by the sha256 of its
 * NimbleBrain index (`nimblebrain/marketplace.json`). The runtime reads the
 * index at `<url>/nimblebrain/marketplace/<sha256>.json`, an object the catalog
 * keeps for good, so the pin names exact bytes and never a moving tag. Every
 * plugin the index lists is in turn pinned by its archive's sha256.
 *
 * Moving forward is setting the pin to `sha256sum` of the live index. The
 * defaults below are compiled into the image; unset or blank env falls back to
 * them.
 */

type Env = Record<string, string | undefined>;

/** NimbleBrain's catalog. */
export const PLUGIN_CATALOG_URL_DEFAULT = "https://catalog.nimblebrain.ai";

/** sha256 of the NimbleBrain index this image is pinned to. Bump deliberately. */
export const PLUGIN_CATALOG_SHA256_DEFAULT =
  "ecc66a8950cb00d07a745ebf3cea8e2b9351ed48138b94f31f1c20c1b958c6ee";

/** Env names that configured the retired connector-skills repo; read only to warn. */
export const RETIRED_CONNECTOR_SKILLS_ENV = ["CONNECTOR_SKILLS_REPO", "CONNECTOR_SKILLS_VERSION"];

export interface PluginCatalogConfig {
  /** Base URL of the catalog, no trailing slash. */
  url: string;
  /** sha256 (lowercase hex) of the catalog's NimbleBrain index. */
  sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Resolve the catalog from `NB_PLUGIN_CATALOG_URL` and `NB_PLUGIN_CATALOG_SHA256`.
 * Throws on a pin that is not a sha256, since anything else could not be
 * verified and would only ever fail closed.
 */
export function resolvePluginCatalogConfig(env: Env = process.env): PluginCatalogConfig {
  const url = (env.NB_PLUGIN_CATALOG_URL ?? "").trim() || PLUGIN_CATALOG_URL_DEFAULT;
  const sha256 = (
    (env.NB_PLUGIN_CATALOG_SHA256 ?? "").trim() || PLUGIN_CATALOG_SHA256_DEFAULT
  ).toLowerCase();
  if (!SHA256.test(sha256)) {
    throw new Error(`NB_PLUGIN_CATALOG_SHA256 must be a sha256 in hex, got "${sha256}"`);
  }
  return { url: url.replace(/\/+$/, ""), sha256 };
}

/** The retired connector-skills env names that are set, which the runtime ignores. */
export function retiredConnectorSkillsEnv(env: Env = process.env): string[] {
  return RETIRED_CONNECTOR_SKILLS_ENV.filter((name) => (env[name] ?? "").trim() !== "");
}
