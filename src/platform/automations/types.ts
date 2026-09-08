/**
 * Type definitions for the automations domain.
 * Matches SPEC_ADDENDUM_AUTOMATIONS.md §5.1–5.3.
 */

import type { NotificationRouteMatch } from "../schemas/notifications.ts";

// ---------------------------------------------------------------------------
// §5.1 — Automation Definition
// ---------------------------------------------------------------------------

/** Who created this automation. */
export type AutomationSource = "user" | "agent";

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

  /** Max agentic iterations per run. Default: 25. Hard cap: 50. */
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
  source: AutomationSource;

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

/**
 * Default debounce window for an event schedule.
 *
 * A connector that learns forty things at once (a bounce sweep, a batch of
 * replies) emits forty envelopes within a second or two. Long enough that such
 * a burst becomes one run with forty items in it; short enough that a single
 * reply is acted on while the person who sent it is still at their desk.
 */
export const DEFAULT_EVENT_DEBOUNCE_MS = 30_000;

/** Widest debounce window an event schedule may ask for. */
export const MAX_EVENT_DEBOUNCE_MS = 900_000;

/**
 * Default ceiling on how often an event schedule may fire, per hour.
 *
 * The run limits an automation already carries bound how much ONE run costs;
 * none of them bounds how many runs there are, because a run that succeeds
 * every time never trips consecutive-error auto-disable. A self-feeding loop —
 * a run approves something, the connector emits the fact, the route fires the
 * run — is exactly that shape, so this is the bound that terminates it.
 */
export const DEFAULT_EVENT_MAX_FIRES_PER_HOUR = 12;

/** Highest fire ceiling an event schedule may ask for. */
export const MAX_EVENT_MAX_FIRES_PER_HOUR = 60;

/** What `disabledReason` says when the fire ceiling turned an automation off. */
export const EVENT_FIRE_CEILING_REASON = "event_fire_ceiling";

/**
 * When an automation runs.
 *
 * Three kinds, discriminated by `type`, with each kind's own fields optional on
 * the shared shape — the arrangement `cron` and `interval` already had.
 *
 * `cron` and `interval` are positions in time and the scheduler's timer arms
 * itself to them. `event` is not: it has no next run, the timer never arms for
 * it, and it fires when a notification the workspace routed to it arrives.
 * Reaching an automation that way is an operator's decision twice over — an
 * admin writes the route that names it, and the automation's own `match` says
 * which of the routed items it wants — so neither half alone opens the path.
 */
export interface ScheduleSpec {
  type: "cron" | "interval" | "event";

  /** Standard 5-field cron expression. Required when type is "cron". */
  expression?: string;

  /** IANA timezone. Defaults to home.timezone or system timezone. */
  timezone?: string;

  /** Interval in milliseconds. Required when type is "interval". Minimum: 60_000 (1 min). */
  intervalMs?: number;

  /**
   * Which notifications this automation wants. Required when type is "event".
   *
   * The same match expression a delivery route carries, imported rather than
   * restated so one grammar governs both ends: a route decides that a path from
   * the inbox to this automation exists at all, and this decides which of the
   * items arriving down it are worth a run.
   */
  match?: NotificationRouteMatch;

  /**
   * How long matching items coalesce into one batch before the run starts, in
   * milliseconds. Default {@link DEFAULT_EVENT_DEBOUNCE_MS}.
   */
  debounceMs?: number;

  /**
   * Most runs this automation may fire from events in any rolling hour.
   * Default {@link DEFAULT_EVENT_MAX_FIRES_PER_HOUR}. Exceeding it disables the
   * automation, through the same fields consecutive-error auto-disable uses.
   */
  maxFiresPerHour?: number;
}

/** Whether a schedule fires from notifications rather than from the clock. */
export function isEventSchedule(schedule: ScheduleSpec | undefined): boolean {
  return schedule?.type === "event";
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
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  iterations: number;
  error?: string;
  /** Whether this failure was classified as transient (eligible for backoff retry). */
  transient?: boolean;
  /**
   * What started this run — the scheduler's timer, an operator's Run now, or a
   * notification a route delivered here.
   *
   * Absent on records written before the field existed, which is why the fire
   * ceiling counts `"event"` explicitly rather than counting everything that is
   * not scheduled.
   */
  trigger?: "scheduled" | "manual" | "event";
  /** Final agent response, truncated for the run list. The full deliverable,
   *  activity log, and output-file refs live in the run's `AutomationRunResult`
   *  sidecar (see {@link AutomationRunResult}). */
  resultPreview?: string;
  /**
   * Engine-level stop reason. Mirrors `StopReason` from `src/engine/types.ts`
   * (intentionally duplicated here to keep this app's types decoupled
   * from the engine package). Keep in sync when the engine union changes.
   */
  stopReason?: "complete" | "max_iterations" | "length" | "content_filter" | "error" | "other";
}

// ---------------------------------------------------------------------------
// §5.3a — Automation Run Result (the deliverable)
// ---------------------------------------------------------------------------

/** One tool call from a run's activity log. */
export interface RunToolCall {
  id: string;
  name: string;
  input: unknown;
  output: string;
  ok: boolean;
  ms: number;
}

/** A reference to a file the run produced, resolvable in the workspace file store. */
export interface RunFileRef {
  id: string;
  filename: string;
}

/**
 * The full result of an automation run — what the run *produced*, persisted
 * once per run as a sidecar to the lightweight {@link AutomationRun} summary.
 * An automation run is no longer a conversation: instead of a chat trace, it
 * leaves a deliverable (the final output), the activity log of what it did,
 * and references to any files it wrote (in the workspace file store).
 */
export interface AutomationRunResult {
  /** Matches the owning {@link AutomationRun.id}. */
  runId: string;
  automationId: string;
  completedAt: string;
  /** The agent's final deliverable, in full (untruncated). */
  output: string;
  /** What the run did — every tool call, in order. */
  activityLog: RunToolCall[];
  /** Files the run wrote, as refs into `workspaces/<wsId>/files/<ownerId>/`. */
  outputFiles: RunFileRef[];
  usage: { inputTokens: number; outputTokens: number; iterations: number };
  stopReason?: AutomationRun["stopReason"];
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
