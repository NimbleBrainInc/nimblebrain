import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SseEventManager } from "../api/events.ts";
import type { ConversationAccessContext, ConversationStore } from "../conversation/types.ts";
import type {
  ActivityBundleEvent,
  ActivityConversationSummary,
  ActivityInput,
  ActivityOutput,
  AutomationRunSummary,
  ErrorEntry,
  ToolUsageSummary,
} from "./home-types.ts";

type ConversationSource =
  | { kind: "store"; store: Pick<ConversationStore, "list"> }
  | { kind: "jsonl"; conversationsDir: string };

type BundleEventSource = { kind: "sse"; eventManager: SseEventManager } | { kind: "none" };

export interface ActivityCollectorOptions {
  logDir: string;
  conversations: ConversationSource;
  bundleEvents?: BundleEventSource;
  automationRunsDir?: string;
  /**
   * Caller's identity context for ownership filtering. REQUIRED for
   * in-process callers post-Stage 1 — the top-level conversation
   * store holds every user's conversations, so an unfiltered
   * `store.list()` would leak peer conversations into the activity
   * summary. Omit only for trusted internal callers operating outside
   * a request context (e.g. CLI background tasks); the standalone
   * home bundle server uses the `jsonl` source and gets workspace
   * isolation from the file layout it sees.
   */
  access?: ConversationAccessContext;
}

/**
 * Unified activity collector for both runtime modes.
 *
 * In-process platform callers use the ConversationStore-backed source.
 * The standalone home bundle server uses the JSONL-backed source because it
 * runs outside Runtime and only has access to workspace files.
 */
export class ActivityCollector {
  private logDir: string;
  private conversations: ConversationSource;
  private bundleEvents: BundleEventSource;
  private automationRunsDir?: string;
  private access?: ConversationAccessContext;

  constructor(options: ActivityCollectorOptions) {
    this.logDir = options.logDir;
    this.conversations = options.conversations;
    this.bundleEvents = options.bundleEvents ?? { kind: "none" };
    this.automationRunsDir = options.automationRunsDir;
    this.access = options.access;
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
      !category || category === "bundles" ? this.collectBundleEvents(since) : Promise.resolve([]),
      !category || category === "tools" || category === "errors"
        ? this.collectFromLogs(since, until, limit, category)
        : Promise.resolve({
            toolUsage: [] as ToolUsageSummary[],
            errors: [] as ErrorEntry[],
          }),
      !category && this.automationRunsDir
        ? this.collectAutomationRuns(since, until)
        : Promise.resolve(null),
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
    const source = this.conversations;
    if (source.kind === "jsonl") {
      return this.collectConversationsFromJsonl(source.conversationsDir, since, until, limit);
    }

    return this.collectConversationsFromStore(source.store, since, until, limit);
  }

