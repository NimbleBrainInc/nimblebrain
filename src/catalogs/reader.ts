/**
 * The one AI Catalog reader (ADR-0077): each configured catalog's listing,
 * read, verified, validated, cached and refreshed. Browse reads what this
 * holds and nothing else; no artifact is ever opened here.
 *
 * Per catalog:
 *
 * - **Read.** A URL source is fetched over TLS through the bounded fetch
 *   (`src/util/pinned-fetch.ts`); a path source reads its file, or the
 *   `ai-catalog.json` (else `.well-known/ai-catalog.json`) in its directory.
 * - **Pinned when it has `sha256`.** Bytes are used only when their sha256 is
 *   the pin, and a pinned listing that was read once is never read again, since
 *   its bytes cannot change.
 * - **Validated** by `parseListing`: a document that is not an AI Catalog is
 *   refused whole; a bad entry is dropped and logged.
 * - **Cached.** The last good copy is kept in the work directory, so a restart
 *   needs no network.
 * - **Refreshed.** An unpinned listing is read again once its interval has
 *   passed: in the background when a good copy is in memory, so Browse never
 *   waits on a refresh, and before answering when there is none.
 * - **Never fatal.** When a read fails, the copy in memory is kept, else the
 *   cached copy is read, else the catalog lists nothing and the error says why.
 *   A failed read is retried after `RETRY_AFTER_MS` (or the interval, if
 *   shorter).
 *
 * Across catalogs, **one connection name is one server.** A server's
 * connection is its registry name slugified (`slugifyServerName`), so two
 * different registry names that slugify to one connection would install into
 * one another's connection. The entry that names the later of them, in
 * configuration order and then listing order, is dropped with a diagnostic on
 * its catalog's snapshot ({@link refuseConnectionCollisions}). The same name
 * from two catalogs is one server listed twice, not a collision.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedCatalog } from "../config/catalogs.ts";
import { slugifyServerName } from "../connectors/runtime/paths.ts";
import { log } from "../observability/log.ts";
import { fetchBounded, sha256Hex } from "../util/pinned-fetch.ts";
import {
  type ListedEntry,
  type ListingDiagnostic,
  ListingDocumentError,
  parseListing,
} from "./listing.ts";

/** The most bytes read for one listing, far above any real catalog's. */
export const MAX_LISTING_BYTES = 8 * 1024 * 1024;

/** How long a failed read is remembered before the next one. */
export const RETRY_AFTER_MS = 60_000;

/** The files a directory source is read from, in order. */
export const LISTING_FILES_IN_DIR = ["ai-catalog.json", ".well-known/ai-catalog.json"];

/** One catalog's listing as the reader holds it. */
export interface CatalogSnapshot {
  catalog: ResolvedCatalog;
  /** The valid entries; empty when nothing could be read. */
  entries: ListedEntry[];
  /** Where `entries` came from: a read of the source, the work-directory cache, or nowhere. */
  origin: "source" | "cache" | "none";
  /** Why the last read failed, when it did. */
  error?: string;
  /** Entries the listing in use dropped. */
  diagnostics: ListingDiagnostic[];
  /** sha256 of the listing bytes in use. */
  sha256?: string;
}

export interface CatalogListingsOptions {
  catalogs: ResolvedCatalog[];
  /** Where last good copies are kept (`{workDir}/cache/catalogs`). */
  cacheDir: string;
  /** Injectable fetch; tests pass a fixture. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). */
  now?: () => number;
  /** Per-request timeout (ms). Default 10000. */
  timeoutMs?: number;
}

export interface CatalogListings {
  /** The configured catalogs, in configuration order. */
  catalogs(): ResolvedCatalog[];
  /** Every catalog's listing, reading those never read or due a refresh. Never throws. */
  snapshots(): Promise<CatalogSnapshot[]>;
  /** Read every unpinned catalog again now, and any catalog that has no good copy. */
  refresh(): Promise<CatalogSnapshot[]>;
}

interface State {
  snapshot: CatalogSnapshot | null;
  nextReadAt: number;
  inflight: Promise<CatalogSnapshot> | null;
}

