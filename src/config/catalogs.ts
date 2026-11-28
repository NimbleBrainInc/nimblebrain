/**
 * The `catalogs` block of `nimblebrain.json`: the AI Catalog listings this
 * instance reads what it offers to install from (ADR-0077).
 *
 * ```json
 * { "catalogs": [
 *     { "source": "https://catalog.example-vendor.com/ai-catalog.json",
 *       "policy": "required", "sha256": "…" },
 *     { "source": "https://catalog.nimblebrain.ai/.well-known/ai-catalog.json",
 *       "policy": "available" },
 *     { "source": "/etc/nimblebrain/catalogs/local", "policy": "available" } ] }
 * ```
 *
 * The block is the operator's: the override file has no writer for it, so it
 * is read from the seed config only. Pure, so the rules are unit-testable
 * without a runtime.
 *
 * - `source` is a listing URL (`https`, or `http` to a loopback host) or a path
 *   the operator mounts: a file holding an AI Catalog document, or a directory
 *   holding `ai-catalog.json` or `.well-known/ai-catalog.json`. A relative path
 *   resolves against the config file's directory.
 * - `policy` is `required` or `available`. A `required` catalog must carry
 *   `sha256`, so what every workspace receives moves only when the operator
 *   moves the pin.
 * - `sha256` pins the listing's bytes. An unpinned catalog is read live and
 *   refreshed every `refreshMinutes`.
 * - `name` is the catalog part of an item's address, `name@catalog`. Without
 *   one it is derived from the source (see {@link deriveCatalogName}).
 *
 * With no block, the instance reads NimbleBrain's catalog at
 * `<NB_PLUGIN_CATALOG_URL>/.well-known/ai-catalog.json`.
 */

import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { resolvePluginCatalogConfig } from "./plugin-catalog.ts";

type Env = Record<string, string | undefined>;

export type CatalogPolicy = "required" | "available";

/** One catalog, as an operator writes it. */
export interface CatalogConfig {
  /** A listing URL, or a path to a listing file or a directory holding one. */
  source: string;
  /** `required` is reconciled into every workspace; `available` is offered to install. */
  policy: CatalogPolicy;
  /** sha256 (lowercase hex) of the listing's bytes. Required for a `required` catalog. */
  sha256?: string;
  /** The catalog part of `name@catalog`. Derived from `source` when absent. */
  name?: string;
  /** How often an unpinned listing is read again, in minutes. Default 15. */
  refreshMinutes?: number;
}

/** Every key of a catalog entry, for the config schema drift guard. */
export const CATALOG_CONFIG_KEYS = Object.keys({
  source: true,
  policy: true,
  sha256: true,
  name: true,
  refreshMinutes: true,
} satisfies Record<keyof CatalogConfig, true>);

/** Where NimbleBrain's catalog serves its AI Catalog, under its base URL. */
export const AI_CATALOG_WELL_KNOWN_PATH = "/.well-known/ai-catalog.json";

/** How often an unpinned listing is read again when its entry names no interval. */
export const DEFAULT_CATALOG_REFRESH_MINUTES = 15;

/** The longest interval an entry may name: one day. */
export const MAX_CATALOG_REFRESH_MINUTES = 1440;

/**
 * The catalog name Browse lists the connector list's own records under: the
 * servers the install source holds that no listing names (a mounted
 * `NB_CURATED_CATALOG_DIR`'s fleet services and tenant entries). Reserved, so
 * no configured catalog can take it.
 */
export const CONNECTOR_LIST_CATALOG_NAME = "curated";

/** Where a catalog is read from. */
export type CatalogSource = { kind: "url"; url: string } | { kind: "path"; path: string };

/** A catalog as the reader uses it: named, its source resolved, its interval in ms. */
export interface ResolvedCatalog {
  name: string;
  source: CatalogSource;
  /** The source as configured, for messages. */
  label: string;
  policy: CatalogPolicy;
  sha256?: string;
  refreshMs: number;
}

const SHA256 = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The catalogs an instance reads when its configuration names none: NimbleBrain's. */
export function defaultCatalogs(env: Env = process.env): CatalogConfig[] {
  const { url } = resolvePluginCatalogConfig(env);
  return [{ source: `${url}${AI_CATALOG_WELL_KNOWN_PATH}`, policy: "available" }];
}

/**
 * Resolve the `catalogs` block, or the default when it is absent. Throws on a
 * block that cannot work: a `required` catalog without a pin, a malformed pin,
 * a URL that is neither `https` nor loopback `http`, two catalogs of one
 * source or one name, or a name that is reserved or not a short lowercase id.
 * An empty list is valid and reads no listings; the connector list's records
 * still show under `curated` until install reads an item's own archive.
 */
