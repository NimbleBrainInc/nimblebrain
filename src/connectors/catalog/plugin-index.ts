/**
 * The connector catalog from the pinned plugin index (ADR-0068): what Browse
 * lists when no catalog directory is mounted.
 *
 * The index the runtime is pinned to (`NB_PLUGIN_CATALOG_SHA256`) is the only
 * root. Each plugin it lists names its servers in `plugin.json` under
 * `extensions["ai.nimblebrain"].servers` (key → registry name), and carries each
 * server's `ServerDetail` at `ai.nimblebrain/servers/<key>.json`. Those files are
 * the catalog: read from the verified archives the skill resolver also reads
 * (`src/plugins/pinned-catalog.ts`, one cache for both), then validated by the
 * same path a catalog directory takes (`validateServerCandidates`), so the
 * schema, dedupe and server-name rules are the same, and `ConnectorCatalog`
 * applies the safety scrub to every entry whatever its source.
 *
 * - **Never guessed.** A plugin server with no server file, an unparseable one,
 *   or one whose `name` is not the registry name the plugin gives it is skipped
 *   with a diagnostic. A plugin that names no server is not a connector.
 * - **One plugin per server name.** Grants bind an installed connector to its
 *   catalog entry by server name, so a second plugin naming a server an earlier
 *   one (in index order) already names is refused with an error.
 * - **Never fatal.** When the pinned index cannot be read, the newest verified
 *   index in the cache is read instead, with a warning naming its digest; with
 *   none, the catalog is empty and the error says why. An archive that cannot be
 *   read leaves its plugin out and is reported.
 * - **Built once per pin.** A complete build (the pinned index and every
 *   archive) is content-addressed, so it is kept in memory and its diagnostics
 *   are logged once. A build that fell short (a fallback, an archive or index
 *   that could not be fetched) is kept for `RETRY_AFTER_MS`, then built again,
 *   so a runtime that booted offline fills its catalog once the network is back.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../observability/log.ts";
import { nimblebrainExtension } from "../../plugins/manifest.ts";
import {
  type CatalogIndex,
  indexCachePath,
  loadArchive,
  loadIndex,
  mapArchives,
  openArchive,
  type PinnedCatalogOptions,
  parseIndexBytes,
  pinnedIndexUrl,
  pluginServerDetailPath,
} from "../../plugins/pinned-catalog.ts";
import { sha256Hex } from "../../util/pinned-fetch.ts";
import {
  type CandidateGroup,
  type CatalogDiagnostic,
  type CatalogRead,
  validateServerCandidates,
} from "./read.ts";

/** How long a build that fell short is kept before a read builds again. */
export const RETRY_AFTER_MS = 60_000;

/** One build of the catalog from an index: every entry and diagnostic, and whether it is whole. */
export interface IndexCatalogBuild {
  read: CatalogRead;
  /** Built from the pinned index with every archive read; such a build never changes. */
  complete: boolean;
}

interface Kept {
  build: IndexCatalogBuild;
  expiresAt: number;
}

const kept = new Map<string, Kept>();
const inflight = new Map<string, Promise<IndexCatalogBuild>>();

/**
 * The catalog the pinned index carries, for `ConnectorCatalog`. Each read gets
 * its own copy of the entries. Only the diagnostics without an entry index (the
 * index or an archive that could not be read) are returned, since they explain
 * a missing catalog to the caller; the rest were logged when the build was made.
 * Never throws.
 */
export async function readIndexCatalog(opts: PinnedCatalogOptions): Promise<CatalogRead> {
  const { read } = await currentBuild(opts);
  return {
    entries: structuredClone(read.entries),
    diagnostics: read.diagnostics.filter((d) => d.index === undefined),
  };
}

/** Forget every build, so the next read builds again. Tests use it. */
export function resetIndexCatalog(): void {
  kept.clear();
  inflight.clear();
}