/** The reader over `opts.catalogs`. Reads nothing until asked. */
export function createCatalogListings(opts: CatalogListingsOptions): CatalogListings {
  const now = opts.now ?? Date.now;
  const states = new Map<ResolvedCatalog, State>(
    opts.catalogs.map((c) => [c, { snapshot: null, nextReadAt: 0, inflight: null }]),
  );

  const read = (catalog: ResolvedCatalog, state: State): Promise<CatalogSnapshot> => {
    if (!state.inflight) {
      state.inflight = readCatalog(catalog, state.snapshot, opts, now).then((next) => {
        state.snapshot = next.snapshot;
        state.nextReadAt = next.nextReadAt;
        state.inflight = null;
        return next.snapshot;
      });
    }
    return state.inflight;
  };

  const one = async (catalog: ResolvedCatalog): Promise<CatalogSnapshot> => {
    const state = states.get(catalog) as State;
    const current = state.snapshot;
    if (current === null) return read(catalog, state);
    if (now() < state.nextReadAt) return current;
    // Nothing to show yet: wait for the read. A good copy: show it, refresh behind it.
    if (current.origin === "none") return read(catalog, state);
    void read(catalog, state);
    return current;
  };

  // The last read's snapshots and what the collision pass made of them, so a
  // caller gets the same objects until a catalog's snapshot changes.
  let last: { read: CatalogSnapshot[]; out: CatalogSnapshot[] } | null = null;
  const snapshots = async (): Promise<CatalogSnapshot[]> => {
    const read = await Promise.all(opts.catalogs.map((c) => one(c)));
    if (last && read.length === last.read.length && read.every((s, i) => s === last?.read[i])) {
      return last.out;
    }
    const out = refuseConnectionCollisions(read);
    last = { read, out };
    return out;
  };

  return {
    catalogs: () => [...opts.catalogs],
    snapshots,
    refresh: async () => {
      await Promise.all(
        opts.catalogs.map((c) => {
          const state = states.get(c) as State;
          const pinnedAndRead = c.sha256 !== undefined && state.snapshot?.origin === "source";
          return pinnedAndRead ? state.snapshot : read(c, state);
        }),
      );
      return opts.catalogs.map((c) => (states.get(c) as State).snapshot as CatalogSnapshot);
    },
  };
}

/** A reader with no catalogs, for a runtime that offers nothing to install. */
export function noCatalogListings(): CatalogListings {
  return createCatalogListings({ catalogs: [], cacheDir: "" });
}

async function readCatalog(
  catalog: ResolvedCatalog,
  previous: CatalogSnapshot | null,
  opts: CatalogListingsOptions,
  now: () => number,
): Promise<{ snapshot: CatalogSnapshot; nextReadAt: number }> {
  const cacheFile = join(opts.cacheDir, cacheKey(catalog), "listing.json");
  try {
    const bytes = await readSource(catalog, opts);
    const sha256 = sha256Hex(bytes);
    if (catalog.sha256 && sha256 !== catalog.sha256) {
      throw new Error(
        `the listing does not match its pin (got ${sha256}, expected ${catalog.sha256})`,
      );
    }
    const parsed = parseListing(catalog.name, bytes);
    if (previous?.sha256 !== sha256) reportDiagnostics(catalog, parsed.diagnostics);
    writeCache(cacheFile, bytes);
    return {
      snapshot: { catalog, ...parsed, origin: "source", sha256 },
      nextReadAt: catalog.sha256 ? Number.POSITIVE_INFINITY : now() + catalog.refreshMs,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const nextReadAt = now() + Math.min(catalog.refreshMs, RETRY_AFTER_MS);
    return { snapshot: fallback(catalog, previous, cacheFile, error), nextReadAt };
  }
}

/** The copy to use after a failed read: the one in memory, else the cache, else none. */
function fallback(
  catalog: ResolvedCatalog,
  previous: CatalogSnapshot | null,
  cacheFile: string,
  error: string,
): CatalogSnapshot {
  const tag = `[catalogs] catalog "${catalog.name}" (${catalog.label})`;
  if (previous && previous.origin !== "none") {
    log.warn(`${tag} could not be read (${error}); keeping the copy read before`);
    return { ...previous, error };
  }
  const cached = readCache(catalog, cacheFile);
  if (cached) {
    log.warn(`${tag} could not be read (${error}); reading its last good copy, ${cached.sha256}`);
    reportDiagnostics(catalog, cached.diagnostics);
    return { catalog, ...cached, origin: "cache", error };
  }
  log.error(
    `${tag} could not be read (${error}) and none is cached; it lists nothing until it can be`,
  );
  return { catalog, entries: [], diagnostics: [], origin: "none", error };
}

async function readSource(
  catalog: ResolvedCatalog,
  opts: CatalogListingsOptions,
): Promise<Uint8Array> {
  if (catalog.source.kind === "url") {
    return fetchBounded(catalog.source.url, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxBytes: MAX_LISTING_BYTES,
    });
  }
  const file = listingFile(catalog.source.path);
  const size = statSync(file).size;
  if (size > MAX_LISTING_BYTES) throw new Error(`${file} exceeds ${MAX_LISTING_BYTES} bytes`);
  return readFileSync(file);
}

