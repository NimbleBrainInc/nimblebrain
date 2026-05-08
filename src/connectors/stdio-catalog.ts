/**
 * Curated stdio bundle list — the NimbleBrain-blessed set of
 * `@nimblebraininc/*` mpak bundles surfaced on the Browse page.
 *
 * Why this exists separate from `catalog.ts`:
 *   - `catalog.ts` carries remote-OAuth services (Asana, HubSpot, ...).
 *     Different shape (URL + OAuth scopes) and different install path.
 *   - This file carries stdio bundles installed via the mpak SDK.
 *     They surface in the same Browse list (as `mpak-bundle`-kind
 *     `DirectoryEntry`s) and end up calling `lifecycle.installNamed`,
 *     which uses mpak's bundle cache + registry under the hood.
 *
 * The bundled list is intentionally hand-curated rather than
 * auto-discovered — explicit control over what shows up in the UI
 * (private bundles excluded, deprecated entries can be cut without
 * surprise).
 *
 * Add a new bundle by:
 *   1. Releasing it to mpak with the published name `@nimblebraininc/<id>`.
 *   2. Appending an entry to `stdio-catalog.yaml`.
 *
 * Bundles published privately (e.g. tenant-specific Synapse apps) stay
 * out of this list — they install via the chat agent's `bundleManagement`
 * tool, not Browse.
 *
 * Distribution model mirrors the OAuth catalog:
 *   1. `stdio-catalog.yaml` (this directory) ships with the platform.
 *   2. `NB_STDIO_CATALOG_PATH` env var (optional) points at a YAML or
 *      JSON file that **fully replaces** the default. Same Replace-not-
 *      Merge semantics as the OAuth catalog.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { log } from "../cli/log.ts";

export interface StdioBundleEntry {
  /** Stable id used as the catalog id and serverName at install time. */
  id: string;
  /** Display name for the Browse card. */
  name: string;
  /** One-sentence description. Surfaces under the name on the Browse row. */
  description: string;
  /** Scoped mpak package name; passed to `lifecycle.installNamed`. */
  bundleName: string;
  /** Free-form tags. Currently search-matched in Browse; not rendered. */
  tags?: string[];
  /** Optional icon URL for the Browse row. */
  iconUrl?: string;
}

let _defaultBundlesCache: StdioBundleEntry[] | undefined;

/**
 * Reads the bundled `stdio-catalog.yaml` next to this source file and
 * returns the raw entries (top-level `bundles:` list). Validation
 * happens in `loadStdioBundles()`.
 */
export function readDefaultStdioCatalogYaml(): unknown[] {
  const path = join(import.meta.dir, "stdio-catalog.yaml");
  const text = readFileSync(path, "utf-8");
  const parsed = Bun.YAML.parse(text) as { bundles?: unknown };
  if (!parsed || !Array.isArray(parsed.bundles)) {
    throw new Error(`[stdio-catalog] ${path}: top-level 'bundles' must be a list`);
  }
  return parsed.bundles;
}

/**
 * Resolution order:
 *   1. `NB_STDIO_CATALOG_PATH` env var, when set + file exists. Fully
 *      replaces the default. Accepts YAML or JSON (extension-sniffed).
 *   2. The bundled `stdio-catalog.yaml` (cached after first read).
 *
 * Validation drops malformed entries with a logged warning; the
 * surviving subset is returned in original order. Top-level shape
 * errors fall back to the bundled default.
 */
export function loadStdioBundles(): StdioBundleEntry[] {
  const overridePath = process.env.NB_STDIO_CATALOG_PATH;
  if (overridePath) {
    if (!existsSync(overridePath)) {
      log.warn(
        `[stdio-catalog] NB_STDIO_CATALOG_PATH=${overridePath} not found — using bundled catalog`,
      );
      return getDefaultBundles();
    }
    const raw = readOverride(overridePath);
    if (raw === undefined) return getDefaultBundles();
    return validateStdioBundles(raw, overridePath);
  }
  return getDefaultBundles();
}

