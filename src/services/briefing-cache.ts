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

  get(): BriefingOutput | null {
    if (!this.entry) return null;
    if (this.entry.invalidated) return null;
    if (Date.now() - this.entry.generatedAt > this.ttlMs) return null;
    return { ...this.entry.briefing, cached: true };
  }

  /**
   * Return the last briefing even if it's past its TTL — but not if it was
   * explicitly invalidated, and not when there's none. For stale-while-
   * revalidate: serve this instantly while a fresh one regenerates in the
   * background, so a dashboard load never waits on the LLM after the first
   * generation.
   */
  getStale(): BriefingOutput | null {
    if (!this.entry) return null;
    if (this.entry.invalidated) return null;
    return { ...this.entry.briefing, cached: true };
  }

  set(briefing: BriefingOutput): void {
    this.entry = {
      briefing,
      generatedAt: Date.now(),
      invalidated: false,
    };
  }

  invalidate(): void {
    if (this.entry) {
      this.entry.invalidated = true;
    }
  }

  isStale(): boolean {
    return this.get() === null;
  }
}