/** The listing file a path source names: itself, or the first listing file in its directory. */
export function listingFile(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  if (!statSync(path).isDirectory()) return path;
  for (const name of LISTING_FILES_IN_DIR) {
    const file = join(path, name);
    if (existsSync(file)) return file;
  }
  throw new Error(`${path} holds no ${LISTING_FILES_IN_DIR.join(" or ")}`);
}

function readCache(
  catalog: ResolvedCatalog,
  file: string,
): { entries: ListedEntry[]; diagnostics: ListingDiagnostic[]; sha256: string } | null {
  try {
    if (!existsSync(file)) return null;
    const bytes = readFileSync(file);
    const sha256 = sha256Hex(bytes);
    if (catalog.sha256 && sha256 !== catalog.sha256) return null;
    return { ...parseListing(catalog.name, bytes), sha256 };
  } catch (err) {
    if (!(err instanceof ListingDocumentError)) {
      log.warn(`[catalogs] the cached copy at ${file} cannot be read: ${String(err)}`);
    }
    return null;
  }
}

function reportDiagnostics(catalog: ResolvedCatalog, diagnostics: ListingDiagnostic[]): void {
  for (const d of diagnostics) {
    const at = d.index === undefined ? "" : ` ${d.index}`;
    log.warn(
      `[catalogs] catalog "${catalog.name}" entry${at}${d.identifier ? ` (${d.identifier})` : ""} dropped: ${d.message}`,
    );
  }
}

/** Every registry name an entry lists: its extension's servers, or a bare connector's record. */
function namesOf(entry: ListedEntry): string[] {
  const names = Object.values(entry.servers).map((s) => s.name);
  const data = entry.data as { name?: unknown } | undefined;
  if (typeof data?.name === "string" && !names.includes(data.name)) names.push(data.name);
  return names;
}

/**
 * Drop each entry that names a server whose connection an earlier entry's
 * different server already takes, in configuration then listing order, with a
 * diagnostic on its snapshot. Snapshots with nothing dropped are returned as
 * they are.
 */
export function refuseConnectionCollisions(snapshots: CatalogSnapshot[]): CatalogSnapshot[] {
  const taken = new Map<string, { name: string; address: string }>();
  return snapshots.map((snapshot) => {
    const kept: ListedEntry[] = [];
    const dropped: ListingDiagnostic[] = [];
    for (const entry of snapshot.entries) {
      const clash = namesOf(entry)
        .map((name) => ({ name, prior: taken.get(slugifyServerName(name)) }))
        .find(({ name, prior }) => prior && prior.name !== name);
      if (clash?.prior) {
        dropped.push({
          identifier: entry.identifier,
          message: `its server "${clash.name}" takes connection "${slugifyServerName(clash.name)}", which "${clash.prior.name}" (${clash.prior.address}) already takes`,
        });
        continue;
      }
      for (const name of namesOf(entry)) {
        const key = slugifyServerName(name);
        if (!taken.has(key)) taken.set(key, { name, address: entry.address });
      }
      kept.push(entry);
    }
    if (dropped.length === 0) return snapshot;
    reportDiagnostics(snapshot.catalog, dropped);
    return { ...snapshot, entries: kept, diagnostics: [...snapshot.diagnostics, ...dropped] };
  });
}

/** A catalog's cache directory name: a digest of its source, so a rename keeps its copy. */
function cacheKey(catalog: ResolvedCatalog): string {
  const source = catalog.source.kind === "url" ? catalog.source.url : catalog.source.path;
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/** Write through a temporary file, so a reader never sees a partial copy. Best-effort. */
function writeCache(path: string, bytes: Uint8Array): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (err) {
    log.warn(`[catalogs] the listing could not be cached at ${path}: ${String(err)}`);
  }
}