function getDefaultBundles(): StdioBundleEntry[] {
  if (_defaultBundlesCache) return _defaultBundlesCache;
  _defaultBundlesCache = validateStdioBundles(
    readDefaultStdioCatalogYaml(),
    "<bundled stdio-catalog.yaml>",
  );
  return _defaultBundlesCache;
}

function readOverride(path: string): unknown[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn(
      `[stdio-catalog] failed to read ${path}: ${err instanceof Error ? err.message : String(err)} — using bundled catalog`,
    );
    return undefined;
  }
  let parsed: unknown;
  try {
    const ext = extname(path).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      const obj = Bun.YAML.parse(text) as { bundles?: unknown };
      parsed = obj?.bundles;
    } else {
      parsed = JSON.parse(text);
    }
  } catch (err) {
    log.warn(
      `[stdio-catalog] failed to parse ${path}: ${err instanceof Error ? err.message : String(err)} — using bundled catalog`,
    );
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    log.warn(`[stdio-catalog] ${path} did not yield an array of entries — using bundled catalog`);
    return undefined;
  }
  return parsed;
}

/**
 * Validate a stdio-catalog candidate. Drops malformed entries (with
 * logged warning) and rejects duplicate ids. Mirrors the shape of
 * `validateCatalog` in `load-catalog.ts`.
 *
 * Rules per entry:
 *   - id: kebab-case slug (matches `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?`)
 *   - name, description: non-empty strings
 *   - bundleName: scoped npm-style name starting with `@`
 *   - tags, iconUrl: optional, dropped silently when wrong shape
 *   - iconUrl: when present, must be http(s) absolute or `/`-relative
 */
export function validateStdioBundles(
  raw: unknown[],
  source: string = "<inline>",
): StdioBundleEntry[] {
  const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  const out: StdioBundleEntry[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i] as Partial<StdioBundleEntry> | undefined;
    const tag = `${source}[${i}${candidate?.id ? `:${candidate.id}` : ""}]`;

    if (!candidate || typeof candidate !== "object") {
      log.warn(`[stdio-catalog] ${tag} dropped — not an object`);
      continue;
    }
    if (typeof candidate.id !== "string" || !ID_RE.test(candidate.id)) {
      log.warn(`[stdio-catalog] ${tag} dropped — id missing or invalid (must match ${ID_RE})`);
      continue;
    }
    if (seenIds.has(candidate.id)) {
      log.warn(`[stdio-catalog] ${tag} dropped — duplicate id`);
      continue;
    }
    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      log.warn(`[stdio-catalog] ${tag} dropped — name missing`);
      continue;
    }
    if (typeof candidate.description !== "string" || candidate.description.length === 0) {
      log.warn(`[stdio-catalog] ${tag} dropped — description missing`);
      continue;
    }
    if (typeof candidate.bundleName !== "string" || !candidate.bundleName.startsWith("@")) {
      log.warn(
        `[stdio-catalog] ${tag} dropped — bundleName must be a scoped package (e.g. "@org/name")`,
      );
      continue;
    }
    if (candidate.iconUrl !== undefined && !isSafeIconUrl(candidate.iconUrl)) {
      log.warn(`[stdio-catalog] ${tag} dropped — iconUrl must be http(s) absolute or '/'-relative`);
      continue;
    }

    seenIds.add(candidate.id);
    out.push({
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      bundleName: candidate.bundleName,
      ...(Array.isArray(candidate.tags) && candidate.tags.every((t) => typeof t === "string")
        ? { tags: candidate.tags }
        : {}),
      ...(typeof candidate.iconUrl === "string" ? { iconUrl: candidate.iconUrl } : {}),
    });
  }

  return out;
}

/**
 * iconUrl protocol allowlist: http(s) absolute or `/`-relative.
 * Same threat model as the OAuth catalog — a malicious / misconfigured
 * stdio ConfigMap entry could otherwise inject `javascript:` /
 * `data:` URLs into the Browse page's `<img src>`.
 */
function isSafeIconUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  if (url.startsWith("/")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
