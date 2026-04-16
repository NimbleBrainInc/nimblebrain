/**
 * Type definitions for the automations domain.
 * Matches SPEC_ADDENDUM_AUTOMATIONS.md §5.1–5.3.
 */

// ---------------------------------------------------------------------------
// §5.1 — Automation Definition
// ---------------------------------------------------------------------------

export interface Automation {
  /** Unique identifier. Kebab-case, derived from name. */
  id: string;

  /** Human-readable name. */
  name: string;

  /** What this automation does. */
  description?: string;

  /** The message sent to POST /v1/chat on each run. */
  prompt: string;

  /** When to run. */
  schedule: ScheduleSpec;

  /** Force a specific skill match (bypass trigger/keyword matching). */
  skill?: string;

  /** Tool allowlist (glob patterns). Passed as allowedTools on chat request. */
  allowedTools?: string[];

  /** Max agentic iterations per run. Default: 5. Hard cap: 15. */
  maxIterations?: number;

  /** Max input tokens per run. Default: 200_000. */
  maxInputTokens?: number;

  /** Max execution time in ms for a single run. Default: 120_000 (2 minutes). */
  maxRunDurationMs?: number;

  /** Model override for this automation. Null = workspace default. */
  model?: string | null;

  /** Whether this automation is active. */
  enabled: boolean;

  /** User ID of the automation owner. Set at creation time. Used for scheduled runs. */
  ownerId?: string;

  /** Workspace this automation belongs to. Set at creation time. Used for scheduled runs. */
  workspaceId?: string;

  /** Who created this automation. */
  source: "user" | "agent" | "bundle";

  /** If bundle-contributed, which bundle. */
  bundleName?: string;

  /** ISO timestamp. */
  createdAt: string;

  /** ISO timestamp. */
  updatedAt: string;

  // --- Scheduling state (persisted, survives restarts) ---

  /** ISO timestamp of last completed run. */
  lastRunAt?: string;

  /** Status of last completed run. */
  lastRunStatus?: "success" | "failure" | "timeout" | "skipped";

  /** ISO timestamp of next scheduled run. */
  nextRunAt?: string;

  /** Total completed runs. */
  runCount: number;

  /** Consecutive failed runs (resets on success). Drives backoff. */
  consecutiveErrors: number;

  /** ISO timestamp when auto-disabled. */
  disabledAt?: string;

  /** Reason the automation was auto-disabled. */
  disabledReason?: string;

  /** Cumulative input tokens consumed across all runs. */
  cumulativeInputTokens: number;

  /** Cumulative output tokens consumed across all runs. */
  cumulativeOutputTokens: number;

  /** Optional token budget. Auto-disables when exceeded. */
  tokenBudget?: TokenBudget;

  /** ISO timestamp for next budget reset. */
  budgetResetAt?: string;
}

// ---------------------------------------------------------------------------
// Token Budget
// ---------------------------------------------------------------------------

export interface TokenBudget {
  /** Max cumulative input tokens before auto-disable. */
  maxInputTokens?: number;
  /** Max cumulative output tokens before auto-disable. */
  maxOutputTokens?: number;
  /** Reset period. Cumulative counters reset at the start of each period. */
  period?: "daily" | "monthly";
}

// ---------------------------------------------------------------------------
// §5.2 — Schedule Specification
// ---------------------------------------------------------------------------

export interface ScheduleSpec {
  type: "cron" | "interval";

  /** Standard 5-field cron expression. Required when type is "cron". */
  expression?: string;

  /** IANA timezone. Defaults to home.timezone or system timezone. */
  timezone?: string;

  /** Interval in milliseconds. Required when type is "interval". Minimum: 60_000 (1 min). */
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// §5.3 — Automation Run
// ---------------------------------------------------------------------------

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "failure" | "timeout" | "cancelled" | "skipped";
  conversationId?: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  iterations: number;
  error?: string;
  /** Whether this failure was classified as transient (eligible for backoff retry). */
  transient?: boolean;
  /** Final agent response (truncated to 500 chars). */
  resultPreview?: string;
  stopReason?: "complete" | "max_iterations" | "token_budget";
}

// ---------------------------------------------------------------------------
// Persistence — automations.json structure
// ---------------------------------------------------------------------------

export interface AutomationsFile {
  version: number;
  updatedAtMs: number;
  automations: Automation[];
}

// ---------------------------------------------------------------------------
// Helper types — tool inputs
// ---------------------------------------------------------------------------

/** Input for automations__create. Omits computed/state fields. */
export type CreateAutomationInput = Omit<
  Automation,
  | "id"
  | "ownerId"
  | "workspaceId"
  | "createdAt"
  | "updatedAt"
  | "runCount"
  | "consecutiveErrors"
  | "lastRunAt"
  | "lastRunStatus"
  | "nextRunAt"
  | "disabledAt"
  | "disabledReason"
  | "cumulativeInputTokens"
  | "cumulativeOutputTokens"
  | "budgetResetAt"
>;

/** Input for automations__update. Partial of user-editable fields. */
export type UpdateAutomationInput = Partial<
  Pick<
    Automation,
    | "description"
    | "prompt"
    | "schedule"
    | "skill"
    | "allowedTools"
    | "maxIterations"
    | "maxInputTokens"
    | "maxRunDurationMs"
    | "model"
    | "enabled"
    | "tokenBudget"
  >
>;
