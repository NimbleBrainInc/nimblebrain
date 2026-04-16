/** Briefing input — passed to home__briefing tool. */
export interface BriefingInput {
  force_refresh?: boolean;
}

/** Complete briefing output returned by home__briefing. */
export interface BriefingOutput {
  greeting: string;
  date: string;
  lede: string;
  sections: BriefingSection[];
  state: BriefingState;
  generated_at: string;
  cached: boolean;
}

/** Dashboard state derived from briefing content. */
export type BriefingState = "empty" | "quiet" | "all-clear" | "normal" | "attention";

/** Individual briefing section (e.g., "Your stock updates showed..."). */
export interface BriefingSection {
  id: string;
  text: string;
  type: "positive" | "neutral" | "warning";
  category: "recent" | "upcoming" | "attention";
  action?: BriefingAction;
}

/** Action attached to a briefing section. */
export interface BriefingAction {
  label: string;
  type: "chat" | "navigate";
  value: string;
}

/** In-memory cache entry for a generated briefing. */
export interface BriefingCacheEntry {
  briefing: BriefingOutput;
  generatedAt: number;
  activityHash: string;
  invalidated: boolean;
}

/** Activity query input — passed to home__activity tool. */
export interface ActivityInput {
  since?: string;
  until?: string;
  category?: "conversations" | "bundles" | "tools" | "errors";
  limit?: number;
}

/** Complete activity output returned by home__activity. */
export interface ActivityOutput {
  period: { since: string; until: string };
  conversations: ActivityConversationSummary[];
  bundle_events: ActivityBundleEvent[];
  tool_usage: ToolUsageSummary[];
  errors: ErrorEntry[];
  automations?: AutomationRunSummary;
  totals: {
    conversations: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    errors: number;
  };
}

/** Summary of automation runs for a time period. */
export interface AutomationRunSummary {
  total: number;
  succeeded: number;
  failed: number;
  failures: AutomationFailure[];
}

/** A failed automation run with details. */
export interface AutomationFailure {
  name: string;
  error?: string;
  action: BriefingAction;
}

/** Conversation summary for activity reporting. */
export interface ActivityConversationSummary {
  id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  preview: string;
  had_errors: boolean;
}

/** Bundle lifecycle event for activity reporting. */
export interface ActivityBundleEvent {
  bundle: string;
  event: "installed" | "uninstalled" | "crashed" | "recovered" | "dead";
  timestamp: string;
  detail?: string;
}

/** Tool usage aggregation for activity reporting. */
export interface ToolUsageSummary {
  tool: string;
  server: string;
  call_count: number;
  error_count: number;
  avg_latency_ms: number;
}

/** Error entry for activity reporting. */
export interface ErrorEntry {
  timestamp: string;
  source: "tool" | "engine" | "bundle" | "http";
  message: string;
  context?: string;
}
