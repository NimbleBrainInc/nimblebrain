export interface TaskSummary {
  id: string;
  name: string;
  description?: string;
  schedule: string;
  /** The schedule's type; `none` when nothing fires it unattended. */
  scheduleType?: "cron" | "interval" | "event" | "once" | "none";
  kind?: "saved" | "oneoff";
  /** Set when a once schedule has fired or missed its time (inert until re-armed). */
  onceDone?: { at: string; outcome: "ran" | "missed" };
  enabled: boolean;
  source: string;
  runCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  consecutiveErrors?: number;
  disabledAt?: string | null;
  disabledReason?: string | null;
  estimatedCostPerDay?: number;
}

export interface TaskDetail {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  /** Absent: no schedule (manual only). */
  schedule?: Record<string, unknown>;
  scheduleHuman: string;
  enabled: boolean;
  source: "user" | "agent";
  model?: string | null;
  maxIterations?: number;
  maxInputTokens?: number;
  allowedTools?: string[];
  skill?: string;
  runCount: number;
  consecutiveErrors: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  lastRunAtHuman: string | null;
  nextRunAt: string | null;
  nextRunAtHuman: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | null;
  disabledReason?: string | null;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  tokenBudget?: { maxInputTokens?: number; maxOutputTokens?: number; period?: string } | null;
  budgetResetAt?: string | null;
  actualCostUsd?: number;
  estimatedCostPerRun?: number;
  estimatedCostPerDay?: number;
  estimatedCostPerMonth?: number;
}

/** One criterion as judged (mirror of the runtime's CriterionResult). */
export interface CriterionResult {
  id: string;
  answer: boolean | number | string;
  passed: boolean;
  confidence: number;
  probabilities?: Record<string, number>;
  rationale?: string;
}

/** Whether a run's deliverable is acceptable (mirror of the runtime's RunAssessment). */
export interface RunAssessment {
  verdict: "pass" | "fail" | "uncertain" | "not_assessed";
  reason?: string;
  schema?: { valid: boolean; errors?: string[] };
  criteria?: CriterionResult[];
  judge?: { server: string; id: string; version?: string; calibrated: boolean };
  stateTruncated?: boolean;
  assessedAt: string;
  human?: { verdict: "pass" | "fail"; note?: string; by: string; via: string; at: string };
}

/** The one label a run reads as, derived by the runtime. */
export type RunLabel =
  | "Succeeded"
  | "Poor result"
  | "Needs review"
  | "Failed"
  | "Skipped"
  | "Cancelled"
  | "Queued"
  | "Running";

export interface TaskRun {
  id: string;
  taskId: string;
  status: string;
  /** Derived by the runtime on read; absent on records from older servers. */
  label?: RunLabel;
  assessment?: RunAssessment;
  retryOf?: string;
  startedAt: string;
  completedAt?: string;
  resultPreview?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  iterations?: number;
  stopReason?:
    | "complete"
    | "max_iterations"
    | "max_input_tokens"
    | "spend_limit"
    | "length"
    | "content_filter"
    | "error"
    | "other";
}

/** One tool call from a run's activity log (mirror of the runtime's RunToolCall). */
export interface RunToolCall {
  id: string;
  name: string;
  input: unknown;
  output: string;
  ok: boolean;
  ms: number;
}

/** A file the run produced, resolvable in the workspace file store. */
export interface RunFileRef {
  id: string;
  filename: string;
}

/** The full result of a run — fetched on demand via the `run_result` action. */
export interface TaskRunResult {
  runId: string;
  taskId: string;
  completedAt: string;
  output: string;
  activityLog: RunToolCall[];
  outputFiles: RunFileRef[];
  usage: { inputTokens: number; outputTokens: number; iterations: number };
  stopReason?:
    | "complete"
    | "max_iterations"
    | "max_input_tokens"
    | "spend_limit"
    | "length"
    | "content_filter"
    | "error"
    | "other";
}
