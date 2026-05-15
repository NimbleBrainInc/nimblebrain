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
  /**
   * True when this briefing was produced by the heuristic fallback rather
   * than the LLM (e.g. timeout, parse failure, provider error). Callers
   * MUST NOT cache degraded briefings — a transient model hiccup would
   * otherwise stick the user with a canned response for the cache TTL.
   * The UI may also surface a "retry" affordance when this is set.
   */
  degraded?: boolean;
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

/** Action attached to a briefing section. Discriminated by `type`:
 * `navigate` carries a `route` consumed by the host bridge; `startChat`
 * carries a `prompt` sent to the agent. The shape matches the LLM
 * structured-output schema (BRIEFING_RESPONSE_SCHEMA) and the host
 * bridge contract — three contracts in lockstep so a degraded
 * (heuristic) briefing and an LLM-generated briefing render with the
 * same handler logic. */
export type BriefingAction =
  | { type: "navigate"; label: string; route: string }
  | { type: "startChat"; label: string; prompt: string };

/** In-memory cache entry for a generated briefing. */
export interface BriefingCacheEntry {
  briefing: BriefingOutput;
  generatedAt: number;
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
  totals: {
    conversations: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    errors: number;
  };
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
 * model selection live elsewhere — model identity comes from the
 * resolved ModelProfile, and the briefing tool's registration handles
 * the feature flag at a higher level. */
export interface HomeConfig {
  userName: string;
  timezone: string;
  cacheTtlMinutes: number;
}
