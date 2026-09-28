// The briefing output contract lives in the platform schema — the single
// source of truth, codegen'd to the web shell. Re-exported so backend callers
// import from `../services/home-types.ts`.
export type { BriefingItem, BriefingOutput } from "../platform/schemas/home.ts";

/**
 * Action attached to an automation failure in `home__activity` output.
 * `type` discriminates the payload: `navigate` uses `route`, `startChat` uses
 * `prompt`; the unused one is null.
 */
export interface ActivityAction {
  type: "navigate" | "startChat";
  label: string;
  route: string | null;
  prompt: string | null;
}

/** Activity query input — passed to home__activity tool. */
export interface ActivityInput {
  since?: string;
  until?: string;
  category?: "conversations" | "connectors" | "tools" | "errors";
  limit?: number;
}

/** Complete activity output returned by home__activity. */
export interface ActivityOutput {
  period: { since: string; until: string };
  conversations: ActivityConversationSummary[];
  connector_events: ActivityConnectorEvent[];
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
  /** Runs that ended in `failure` or `timeout`. */
  failed: number;
  /** Runs that finished with a failed tool call nobody retried. */
  degraded: number;
  /** Every failed and degraded run, each with its status. */
  failures: AutomationFailure[];
}

/** A failed or degraded automation run with details. */
export interface AutomationFailure {
  /** The automation's id. */
  name: string;
  status: "failure" | "timeout" | "degraded";
  error?: string;
  action: ActivityAction;
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

/** Connector lifecycle event for activity reporting. */
export interface ActivityConnectorEvent {
  connector: string;
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
  source: "tool" | "engine" | "http";
  message: string;
  context?: string;
}
