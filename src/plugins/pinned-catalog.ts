/**
 * Reading a pinned plugin catalog (ADR-0068): its NimbleBrain index and each
 * plugin's archive, verified against their sha256 and cached by content.
 *
 * The catalog publishes:
 *
 *     <catalog>/nimblebrain/marketplace/<pin>.json   the NimbleBrain index, kept for good
 *     <archive url from the index>                   each plugin's zip, with its sha256
 *
 * Both readers of the catalog go through here: the connector skill resolver
 * (`src/skills/connector-skill-resolver.ts`) and the connector catalog Browse
 * lists (`src/connectors/catalog/plugin-index.ts`). So one rule holds for both:
 *
 *   - Pinned: the index is read at the sha256 the runtime is pinned to, and every
 *     archive at the sha256 that index lists. No tag, branch or bare URL.
 *   - Fail-closed: a missing index, any non-2xx, a network error, an unreadable
 *     archive, or a digest mismatch throws. A caller that must not fail decides
 *     what to do instead; nothing here guesses.
 *   - Bounded: a response is read up to `MAX_FETCH_BYTES` and refused past it,
 *     before its digest is checked.
 *   - Content-addressed cache: the index and each archive are cached as the bytes
 *     fetched, under their sha256, and verified again on every read, so one fetch
 *     serves every workspace and a pin bump refetches only the plugins whose bytes
 *     changed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { assertDigest, fetchBounded } from "../util/pinned-fetch.ts";
import { readZip, ZIP_MAX_TOTAL_BYTES } from "../util/zip.ts";
import { PLUGIN_MANIFEST_FILE, readPluginJson } from "./manifest.ts";

export interface PinnedCatalogOptions {
  /** Content-addressed cache directory (`{workDir}/cache/plugin-catalog`). */
  cacheDir: string;
  /** Catalog base URL, no trailing slash. */
  catalogUrl: string;
  /** sha256 of the catalog's NimbleBrain index. */
  pin: string;
  /** Injectable fetch; tests pass a fixture. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 15000. */
  timeoutMs?: number;
}

/** One plugin the index lists, pinned by its archive's sha256. */
export interface IndexEntry {
  name: string;
  url: string;
  sha256: string;
}

/** The NimbleBrain index: the catalog's name and its archive-sourced plugins, in order. */
export interface CatalogIndex {
  name: string;
  plugins: IndexEntry[];
}

/**
 * The most bytes read from one catalog response: the archive expansion budget
 * `readZip` enforces (`ZIP_MAX_TOTAL_BYTES`) plus a 1 MiB allowance for ZIP
 * metadata. It is a download policy tied to that budget, not a bound the reader
 * implies; the index, a list of plugins, is far smaller.
 */
export const MAX_FETCH_BYTES = ZIP_MAX_TOTAL_BYTES + 1024 * 1024;

/** Claude Code's manifest, read when an archive has no Agent Plugins root manifest. */
const CLAUDE_PLUGIN_MANIFEST_FILE = ".claude-plugin/plugin.json";

/**
 * Where a plugin archive carries the `ServerDetail` of the server its
 * `extensions["ai.nimblebrain"].servers` names under `key`: the registry entry
 * the connector catalog lists and installs from.
 */
export function pluginServerDetailPath(key: string): string {
  return `ai.nimblebrain/servers/${key}.json`;
}

/**
 * How many plugin archives are fetched at once. Fetching every archive of an
 * index at once (about a hundred) makes a share of them time out against the
 * catalog's CDN; a few at a time fetches them all in about a second.
 */
export const ARCHIVE_FETCH_CONCURRENCY = 8;

/** `load` over every plugin of an index, at most `ARCHIVE_FETCH_CONCURRENCY` at a time, results in index order. */
export async function mapArchives<T, R>(items: T[], load: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  await mapWithConcurrency(items, ARCHIVE_FETCH_CONCURRENCY, async (item, i) => {
    out[i] = await load(item);
  });
  return out;
}

