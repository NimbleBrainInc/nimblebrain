import type { BriefingCacheEntry, BriefingOutput } from "./home-types.ts";

export class BriefingCache {
  private entry: BriefingCacheEntry | null = null;
  private ttlMs: number;

  constructor(ttlMinutes = 30) {
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  get(): BriefingOutput | null {
    if (!this.entry) return null;
    if (this.entry.invalidated) return null;
    if (Date.now() - this.entry.generatedAt > this.ttlMs) return null;
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

/**
 * Cache a briefing only when it represents a successful generation.
 * Degraded briefings (heuristic fallback after LLM failure) carry
 * `degraded: true` — caching them would pin the canned response for
 * the whole TTL window even after the model recovers, so we skip.
 *
 * Extracted as a named helper so the contract is explicit at the
 * call site and locked by a single unit test rather than a verbal
 * convention in `core-source.ts`.
 */
export function maybeCacheBriefing(cache: BriefingCache, briefing: BriefingOutput): void {
  if (briefing.degraded) return;
  cache.set(briefing);
}
