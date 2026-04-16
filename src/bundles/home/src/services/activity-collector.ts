import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ActivityBundleEvent,
  ActivityConversationSummary,
  ActivityInput,
  ActivityOutput,
  AutomationRunSummary,
  ErrorEntry,
  ToolUsageSummary,
} from "./types.ts";

/**
 * Collects activity data from conversation JSONL files, structured logs,
 * and automation run history.
 * Bundle event collection is not available in standalone mode (returns empty).
 */
export class ActivityCollector {
  private automationRunsDir: string;

  constructor(
    private logDir: string,
    private conversationsDir: string,
    workDir: string,
  ) {
    this.automationRunsDir = join(workDir, "automations", "runs");
  }

  async collect(input: ActivityInput = {}): Promise<ActivityOutput> {
    const now = new Date();
    const since = input.since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const until = input.until ?? now.toISOString();
    const limit = input.limit ?? 50;
    const category = input.category;

    const [conversations, bundleEvents, { toolUsage, errors }, automations] = await Promise.all([
      !category || category === "conversations"
        ? this.collectConversations(since, until, limit)
        : Promise.resolve([]),
      !category || category === "bundles" ? this.collectBundleEvents() : Promise.resolve([]),
      !category || category === "tools" || category === "errors"
        ? this.collectFromLogs(since, until, limit, category)
        : Promise.resolve({
            toolUsage: [] as ToolUsageSummary[],
            errors: [] as ErrorEntry[],
          }),
      this.collectAutomationRuns(since, until),
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

    const output: ActivityOutput = {
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

    if (automations) {
      output.automations = automations;
    }

    return output;
  }

  private async collectConversations(
    since: string,
    until: string,
    limit: number,
  ): Promise<ActivityConversationSummary[]> {
    let filenames: string[];
    try {
      filenames = await readdir(this.conversationsDir);
    } catch {
      return [];
    }

    const jsonlFiles = filenames.filter((f) => f.endsWith(".jsonl")).sort();
    const summaries: ActivityConversationSummary[] = [];

    for (const filename of jsonlFiles) {
      if (summaries.length >= limit) break;

      try {
        const content = await readFile(join(this.conversationsDir, filename), "utf-8");
        const firstNewline = content.indexOf("\n");
        const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
        if (!firstLine.trim()) continue;

        const meta = JSON.parse(firstLine) as Record<string, unknown>;

        const updatedAt = (meta.updatedAt as string) ?? "";
        if (updatedAt < since || updatedAt > until) continue;

        summaries.push({
          id: (meta.id as string) ?? filename.replace(".jsonl", ""),
          created_at: (meta.createdAt as string) ?? "",
          updated_at: updatedAt,
          message_count: (meta.messageCount as number) ?? 0,
          tool_call_count: 0,
          input_tokens: (meta.totalInputTokens as number) ?? 0,
          output_tokens: (meta.totalOutputTokens as number) ?? 0,
          preview: (meta.preview as string) ?? "",
          had_errors: false,
        });
      } catch {
        // Skip unreadable files
      }
    }

    // Sort by updated_at descending
    summaries.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
    return summaries;
  }

  /**
   * Bundle event collection is not available in standalone mode.
   * Returns an empty array (no SseEventManager access).
   */
  private collectBundleEvents(): ActivityBundleEvent[] {
    return [];
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

  /**
   * Read automation run JSONL files and summarize runs in the given time window.
   * Returns null if the runs directory doesn't exist (no automation section).
   * Corrupted JSONL lines are silently skipped.
   */
  private async collectAutomationRuns(
    since: string,
    until: string,
  ): Promise<AutomationRunSummary | null> {
    let filenames: string[];
    try {
      filenames = await readdir(this.automationRunsDir);
    } catch {
      return null;
    }

    const jsonlFiles = filenames.filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) return null;

    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();

    let total = 0;
    let succeeded = 0;
    let failed = 0;
    const failures: AutomationRunSummary["failures"] = [];

    for (const filename of jsonlFiles) {
      try {
        const content = await readFile(join(this.automationRunsDir, filename), "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;

          let run: Record<string, unknown>;
          try {
            run = JSON.parse(line);
          } catch {
            continue; // Skip corrupted lines
          }

          const startedAt = run.startedAt as string | undefined;
          if (!startedAt) continue;

          const startedMs = new Date(startedAt).getTime();
          if (startedMs < sinceMs || startedMs > untilMs) continue;

          const status = run.status as string | undefined;
          // Only count completed runs (skip "running" or "cancelled")
          if (status !== "success" && status !== "failure" && status !== "timeout") continue;

          total++;

          if (status === "success") {
            succeeded++;
          } else {
            failed++;
            // Derive automation name from filename (e.g., "daily-check.jsonl" → "daily-check")
            const automationName = filename.replace(/\.jsonl$/, "");
            failures.push({
              name: automationName,
              error: (run.error as string) ?? undefined,
              action: {
                label: "View failed run",
                type: "chat",
                value: `Show me the failed ${automationName} automation run`,
              },
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (total === 0) return null;

    return { total, succeeded, failed, failures };
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
