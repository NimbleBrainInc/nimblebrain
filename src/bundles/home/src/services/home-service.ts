import { createHash } from "node:crypto";
import type { ActivityCollector } from "./activity-collector.ts";
import type { BriefingCache } from "./briefing-cache.ts";
import type { BriefingGenerator } from "./briefing-generator.ts";
import type { ActivityInput, ActivityOutput, BriefingInput, BriefingOutput } from "./types.ts";

export class HomeService {
  constructor(
    private collector: ActivityCollector,
    private generator: BriefingGenerator,
    private cache: BriefingCache,
  ) {}

  async getBriefing(input: BriefingInput = {}): Promise<BriefingOutput> {
    // Check cache first
    if (!input.force_refresh) {
      const cached = this.cache.get();
      if (cached) return cached;
    }

    // Collect activity and generate briefing
    const activity = await this.collector.collect({
      since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const briefing = await this.generator.generate(activity);

    // Cache the result
    const hash = createHash("md5").update(JSON.stringify(activity.totals)).digest("hex");
    this.cache.set(briefing, hash);

    return briefing;
  }

  async getActivity(input: ActivityInput = {}): Promise<ActivityOutput> {
    // Apply defaults
    const defaults: ActivityInput = {
      since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      until: new Date().toISOString(),
      limit: 50,
    };
    return this.collector.collect({ ...defaults, ...input });
  }
}