export function resolveCatalogs(
  configured: CatalogConfig[] | undefined,
  opts: { configPath?: string | undefined; env?: Env } = {},
): ResolvedCatalog[] {
  const entries = configured ?? defaultCatalogs(opts.env);
  const baseDir = opts.configPath ? dirname(opts.configPath) : process.cwd();
  const out: ResolvedCatalog[] = [];
  const names = new Map<string, string>();
  const sources = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    const where = `catalogs[${i}]`;
    const resolved = resolveOne(entry, where, baseDir);
    const key = resolved.source.kind === "url" ? resolved.source.url : resolved.source.path;
    if (sources.has(key)) throw new Error(`${where}: ${resolved.label} is listed twice`);
    sources.add(key);
    const prior = names.get(resolved.name);
    if (prior !== undefined) {
      throw new Error(
        `${where}: its name "${resolved.name}" is also the name of ${prior}; give one a distinct "name"`,
      );
    }
    names.set(resolved.name, resolved.label);
    out.push(resolved);
  }
  return out;
}

function resolveOne(entry: CatalogConfig, where: string, baseDir: string): ResolvedCatalog {
  const raw = typeof entry?.source === "string" ? entry.source.trim() : "";
  if (!raw) throw new Error(`${where}: "source" is required`);
  if (entry.policy !== "required" && entry.policy !== "available") {
    throw new Error(`${where}: "policy" must be "required" or "available"`);
  }
  const sha256 = resolvePin(entry, where);
  const source = parseSource(raw, where, baseDir);
  const name = entry.name?.trim() || deriveCatalogName(source);
  if (!NAME.test(name) || name.length > 64) {
    throw new Error(
      `${where}: catalog name "${name}" must be lowercase letters, digits and hyphens; set "name"`,
    );
  }
  if (name === CONNECTOR_LIST_CATALOG_NAME) {
    throw new Error(
      `${where}: the catalog name "${name}" is reserved for the connector list; set another "name"`,
    );
  }
  const minutes = entry.refreshMinutes ?? DEFAULT_CATALOG_REFRESH_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CATALOG_REFRESH_MINUTES) {
    throw new Error(
      `${where}: "refreshMinutes" must be a whole number from 1 to ${MAX_CATALOG_REFRESH_MINUTES}`,
    );
  }
  return {
    name,
    source,
    label: raw,
    policy: entry.policy,
    ...(sha256 ? { sha256 } : {}),
    refreshMs: minutes * 60_000,
  };
}

/** The entry's pin, lowercased; throws on a malformed one, or on a required catalog without one. */
function resolvePin(entry: CatalogConfig, where: string): string | undefined {
  const sha256 = entry.sha256?.trim().toLowerCase();
  if (sha256 !== undefined && !SHA256.test(sha256)) {
    throw new Error(`${where}: "sha256" must be a sha256 in lowercase hex`);
  }
  if (entry.policy === "required" && !sha256) {
    throw new Error(
      `${where}: a required catalog must be pinned with "sha256", so what every workspace receives changes only when the pin does`,
    );
  }
  return sha256 || undefined;
}

function parseSource(raw: string, where: string, baseDir: string): CatalogSource {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return { kind: "path", path: isAbsolute(raw) ? raw : resolve(baseDir, raw) };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${where}: "${raw}" is not a valid URL`);
  }
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!secure && !loopback) {
    throw new Error(`${where}: "${raw}" must be https (http only to a loopback host)`);
  }
  return { kind: "url", url: url.toString() };
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * A catalog's default name, from its source:
 *
 * - a URL: the label before the domain's last label (`catalog.nimblebrain.ai`
 *   is `nimblebrain`, `catalog.example-vendor.com` is `example-vendor`), or the
 *   whole host when it has one label or is an address;
 * - a path: its last segment without an extension, skipping a trailing
 *   `ai-catalog.json` and `.well-known` (`/etc/nimblebrain/catalogs/local` is
 *   `local`).
 *
 * The result is lowercased, with any other character turned into a hyphen.
 * Two sources that derive one name are refused; the operator sets `name`.
 */
export function deriveCatalogName(source: CatalogSource): string {
  let raw: string;
  if (source.kind === "url") {
    const host = new URL(source.url).hostname.replace(/^\[|\]$/g, "");
    const labels = host.split(".");
    const isAddress = /^[\d.]+$/.test(host) || host.includes(":");
    raw = isAddress || labels.length < 2 ? host : (labels[labels.length - 2] ?? host);
  } else {
    let path = source.path.replace(/\/+$/, "");
    if (basename(path) === "ai-catalog.json") path = dirname(path);
    if (basename(path) === ".well-known") path = dirname(path);
    raw = basename(path, extname(path));
  }
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
