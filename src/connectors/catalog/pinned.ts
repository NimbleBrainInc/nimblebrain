/**
 * The connector list from the pinned plugin catalog (ADR-0068): the file Browse
 * lists when no catalog directory is mounted.
 *
 * The catalog writes its connector list, `{servers: [ServerDetail, ...]}`, as
 * `nimblebrain/connectors.yaml`. The runtime reads it pinned by sha256
 * (`NB_PLUGIN_CATALOG_CONNECTORS_SHA256`), the same way it reads the index its
 * connector skills come from:
 *
 * - **Pinned.** Bytes are used only when their sha256 is the pin. The list is
 *   asked for at `nimblebrain/connectors/<sha256>.yaml`, a copy kept for good,
 *   and then at `nimblebrain/connectors.yaml`, which serves the catalog's
 *   current build; either is refused unless it matches.
 * - **Cached on disk.** A verified list is kept in the work directory under its
 *   sha256 and checked again on every read, so a restart needs no network and
 *   one fetch serves every workspace.
 * - **Never fatal.** When the pinned list cannot be fetched or does not match,
 *   the newest verified list in the cache is read instead, with a warning naming
 *   its digest; with none, the catalog is empty and the error says why. A failed
 *   fetch is retried on a read after `RETRY_AFTER_MS`, so a runtime that booted
 *   offline fills its catalog once the network is back, with no restart. A
 *   pinned list never changes, so a verified one is never fetched again.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "../../observability/log.ts";
import { CatalogHttpError, fetchBounded, sha256Hex } from "../../util/pinned-fetch.ts";

export interface PinnedConnectorsOptions {
  /** The plugin catalog cache (`{workDir}/cache/plugin-catalog`); the list sits in `connectors/`. */
  cacheDir: string;
  /** Catalog base URL, no trailing slash. */
  catalogUrl: string;
  /** sha256 of the connector list. */
  sha256: string;
  /** Injectable fetch; tests pass a fixture. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 10000. */
  timeoutMs?: number;
}

/** Where a catalog read finds its file, or why there is none. */
export type CatalogFile = { path: string } | { source: string; error: string };

/** How long a failed fetch is remembered before a read tries again. */
export const RETRY_AFTER_MS = 60_000;

/** The most bytes read for a connector list, far above any real catalog's. */
export const MAX_CONNECTORS_BYTES = 8 * 1024 * 1024;

/** The URLs the pinned list is asked for, in order: the kept copy, then the current build. */
export function pinnedConnectorsUrls(catalogUrl: string, sha256: string): string[] {
  return [
    `${catalogUrl}/nimblebrain/connectors/${sha256}.yaml`,
    `${catalogUrl}/nimblebrain/connectors.yaml`,
  ];
}

interface Attempt {
  result: Promise<CatalogFile>;
  /** Set once the attempt has failed: when it may be tried again. */
  retryAt?: number;
}

/** In-flight and recently failed fetches, keyed by cache file and catalog, shared by every read. */
const attempts = new Map<string, Attempt>();

/**
 * The verified connector list for `opts.sha256`, as a file to read: the cached
 * copy, else a fresh fetch, else the newest verified copy of another pin.
 * Never throws.
 */
export async function loadPinnedConnectors(opts: PinnedConnectorsOptions): Promise<CatalogFile> {
  const dir = join(opts.cacheDir, "connectors");
  const path = join(dir, `${opts.sha256}.yaml`);
  if (verified(path, opts.sha256)) return { path };

  const key = `${path}\n${opts.catalogUrl}`;
  const prior = attempts.get(key);
  if (prior && (prior.retryAt === undefined || Date.now() < prior.retryAt)) return prior.result;

  const attempt: Attempt = { result: Promise.resolve({ path }) };
  attempt.result = fetchPinned(opts, path).then((failure) => {
    if (failure === null) {
      attempts.delete(key);
      return { path };
    }
    attempt.retryAt = Date.now() + RETRY_AFTER_MS;
    return fallback(dir, opts, failure);
  });
  attempts.set(key, attempt);
  return attempt.result;
}

/** Forget remembered failures, so the next read fetches again. Tests use it. */
export function resetPinnedConnectorAttempts(): void {
  attempts.clear();
}

/** Fetch the pinned list into `path`. Returns null on success, else why it failed. */
async function fetchPinned(opts: PinnedConnectorsOptions, path: string): Promise<string | null> {
  const failures: string[] = [];
  for (const url of pinnedConnectorsUrls(opts.catalogUrl, opts.sha256)) {
    let bytes: Uint8Array;
    try {
      bytes = await fetchBounded(url, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs ?? 10_000,
        maxBytes: MAX_CONNECTORS_BYTES,
      });
    } catch (err) {
      // A 404 is a catalog that does not keep that copy; anything else is worth naming.
      if (!(err instanceof CatalogHttpError && err.status === 404)) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== opts.sha256) {
      failures.push(`${url} does not match the pin (got ${actual}, expected ${opts.sha256})`);
      continue;
    }
    writeAtomic(path, bytes);
    return null;
  }
  return failures.length > 0
    ? failures.join("; ")
    : `the catalog at ${opts.catalogUrl} serves no connector list`;
}

/** The newest verified list of any pin in the cache, or the error when there is none. */
function fallback(dir: string, opts: PinnedConnectorsOptions, failure: string): CatalogFile {
  const cached = newestVerified(dir);
  if (cached) {
    log.warn(
      `[catalog] the connector list pinned at ${opts.sha256} is unavailable (${failure}); ` +
        `reading the last verified list, ${cached.sha256}, until it is`,
    );
    return { path: cached.path };
  }
  const error =
    `the connector list pinned at ${opts.sha256} is unavailable from ${opts.catalogUrl} ` +
    `(${failure}) and none is cached`;
  log.error(`[catalog] ${error}; Browse is empty until it can be fetched`);
  return { source: opts.catalogUrl, error };
}

function newestVerified(dir: string): { path: string; sha256: string } | null {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .map((name) => /^([0-9a-f]{64})\.yaml$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ path: join(dir, m[0]), sha256: m[1]! }))
    .filter((c) => verified(c.path, c.sha256))
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
  return candidates[0] ?? null;
}

function verified(path: string, sha256: string): boolean {
  try {
    return sha256Hex(readFileSync(path)) === sha256;
  } catch {
    return false;
  }
}

/** Write through a temporary file, so a reader never sees a partial list. */
function writeAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);
}