  private async collectConversationsFromStore(
    store: Pick<ConversationStore, "list">,
    since: string,
    until: string,
    limit: number,
  ): Promise<ActivityConversationSummary[]> {
    const result = await store.list(
      {
        sortBy: "updatedAt",
        limit,
      },
      // Ownership filter — the top-level store holds every user's
      // conversations; without this every caller would see peer
      // activity. `undefined` keeps the legacy "trusted scope"
      // behavior for callers that haven't been migrated yet.
      this.access,
    );

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

  private async collectConversationsFromJsonl(
    conversationsDir: string,
    since: string,
    until: string,
    limit: number,
  ): Promise<ActivityConversationSummary[]> {
    let filenames: string[];
    try {
      filenames = await readdir(conversationsDir);
    } catch {
      return [];
    }

    const jsonlFiles = filenames.filter((f) => f.endsWith(".jsonl")).sort();
    const summaries: ActivityConversationSummary[] = [];

    for (const filename of jsonlFiles) {
      if (summaries.length >= limit) break;

      try {
        const content = await readFile(join(conversationsDir, filename), "utf-8");
        const summary = summarizeJsonlConversation(content, filename, since, until);
        if (summary) summaries.push(summary);
      } catch {
        // Skip unreadable or malformed conversation files.
      }
    }

    summaries.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
    return summaries;
  }

  private collectBundleEvents(since: string): ActivityBundleEvent[] {
    if (this.bundleEvents.kind !== "sse") return [];
    const events = this.bundleEvents.eventManager.getEventsSince(since);
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

  private async collectAutomationRuns(
    since: string,
    until: string,
  ): Promise<AutomationRunSummary | null> {
    const dir = this.automationRunsDir;
    if (!dir) return null;

    let filenames: string[];
    try {
      filenames = await readdir(dir);
    } catch {
      return null;
    }

    const jsonlFiles = filenames.filter((f) => f.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) return null;

    const sinceMs = new Date(since).getTime();
    const untilMs = new Date(until).getTime();

    const totals: AutomationRunTotals = { total: 0, succeeded: 0, failed: 0, failures: [] };
    for (const filename of jsonlFiles) {
      await accumulateAutomationRunFile(dir, filename, sinceMs, untilMs, totals);
    }

    if (totals.total === 0) return null;
    return {
      total: totals.total,
      succeeded: totals.succeeded,
      failed: totals.failed,
      failures: totals.failures,
    };
  }

  private async collectFromLogs(
    since: string,
    until: string,
    limit: number,
    category?: "tools" | "errors",
  ): Promise<{ toolUsage: ToolUsageSummary[]; errors: ErrorEntry[] }> {
    const lines = await this.readLogLines(since, until);

    const toolAgg = new Map<string, ToolAggEntry>();
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

      accumulateLogRecord(record, ts, toolAgg, errors);
    }

    const toolUsage = this.buildToolUsage(toolAgg);

    // Sort by call count descending, apply limit
    toolUsage.sort((a, b) => b.call_count - a.call_count);
    if (toolUsage.length > limit) toolUsage.length = limit;
    if (errors.length > limit) errors.length = limit;

    // Filter by sub-category if specified
    if (category === "tools") return { toolUsage, errors: [] };
    if (category === "errors") return { toolUsage: [], errors };
    return { toolUsage, errors };
  }

  /** Turn aggregated per-tool stats into usage rows (server + average latency), unsorted. */
  private buildToolUsage(toolAgg: Map<string, ToolAggEntry>): ToolUsageSummary[] {
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
    return toolUsage;
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

// ---------------------------------------------------------------------------
// JSONL conversation helpers
// ---------------------------------------------------------------------------

/** One parsed line from a conversation JSONL log (event- or message-shaped). */
type JsonlConversationEntry = {
  type?: string;
  role?: string;
  content?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  metadata?: { usage?: { inputTokens?: number; outputTokens?: number } };
};

/** Running totals accumulated while scanning one conversation's JSONL lines. */
interface JsonlConversationTotals {
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  preview: string;
}

/**
 * Summarize one conversation JSONL file into an activity row, or null when its
 * first line is empty/missing or its updatedAt falls outside [since, until].
 */
function summarizeJsonlConversation(
  content: string,
  filename: string,
  since: string,
  until: string,
): ActivityConversationSummary | null {
  const lines = content.split("\n").filter(Boolean);
  const firstLine = lines[0];
  if (!firstLine?.trim()) return null;

  const meta = JSON.parse(firstLine) as Record<string, unknown>;
  const updatedAt = (meta.updatedAt as string) ?? "";
  if (updatedAt < since || updatedAt > until) return null;

  const totals: JsonlConversationTotals = {
    inputTokens: 0,
    outputTokens: 0,
    messageCount: 0,
    preview: "",
  };
  for (let i = 1; i < lines.length; i++) {
    try {
      applyJsonlEntry(JSON.parse(lines[i]!) as JsonlConversationEntry, totals);
    } catch {
      // Skip malformed conversation lines.
    }
  }

  return {
    id: (meta.id as string) ?? filename.replace(".jsonl", ""),
    created_at: (meta.createdAt as string) ?? "",
    updated_at: updatedAt,
    message_count: totals.messageCount,
    tool_call_count: 0,
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    preview: totals.preview,
    had_errors: false,
  };
}

/**
 * Fold one JSONL entry into the totals. Matches, in order, llm.response (with
 * usage), user.message, run.done, then any remaining role-tagged message.
 */
function applyJsonlEntry(entry: JsonlConversationEntry, totals: JsonlConversationTotals): void {
  if (entry.type === "llm.response" && entry.usage) {
    totals.inputTokens += entry.usage.inputTokens ?? 0;
    totals.outputTokens += entry.usage.outputTokens ?? 0;
    return;
  }
  if (entry.type === "user.message") {
    applyUserMessageEntry(entry, totals);
    return;
  }
  if (entry.type === "run.done") {
    totals.messageCount++;
    return;
  }
  if (entry.role) {
    applyRoleTaggedEntry(entry, totals);
  }
}

/** Count a user.message and, absent a preview, take its first text block as the preview. */
function applyUserMessageEntry(
  entry: JsonlConversationEntry,
  totals: JsonlConversationTotals,
): void {
  totals.messageCount++;
  if (!totals.preview && Array.isArray(entry.content)) {
    const firstText = (entry.content as Array<{ type?: string; text?: string }>).find(
      (c) => c.type === "text",
    );
    totals.preview = firstText?.text ?? "";
  }
}

/** Count a role-tagged message, taking a user-string preview and summing assistant usage. */
function applyRoleTaggedEntry(
  entry: JsonlConversationEntry,
  totals: JsonlConversationTotals,
): void {
  totals.messageCount++;
  if (!totals.preview && entry.role === "user" && typeof entry.content === "string") {
    totals.preview = entry.content;
  }
  if (entry.role === "assistant" && entry.metadata?.usage) {
    totals.inputTokens += entry.metadata.usage.inputTokens ?? 0;
    totals.outputTokens += entry.metadata.usage.outputTokens ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Automation-run helpers
// ---------------------------------------------------------------------------

/** Running tallies accumulated while scanning automation-run JSONL files. */
interface AutomationRunTotals {
  total: number;
  succeeded: number;
  failed: number;
  failures: AutomationRunSummary["failures"];
}

/** Fold every run line of one automation JSONL file into the totals; skip the file if unreadable. */
async function accumulateAutomationRunFile(
  dir: string,
  filename: string,
  sinceMs: number,
  untilMs: number,
  totals: AutomationRunTotals,
): Promise<void> {
  try {
    const content = await readFile(join(dir, filename), "utf-8");
    for (const line of content.split("\n")) {
      accumulateAutomationRunLine(line, filename, sinceMs, untilMs, totals);
    }
  } catch {
    // Skip unreadable automation run files.
  }
}

/**
 * Fold one automation-run line into the totals, counting successes and
 * collecting failures for runs started within [sinceMs, untilMs].
 */
function accumulateAutomationRunLine(
  line: string,
  filename: string,
  sinceMs: number,
  untilMs: number,
  totals: AutomationRunTotals,
): void {
  if (!line.trim()) return;

  let run: Record<string, unknown>;
  try {
    run = JSON.parse(line);
  } catch {
    return;
  }

  const startedAt = run.startedAt as string | undefined;
  if (!startedAt) return;

  const startedMs = new Date(startedAt).getTime();
  if (startedMs < sinceMs || startedMs > untilMs) return;

  const status = run.status as string | undefined;
  if (status !== "success" && status !== "failure" && status !== "timeout") return;

  totals.total++;
  if (status === "success") {
    totals.succeeded++;
    return;
  }

  totals.failed++;
  const automationName = filename.replace(/\.jsonl$/, "");
  totals.failures.push({
    name: automationName,
    error: (run.error as string) ?? undefined,
    action: {
      label: "View failed run",
      type: "startChat",
      route: null,
      prompt: `Show me the failed ${automationName} automation run`,
    },
  });
}

// ---------------------------------------------------------------------------
// Log-scan helpers
// ---------------------------------------------------------------------------

/** Running aggregate for one tool across every run in the window. */
interface ToolAggEntry {
  count: number;
  errors: number;
  totalMs: number;
}

/** Route one parsed log record into the tool aggregate and/or the error list by event type. */
function accumulateLogRecord(
  record: Record<string, unknown>,
  ts: string,
  toolAgg: Map<string, ToolAggEntry>,
  errors: ErrorEntry[],
): void {
  const event = record.event as string | undefined;

  if (event === "run.done") {
    accumulateRunDone(record, ts, toolAgg, errors);
    return;
  }

  if (event === "run.error") {
    errors.push({
      timestamp: ts,
      source: "engine",
      message: (record.error as string) ?? (record.message as string) ?? "Unknown engine error",
      context: record.sid as string | undefined,
    });
    return;
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

/** Merge a run.done record's per-tool stats into the aggregate and record any tool errors. */
function accumulateRunDone(
  record: Record<string, unknown>,
  ts: string,
  toolAgg: Map<string, ToolAggEntry>,
  errors: ErrorEntry[],
): void {
  const toolStats = record.toolStats as
    | Record<string, { count: number; totalMs: number }>
    | undefined;
  if (toolStats) mergeToolStats(toolAgg, toolStats);

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

/** Merge per-tool call/latency stats from one run into the running aggregate. */
function mergeToolStats(
  toolAgg: Map<string, ToolAggEntry>,
  toolStats: Record<string, { count: number; totalMs: number }>,
): void {
  for (const [name, stats] of Object.entries(toolStats)) {
    const existing = toolAgg.get(name);
    if (existing) {
      existing.count += stats.count;
      existing.totalMs += stats.totalMs;
    } else {
      toolAgg.set(name, { count: stats.count, errors: 0, totalMs: stats.totalMs });
    }
  }
}
