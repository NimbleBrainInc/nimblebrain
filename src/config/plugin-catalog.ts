/**
 * Operator config for the plugin catalog (ADR-0068): the one catalog the runtime
 * reads its connector catalog and its connector skills from. Env-driven and
 * pure, so the policy is unit-testable without touching `process.env`.
 *
 * A catalog is addressed by its base URL and pinned by the sha256 of its
 * NimbleBrain index (`nimblebrain/marketplace.json`), read at
 * `<url>/nimblebrain/marketplace/<sha256>.json`, an object the catalog keeps for
 * good. Every plugin the index lists is in turn pinned by its archive's sha256,
 * and carries its servers' `ServerDetail`s, its skills and its conversation
 * starters, so the one pin fixes everything the runtime reads from the catalog.
 *
 * Moving forward is setting the pin to `sha256sum` of the live index. The
 * default below is compiled into the image; unset or blank env falls back to it.
 */

type Env = Record<string, string | undefined>;

/** NimbleBrain's catalog. */
export const PLUGIN_CATALOG_URL_DEFAULT = "https://catalog.nimblebrain.ai";

/** sha256 of the NimbleBrain index this image is pinned to. Bump deliberately. */
export const PLUGIN_CATALOG_SHA256_DEFAULT =
  "60cef92b61cb6ef3cdb8d80e6126dc60a2e107cf759173f4f71ceaac11dd2197";

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
  return {
    url: url.replace(/\/+$/, ""),
    sha256: pin(env, "NB_PLUGIN_CATALOG_SHA256", PLUGIN_CATALOG_SHA256_DEFAULT),
  };
}

function pin(env: Env, name: string, fallback: string): string {
  const value = ((env[name] ?? "").trim() || fallback).toLowerCase();
  if (!SHA256.test(value)) throw new Error(`${name} must be a sha256 in hex, got "${value}"`);
  return value;
}

/** The retired connector-skills env names that are set, which the runtime ignores. */
export function retiredConnectorSkillsEnv(env: Env = process.env): string[] {
  return RETIRED_CONNECTOR_SKILLS_ENV.filter((name) => (env[name] ?? "").trim() !== "");
}
