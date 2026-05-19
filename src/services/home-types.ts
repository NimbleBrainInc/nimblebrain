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

/** Action attached to a briefing section. `type` discriminates which
 * field carries the payload — navigate uses `route`, startChat uses
 * `prompt` — but both fields are present in the wire shape (nullable
 * for the unused variant) because Anthropic structured-output requires
 * all schema properties to appear in `required`. Consumers check
 * `action.type` before reading the relevant field. */
export interface BriefingAction {
  type: "navigate" | "startChat";
  label: string;
  /** Set on navigate actions; null on startChat. */
  route: string | null;
  /** Set on startChat actions; null on navigate. */
  prompt: string | null;
}

/** In-memory cache entry for a generated briefing. */
export interface BriefingCacheEntry {
  briefing: BriefingOutput;
  generatedAt: number;
  /** Fingerprint of the workspace data the briefing was built from. */
  fingerprint: string;
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

/** Home feature configuration from nimblebrain.json. Mirrors the shape
 * returned by `Runtime.getHomeConfig()`. Feature gating (`enabled`) and
 * model selection live elsewhere — the model identity is passed to
 * BriefingGenerator separately, and feature-flag gating happens at
 * tool registration. */
export interface HomeConfig {
  userName: string;
  timezone: string;
  cacheTtlMinutes: number;
}