/** Where the catalog keeps the NimbleBrain index with this sha256. */
export function pinnedIndexUrl(catalogUrl: string, pin: string): string {
  return `${catalogUrl}/nimblebrain/marketplace/${pin}.json`;
}

/** Where the index with this sha256 is cached. */
export function indexCachePath(cacheDir: string, sha256: string): string {
  return join(cacheDir, "index", `${sha256}.json`);
}

/** Where a plugin archive with this sha256 is cached. */
export function archiveCachePath(cacheDir: string, sha256: string): string {
  return join(cacheDir, "plugins", `${sha256}.zip`);
}

/** The pinned index, from the cache or the catalog. Throws on any fetch or integrity failure. */
export async function loadIndex(opts: PinnedCatalogOptions): Promise<CatalogIndex> {
  const bytes = await loadPinned(
    indexCachePath(opts.cacheDir, opts.pin),
    pinnedIndexUrl(opts.catalogUrl, opts.pin),
    opts.pin,
    "catalog index",
    opts,
  );
  return parseIndexBytes(bytes);
}

/** Parse verified index bytes. Throws when they are not an index. */
export function parseIndexBytes(bytes: Uint8Array): CatalogIndex {
  return parseIndex(JSON.parse(new TextDecoder().decode(bytes)));
}

/** A plugin's verified archive, from the cache or the catalog. Throws on any fetch or integrity failure. */
export function loadArchive(entry: IndexEntry, opts: PinnedCatalogOptions): Promise<Uint8Array> {
  return loadPinned(
    archiveCachePath(opts.cacheDir, entry.sha256),
    entry.url,
    entry.sha256,
    `plugin ${entry.name}`,
    opts,
  );
}

/** A verified archive's files and its parsed manifest. Throws when it has no `plugin.json`. */
export interface PluginArchive {
  files: Map<string, Uint8Array>;
  manifest: unknown;
}

/**
 * Open a verified plugin archive: its files, and its manifest parsed by the
 * plugin reader (`./manifest.ts`). Claude Code's `.claude-plugin/plugin.json` is
 * read when the archive has no root manifest.
 */
export function openArchive(name: string, archive: Uint8Array): PluginArchive {
  const files = readZip(archive);
  const manifestPath = files.has(PLUGIN_MANIFEST_FILE)
    ? PLUGIN_MANIFEST_FILE
    : CLAUDE_PLUGIN_MANIFEST_FILE;
  const manifestBytes = files.get(manifestPath);
  if (!manifestBytes) throw new Error(`plugin ${name}: archive has no plugin.json`);
  return { files, manifest: readPluginJson(name, manifestPath, manifestBytes) };
}

async function loadPinned(
  path: string,
  url: string,
  sha256: string,
  what: string,
  opts: PinnedCatalogOptions,
): Promise<Uint8Array> {
  if (existsSync(path)) {
    const bytes = readFileSync(path);
    assertDigest(what, bytes, sha256);
    return bytes;
  }
  const bytes = await fetchBounded(url, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
    maxBytes: MAX_FETCH_BYTES,
  });
  assertDigest(what, bytes, sha256);
  writeCache(path, bytes);
  return bytes;
}

function parseIndex(raw: unknown): CatalogIndex {
  const name = field(raw, "name");
  const plugins = field(raw, "plugins");
  if (typeof name !== "string" || !Array.isArray(plugins)) {
    throw new Error("catalog index has no name or plugins");
  }
  const entries: IndexEntry[] = [];
  for (const plugin of plugins) {
    const source = field(plugin, "source");
    const pluginName = field(plugin, "name");
    const url = field(source, "url");
    const sha256 = field(source, "sha256");
    // Only an archive pinned by its digest can be verified; a git source is not
    // read here.
    if (field(source, "source") !== "archive") continue;
    if (
      typeof pluginName !== "string" ||
      typeof url !== "string" ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      throw new Error(`catalog index lists a malformed plugin: ${JSON.stringify(plugin)}`);
    }
    entries.push({ name: pluginName, url, sha256 });
  }
  return { name, plugins: entries };
}

/** Write through a temporary file, so a concurrent reader never sees partial bytes. */
function writeCache(path: string, bytes: Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
