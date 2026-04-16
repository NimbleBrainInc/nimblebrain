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

  set(briefing: BriefingOutput, activityHash: string): void {
    this.entry = {
      briefing,
      generatedAt: Date.now(),
      activityHash,
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
