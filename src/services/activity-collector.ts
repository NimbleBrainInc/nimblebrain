import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SseEventManager } from "../api/events.ts";
import type { ConversationStore } from "../conversation/types.ts";
import type {
  ActivityBundleEvent,
  ActivityConversationSummary,
  ActivityInput,
  ActivityOutput,
  ErrorEntry,
  ToolUsageSummary,
} from "./home-types.ts";

/**
 * Collects activity data from three sources: conversation store, structured
 * logs, and the SSE event buffer. Returns a unified ActivityOutput snapshot
 * for the home dashboard.
 */
export class ActivityCollector {
  constructor(
    private logDir: string,
    private store: ConversationStore,
    private eventManager?: SseEventManager,
  ) {}

  async collect(input: ActivityInput = {}): Promise<ActivityOutput> {
    const now = new Date();
    const since = input.since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const until = input.until ?? now.toISOString();
    const limit = input.limit ?? 50;
    const category = input.category;

    const [conversations, bundleEvents, { toolUsage, errors }] = await Promise.all([
      !category || category === "conversations"
        ? this.collectConversations(since, until, limit)
        : Promise.resolve([]),
      !category || category === "bundles" ? this.collectBundleEvents(since) : Promise.resolve([]),
      !category || category === "tools" || category === "errors"
        ? this.collectFromLogs(since, until, limit, category)
        : Promise.resolve({
            toolUsage: [] as ToolUsageSummary[],
            errors: [] as ErrorEntry[],
          }),
    ]);

    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const t of toolUsage) {
      totalToolCalls += t.call_count;
    }
    for (const c of conversations) {
      totalInputTokens += c.input_tokens;
      totalOutputTokens += c.output_tokens;
    }

    return {
      period: { since, until },
      conversations,
      bundle_events: bundleEvents,
      tool_usage: toolUsage,
      errors,
      totals: {
        conversations: conversations.length,
        tool_calls: totalToolCalls,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        errors: errors.length,
      },
    };
  }

  private async collectConversations(
    since: string,
    until: string,
    limit: number,
  ): Promise<ActivityConversationSummary[]> {
    const result = await this.store.list({
      sortBy: "updatedAt",
      limit,
    });

    const summaries: ActivityConversationSummary[] = [];
    for (const c of result.conversations) {
      if (c.updatedAt < since || c.updatedAt > until) continue;
      summaries.push({
        id: c.id,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        message_count: c.messageCount,
        tool_call_count: 0,
        input_tokens: c.totalInputTokens,
        output_tokens: c.totalOutputTokens,
        preview: c.preview,
        had_errors: false,
      });
    }
    return summaries;
  }

  private collectBundleEvents(since: string): ActivityBundleEvent[] {
    if (!this.eventManager) return [];
    const events = this.eventManager.getEventsSince(since);
    const bundleEvents: ActivityBundleEvent[] = [];

    for (const e of events) {
      if (!e.event.startsWith("bundle.")) continue;
      const eventType = e.event.replace("bundle.", "") as ActivityBundleEvent["event"];
      if (!["installed", "uninstalled", "crashed", "recovered", "dead"].includes(eventType))
        continue;

      bundleEvents.push({
        bundle: (e.data.name as string) ?? (e.data.bundle as string) ?? "unknown",
        event: eventType,
        timestamp: e.timestamp,
        detail: (e.data.detail as string) ?? (e.data.reason as string) ?? undefined,
      });
    }
    return bundleEvents;
  }

  private async collectFromLogs(
    since: string,
    until: string,
    limit: number,
    category?: "tools" | "errors",
  ): Promise<{ toolUsage: ToolUsageSummary[]; errors: ErrorEntry[] }> {
    const lines = await this.readLogLines(since, until);

    const toolAgg = new Map<string, { count: number; errors: number; totalMs: number }>();
    const errors: ErrorEntry[] = [];

    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = record.ts as string | undefined;
      if (!ts || ts < since || ts > until) continue;

      const event = record.event as string | undefined;

      if (event === "run.done") {
        // Aggregate tool stats
        const toolStats = record.toolStats as
          | Record<string, { count: number; totalMs: number }>
          | undefined;
        if (toolStats) {
          for (const [name, stats] of Object.entries(toolStats)) {
            const existing = toolAgg.get(name);
            if (existing) {
              existing.count += stats.count;
              existing.totalMs += stats.totalMs;
            } else {
              toolAgg.set(name, {
                count: stats.count,
                errors: 0,
                totalMs: stats.totalMs,
              });
            }
          }
        }

        // Check for tool errors
        const toolErrors = record.toolErrors as number | undefined;
        if (toolErrors && toolErrors > 0) {
          errors.push({
            timestamp: ts,
            source: "tool",
            message: `${toolErrors} tool error(s) in run`,
            context: record.sid as string | undefined,
          });
        }
      }

      if (event === "run.error") {
        errors.push({
          timestamp: ts,
          source: "engine",
          message: (record.error as string) ?? (record.message as string) ?? "Unknown engine error",
          context: record.sid as string | undefined,
        });
      }

      if (event === "http.error") {
        errors.push({
          timestamp: ts,
          source: "http",
          message: `${record.status} ${record.error}: ${record.message}`,
          context: `${record.method} ${record.path}`,
        });
      }
    }

    const toolUsage: ToolUsageSummary[] = [];
    for (const [name, stats] of toolAgg) {
      toolUsage.push({
        tool: name,
        server: this.extractServer(name),
        call_count: stats.count,
        error_count: stats.errors,
        avg_latency_ms: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
      });
    }

    // Sort by call count descending, apply limit
    toolUsage.sort((a, b) => b.call_count - a.call_count);
    if (toolUsage.length > limit) toolUsage.length = limit;
    if (errors.length > limit) errors.length = limit;

    // Filter by sub-category if specified
    if (category === "tools") return { toolUsage, errors: [] };
    if (category === "errors") return { toolUsage: [], errors };
    return { toolUsage, errors };
  }

  private async readLogLines(since: string, until: string): Promise<string[]> {
    let filenames: string[];
    try {
      filenames = await readdir(this.logDir);
    } catch {
      return [];
    }

    // Determine date range for filenames
    const sinceDate = since.slice(0, 10);
    const untilDate = until.slice(0, 10);

    const relevant = filenames
      .filter((f) => {
        if (!f.startsWith("nimblebrain-") || !f.endsWith(".jsonl")) return false;
        const dateStr = f.slice("nimblebrain-".length, -".jsonl".length);
        return dateStr >= sinceDate && dateStr <= untilDate;
      })
      .sort();

    const allLines: string[] = [];
    for (const filename of relevant) {
      try {
        const content = await readFile(join(this.logDir, filename), "utf-8");
        for (const line of content.split("\n")) {
          if (line.trim()) allLines.push(line);
        }
      } catch {
        // Skip unreadable files
      }
    }
    return allLines;
  }

  /** Extract server/bundle name from a tool name like "server__toolName". */
  private extractServer(toolName: string): string {
    const idx = toolName.indexOf("__");
    return idx > 0 ? toolName.slice(0, idx) : "system";
  }
}
