import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BundleInstance } from "../bundles/types.ts";
import type { BriefingCacheEntry, BriefingOutput } from "./home-types.ts";

export class BriefingCache {
  private entry: BriefingCacheEntry | null = null;
  private ttlMs: number;
  private refreshing = false;

  constructor(ttlMinutes: number) {
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  /**
   * In-flight guard for stale-while-revalidate. `beginRefresh()` claims the
   * single background-regeneration slot — returns `true` for the first caller,
   * `false` while one is already running — so a burst of dashboard loads
   * during the regen window doesn't fan out into N concurrent (fast-model)
   * regenerations. Always pair a successful `beginRefresh()` with `endRefresh()`.
   */
  beginRefresh(): boolean {
    if (this.refreshing) return false;
    this.refreshing = true;
    return true;
  }

  endRefresh(): void {
    this.refreshing = false;
  }

  /**
   * Return the cached briefing, or null when there is no entry, the TTL has
   * expired, or `fingerprint` no longer matches the data the briefing was
   * built from. The fingerprint check is what keeps a briefing from
   * outliving the data it summarizes — see `computeBriefingFingerprint`.
   */
  get(fingerprint: string): BriefingOutput | null {
    if (!this.entry) return null;
    if (this.entry.fingerprint !== fingerprint) return null;
    if (Date.now() - this.entry.generatedAt > this.ttlMs) return null;
    return { ...this.entry.briefing, cached: true };
  }

  /**
   * Return the last briefing even when it's past its TTL or the data has moved
   * on — only `null` when there is no entry at all. For stale-while-revalidate:
   * serve this instantly while a fresh one regenerates in the background, so a
   * dashboard load never waits on the LLM after the first generation. The
   * fingerprint check lives in `get()`, not here — serving a briefly-stale
   * briefing during the regen window is the whole point of this path.
   */
  getStale(): BriefingOutput | null {
    if (!this.entry) return null;
    return { ...this.entry.briefing, cached: true };
  }

  set(briefing: BriefingOutput, fingerprint: string): void {
    this.entry = {
      briefing,
      generatedAt: Date.now(),
      fingerprint,
    };
  }
}

/**
 * Compute a fingerprint of the workspace data a briefing is built from:
 * activity logs plus each running bundle's entity data. The cache compares
 * it on every read — when the underlying data changes the fingerprint
 * changes, so a stale briefing is never served.
 *
 * This deliberately replaces tool-call-event invalidation: events can't
 * tell a read from a write, so app reads would invalidate the cache on
 * every interaction. A content fingerprint invalidates if and only if the
 * data actually changed.
 *
 * Facets sourced from MCP `resource`/`tool` calls rather than entity files
 * are not captured here — those changes fall back to the cache TTL.
 */
export function computeBriefingFingerprint(logDir: string, instances: BundleInstance[]): string {
  const parts: string[] = [`logs:${dirSignature(logDir)}`];
  const running = instances
    .filter((i) => i.state === "running")
    .sort((a, b) => a.bundleName.localeCompare(b.bundleName));
  for (const inst of running) {
    parts.push(`bundle:${inst.bundleName}`);
    if (inst.entityDataRoot) {
      parts.push(`data:${dirSignature(inst.entityDataRoot)}`);
    }
  }
  return parts.join("|");
}

/**
 * Compact signature of a directory tree — file count, newest mtime, and
 * total size. Catches additions, deletions, and content edits (any write
 * advances mtime). `"absent"` for a missing directory.
 */
function dirSignature(dir: string): string {
  if (!existsSync(dir)) return "absent";
  let count = 0;
  let newestMtimeMs = 0;
  let totalSize = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const stat = statSync(full);
      count++;
      totalSize += stat.size;
      if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
    }
  };
  walk(dir);
  return `${count}:${newestMtimeMs}:${totalSize}`;
}
