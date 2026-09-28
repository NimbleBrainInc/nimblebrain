/**
 * Per-facet count cache for the workspace briefing.
 *
 * One entry per `(workspaceId, serverName, facetName)`, holding the count and
 * when it was read. A facet answers for the workspace over the workspace's own
 * connection, so nothing about the member who asked enters the key or the
 * entry, and one read serves every member.
 *
 * - Fresh for {@link FACET_FRESH_MS}: served without a read.
 * - Stale up to {@link FACET_STALE_CEILING_MS}: served while one background
 *   refresh runs.
 * - Beyond that, or never read: the caller waits for the read, and a failed
 *   read is `unavailable`.
 *
 * Reads are single-flight per key: concurrent loads share one `resources/read`.
 */

export const FACET_FRESH_MS = 60_000;
export const FACET_STALE_CEILING_MS = 10 * 60_000;

/** The facet a cache entry answers for. */
export interface FacetKey {
  workspaceId: string;
  serverName: string;
  facetName: string;
}

export interface FacetCacheEntry {
  count: number;
  /** Epoch ms of the read that produced `count`. */
  at: number;
}

export type FacetReading = { state: "ok"; count: number } | { state: "unavailable" };

export interface FacetCache {
  /**
   * The facet's count, from the cache or from `fetch`. `fetch` returns the
   * count or throws; a throw never escapes, it reads as `unavailable` (or,
   * inside the stale window, leaves the stale count in place). `force` skips a
   * fresh or stale entry and waits for a read.
   */
  read(
    key: FacetKey,
    fetch: () => Promise<number>,
    opts?: { force?: boolean },
  ): Promise<FacetReading>;
  /** Current entries by encoded key, for inspection. */
  entries(): ReadonlyMap<string, Readonly<FacetCacheEntry>>;
}

/**
 * Encode a key. Workspace ids (`ws_[a-z0-9_]+`) and server names hold no NUL,
 * so no two triples collide.
 */
export function facetCacheKey(key: FacetKey): string {
  return `${key.workspaceId}\0${key.serverName}\0${key.facetName}`;
}

export function createFacetCache(now: () => number = Date.now): FacetCache {
  const entries = new Map<string, FacetCacheEntry>();
  const inflight = new Map<string, Promise<number>>();

  const refresh = (k: string, fetch: () => Promise<number>): Promise<number> => {
    const running = inflight.get(k);
    if (running) return running;
    const pending = fetch()
      .then((count) => {
        entries.set(k, { count, at: now() });
        return count;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, pending);
    return pending;
  };

  return {
    async read(key, fetch, opts) {
      const k = facetCacheKey(key);
      const entry = entries.get(k);
      if (entry && !opts?.force) {
        const age = now() - entry.at;
        if (age < FACET_FRESH_MS) return { state: "ok", count: entry.count };
        if (age <= FACET_STALE_CEILING_MS) {
          // The fetch logs its own failure; the stale count stays until the ceiling.
          refresh(k, fetch).catch(() => {});
          return { state: "ok", count: entry.count };
        }
      }
      try {
        return { state: "ok", count: await refresh(k, fetch) };
      } catch {
        return { state: "unavailable" };
      }
    },
    entries: () => entries,
  };
}
