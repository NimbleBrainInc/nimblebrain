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
  /** Present when the task's runs take input. */
  inputSchema?: Record<string, unknown>;
}

export interface TaskDetail {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  /** Absent: no schedule (manual only). */
  schedule?: Record<string, unknown>;
  scheduleHuman: string;
  /** The IANA timezone its schedule is read in. */
  timezone: string;
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
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | null;
  disabledReason?: string | null;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  tokenBudget?: { maxInputTokens?: number; maxOutputTokens?: number; period?: string } | null;
  budgetResetAt?: string | null;
  estimatedCostPerRun?: number;
  estimatedCostPerDay?: number;
  estimatedCostPerMonth?: number;
  maxRunDurationMs?: number;
  kind?: "saved" | "oneoff";
  onceDone?: { at: string; outcome: "ran" | "missed" };
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  criteria?: TaskCriterion[];
  confidenceThreshold?: number;
  judge?: TaskJudgeSpec;
  onPoorResult?: OnPoorResult;
}

/** What a `fail` assessment does. */
export type OnPoorResult = "record" | "notify" | "retry_once";

/** One acceptance criterion (mirror of the runtime's TaskCriterion). */
export interface TaskCriterion {
  id: string;
  rule: string;
  type: "boolean" | "score" | "choice";
  levels?: string[];
  options?: string[];
  pass?: boolean | number | string | string[];
}

/** Which judge answers a task's criteria (mirror of TaskJudgeSpec). */
export interface TaskJudgeSpec {
  server?: string;
  id?: string;
  options?: Record<string, unknown>;
}

/** A warning a write returns about a task it saved anyway (mirror of TaskWarning). */
export interface TaskWarning {
  code: string;
  message: string;
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
  reason?: { code: string; message: string };
  schema?: { valid: boolean; errors?: string[] };
  criteria?: CriterionResult[];
  judge?: { server: string; id: string; version?: string; calibrated: boolean };
  /** What the judge call cost. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  stateTruncated?: boolean;
  assessedAt: string;
  human?: { verdict: "pass" | "fail"; note?: string; by: string; via: string; at: string };
}

/** How a run ended (mirror of the runtime's TaskRunExecution). */
export type RunExecution =
  | "queued"
  | "running"
  | "skipped"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

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
  /** How the run ended, derived by the runtime on read. */
  execution?: RunExecution;
  /** What started it; absent on a run that never started. */
  trigger?: "scheduled" | "manual" | "event";
  /** The JSON input the run was given. */
  input?: unknown;
  batchIndex?: number;
  outputSchemaValid?: boolean;
  outputSchemaErrors?: string[];
  unrecoveredToolFailures?: string[];
  spendAccountId?: string;
  /** Derived by the runtime on read; absent on records from older servers. */
  label?: RunLabel;
  assessment?: RunAssessment;
  retryOf?: string;
  /** Set on a run that is an item of a batch. */
  batchId?: string;
  costUsd?: number;
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
  /** The deliverable parsed as JSON, when the task has an outputSchema and it parsed. */
  structured?: unknown;
  /** Why the run failed or did not start. */
  error?: string;
  execution?: RunExecution;
  label?: RunLabel;
  assessment?: RunAssessment;
}

/** How many of a batch's items are in each state (mirror of the runtime's BatchCounts). */
export interface BatchCounts {
  pending: number;
  queued: number;
  running: number;
  pass: number;
  fail: number;
  uncertain: number;
  not_assessed: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

/** A batch as the batch tools return it (mirror of the runtime's TaskBatchView). */
export interface TaskBatch {
  id: string;
  taskId: string;
  items: number;
  concurrency: number;
  budgetUsd?: number;
  stopWhen?: { minPassRate: number; afterItems: number };
  state: "running" | "paused" | "completed" | "cancelled";
  pause?: { reason: string; message: string; at: string };
  counts: BatchCounts;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
  done: number;
  passRate: number | null;
}

/** One item's result row (mirror of the runtime's TaskBatchItemView). */
export interface BatchItemResult {
  index: number;
  inputSummary: string;
  state: "pending" | "queued" | "running" | "done";
  runId?: string;
  previousRunIds?: string[];
  execution?: string;
  verdict?: string;
  label?: RunLabel;
  costUsd?: number;
  error?: string;
  output?: Record<string, string | number | boolean | null>;
}

/** A run running or waiting for a slot (mirror of TaskUpcomingRun). */
export interface UpcomingRun {
  taskId: string;
  taskName?: string;
  runId?: string;
  state: "running" | "queued";
  /** Queued only: 1 is next. */
  position?: number;
  startedAt?: string;
  queuedAt?: string;
  trigger?: "scheduled" | "manual" | "event";
  batchId?: string;
  batchIndex?: number;
}

/** One scheduled fire (mirror of TaskUpcomingFire). */
export interface UpcomingFire {
  taskId: string;
  taskName: string;
  at: string;
  schedule: string;
  scheduleType: "cron" | "interval" | "once";
  /** Past the window: the task's next fire, shown so a rare schedule is not missing. */
  beyondWindow?: boolean;
}

/** A schedule that fires too often to list each fire (mirror of TaskUpcomingFrequent). */
export interface UpcomingFrequent {
  taskId: string;
  taskName: string;
  schedule: string;
  scheduleType: "cron" | "interval";
  count: number;
  /** `count` is a floor: a cron is counted only until it is known to be frequent. */
  countCapped?: boolean;
  first: string;
  /** Absent when `countCapped`. */
  last?: string;
}

/** A task that fires on events (mirror of TaskUpcomingEventTask). */
export interface UpcomingEventTask {
  taskId: string;
  taskName: string;
  schedule: string;
  enabled: boolean;
  maxFiresPerHour: number;
  firesLastHour: number;
}

/** `tasks__upcoming` (mirror of TasksUpcomingOutput). */
export interface UpcomingData {
  running: UpcomingRun[];
  queued: UpcomingRun[];
  days: number;
  windowEnd: string;
  scheduled: UpcomingFire[];
  frequent: UpcomingFrequent[];
  events: UpcomingEventTask[];
}

/** One task's figures over a window (mirror of TaskRunStats). */
export interface TaskStats {
  taskId: string;
  runs: number;
  pass: number;
  fail: number;
  uncertain: number;
  passRate: number | null;
  costUsd: number;
  lastRun?: { id: string; startedAt: string; label: RunLabel };
}

/** `tasks__judges` (mirror of TasksJudgesOutput). */
export interface JudgesData {
  servers: string[];
  warning?: TaskWarning;
}