function currentBuild(opts: PinnedCatalogOptions): Promise<IndexCatalogBuild> {
  const key = `${opts.cacheDir}\n${opts.catalogUrl}\n${opts.pin}`;
  const held = kept.get(key);
  if (held && Date.now() < held.expiresAt) return Promise.resolve(held.build);
  let pending = inflight.get(key);
  if (!pending) {
    pending = buildIndexCatalog(opts).then((build) => {
      inflight.delete(key);
      kept.set(key, {
        build,
        expiresAt: build.complete ? Number.POSITIVE_INFINITY : Date.now() + RETRY_AFTER_MS,
      });
      for (const d of build.read.diagnostics) {
        if (d.index === undefined || d.collision) log.error(`[catalog] ${d.message}`);
        else log.warn(`[catalog] ${d.message}`);
      }
      return build;
    });
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * Build the catalog from the pinned index, or from the newest verified cached
 * index when the pinned one cannot be read. Never throws: every failure is a
 * diagnostic.
 */
export async function buildIndexCatalog(opts: PinnedCatalogOptions): Promise<IndexCatalogBuild> {
  try {
    return await build(opts);
  } catch (err) {
    const message = `the connector catalog could not be built from the plugin index: ${describe(err)}`;
    return {
      read: { entries: [], diagnostics: [{ source: opts.catalogUrl, message }] },
      complete: false,
    };
  }
}

async function build(opts: PinnedCatalogOptions): Promise<IndexCatalogBuild> {
  let index: CatalogIndex;
  let indexPin = opts.pin;
  let complete = true;
  try {
    index = await loadIndex(opts);
  } catch (err) {
    complete = false;
    const cached = newestCachedIndex(opts);
    if (!cached) {
      const message =
        `the plugin index pinned at ${opts.pin} is unavailable from ${opts.catalogUrl} ` +
        `(${describe(err)}) and none is cached; Browse is empty until it can be fetched`;
      return {
        read: { entries: [], diagnostics: [{ source: opts.catalogUrl, message }] },
        complete,
      };
    }
    log.warn(
      `[catalog] the plugin index pinned at ${opts.pin} is unavailable (${describe(err)}); ` +
        `reading the last verified index, ${cached.sha256}, until it is`,
    );
    index = cached.index;
    indexPin = cached.sha256;
  }

  const source = pinnedIndexUrl(opts.catalogUrl, indexPin);
  const archives = await mapArchives(index.plugins, (entry) =>
    loadArchive(entry, opts).then(
      (bytes) => ({ bytes }),
      (err: unknown) => ({ error: describe(err) as string }),
    ),
  );

  const diagnostics: CatalogDiagnostic[] = [];
  const groups: CandidateGroup[] = [];
  /**
   * Registry name → the plugin that named it first, reserved before its server
   * file is read, so a later plugin never supplies a server whose first owner's
   * file was skipped.
   */
  const claimed = new Map<string, string>();
  index.plugins.forEach((entry, i) => {
    const tag = `${source}[${i}:${entry.name}]`;
    const skip = (message: string, collision?: true) =>
      diagnostics.push({
        source,
        index: i,
        name: entry.name,
        message: `${tag} ${message}`,
        ...(collision ? { collision } : {}),
      });
    const archive = archives[i]!;
    if ("error" in archive) {
      complete = false;
      diagnostics.push({
        source: entry.url,
        message: `${tag} skipped — its archive could not be read: ${archive.error}`,
      });
      return;
    }
    let opened: ReturnType<typeof openArchive>;
    try {
      opened = openArchive(entry.name, archive.bytes);
    } catch (err) {
      skip(`skipped — ${describe(err)}`);
      return;
    }
    const { servers } = nimblebrainExtension(opened.manifest);
    for (const [key, registryName] of Object.entries(servers)) {
      const first = claimed.get(registryName);
      if (first !== undefined) {
        skip(
          `server "${registryName}" refused — plugin "${first}" already names it, and grants ` +
            "bind by server name, so only the first plugin's entry loads",
          true,
        );
        continue;
      }
      claimed.set(registryName, entry.name);
      const path = pluginServerDetailPath(key);
      const read = readServerFile(opened.files.get(path), path, registryName);
      if ("skip" in read) {
        skip(`server "${registryName}" skipped — ${read.skip}`);
        continue;
      }
      groups.push({ source: `${entry.name}:${path}`, candidates: [read.detail] });
    }
  });

  return { read: validateServerCandidates(groups, diagnostics), complete };
}

/** A plugin's server file, parsed, or why it is skipped: absent, not JSON, or naming another server. */
function readServerFile(
  bytes: Uint8Array | undefined,
  path: string,
  registryName: string,
): { detail: unknown } | { skip: string } {
  if (!bytes) return { skip: `the plugin carries no ${path}` };
  let detail: unknown;
  try {
    detail = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return { skip: `${path} is not valid JSON (${describe(err)})` };
  }
  const name = field(detail, "name");
  if (name !== registryName) {
    return {
      skip: `${path} names ${JSON.stringify(name ?? null)}, not the registry name the plugin gives it`,
    };
  }
  return { detail };
}

/** The newest verified index in the cache other than the pin, or null when there is none. */
function newestCachedIndex(
  opts: PinnedCatalogOptions,
): { sha256: string; index: CatalogIndex } | null {
  const dir = join(indexCachePath(opts.cacheDir, opts.pin), "..");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = names
    .map((name) => /^([0-9a-f]{64})\.json$/.exec(name)?.[1])
    .filter((sha): sha is string => sha !== undefined && sha !== opts.pin)
    .map((sha) => ({ sha, path: indexCachePath(opts.cacheDir, sha) }))
    .map((c) => ({ ...c, mtime: mtime(c.path) }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { sha, path } of candidates) {
    try {
      const bytes = readFileSync(path);
      if (sha256Hex(bytes) !== sha) continue;
      return { sha256: sha, index: parseIndexBytes(bytes) };
    } catch {}
  }
  return null;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
