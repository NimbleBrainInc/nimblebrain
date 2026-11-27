/**
 * The tasks contract's public outputs as this screen reads them
 * (`schemas/contracts/tasks/v1/contract.json`, `<tool>_output`). Outputs are
 * open: a field may be absent, and a value of a named set (execution, label,
 * a batch's state, a verdict, …) may be one this screen does not know, which it
 * shows verbatim and treats as unknown (CONTRACT.md §4). So those are typed as
 * strings, with the known values as constants beside them.
 */

/** A schedule in the form it was written: exactly one of these key sets. */
export interface ScheduleForm {
  cron?: string;
  timezone?: string;
  at?: string;
  intervalMs?: number;
  match?: { source?: string; name?: string; level?: string };
  debounceMs?: number;
  maxFiresPerHour?: number;
}

export interface TokenBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  period?: string;
}

/** One row of `list`. */
export interface TaskSummary {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
  scheduleHuman?: string;
  /** cron, interval, event, once or none; another value is unknown. */
  scheduleType?: string;
  kind?: string;
  /** Set when a once schedule has fired or missed its time (inert until re-armed). */
  onceDone?: { at: string; outcome: string };
  runCount?: number;
  lastRunAt?: string;
  lastRunLabel?: string;
  nextRunAt?: string;
  disabledAt?: string;
  disabledReason?: string;
  /** Present when the task's runs take input. */
  inputSchema?: Record<string, unknown>;
  /** A one-off's: the start of its prompt. */
  promptPreview?: string;
}

/** A stored task, as `create`, `update` and `status` return it. */
export interface TaskDetail {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  description?: string;
  /** Absent: no schedule (manual only). */
  schedule?: ScheduleForm;
  scheduleHuman?: string;
  kind?: string;
  onceDone?: { at: string; outcome: string };
  skills?: string[];
  allowedTools?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  model?: string;
  thinkingEffort?: string;
  tokenBudget?: TokenBudget;
  budgetResetAt?: string;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  ownerId?: string;
  workspaceId?: string;
  createdAt?: string;
  updatedAt?: string;
  runCount?: number;
  consecutiveErrors?: number;
  lastRunAt?: string;
  lastRunLabel?: string;
  nextRunAt?: string;
  disabledAt?: string;
  disabledReason?: string;
}

/** A task's reasoning depth. */
export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** How a run ended, or that it has not. */
export type RunExecution =
  | "queued"
  | "running"
  | "skipped"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

/** The one label a run reads as. */
export type RunLabel =
  | "Succeeded"
  | "Poor result"
  | "Needs review"
  | "Failed"
  | "Skipped"
  | "Cancelled"
  | "Queued"
  | "Running";

/** A run, as every run surface returns it. */
export interface TaskRun {
  id: string;
  taskId: string;
  /** A {@link RunExecution}; another value is unknown and reads as ended. */
  execution: string;
  /** A {@link RunLabel}; another value is shown verbatim. */
  label: string;
  /** Absent only while queued. */
  startedAt?: string;
  completedAt?: string;
  trigger?: string;
  error?: string;
  transient?: boolean;
  resultPreview?: string;
  unrecoveredToolFailures?: string[];
  /** Each tool in `unrecoveredToolFailures`, with the reason its last failed call failed. */
  toolFailures?: { name: string; errorReason?: string }[];
  inputTokens?: number;
  outputTokens?: number;
  iterations?: number;
  /** How many tool calls it made. */
  toolCalls?: number;
  costUsd?: number;
  unpricedCalls?: number;
  spendAccountId?: string;
  /** The JSON input the run was given. */
  input?: unknown;
  idempotencyKey?: string;
  retryOf?: string;
  /** Set on a run that is an item of a batch. */
  batchId?: string;
  batchIndex?: number;
}

/** One tool call a run made, in call order; never its input or output. */
export interface RunToolCall {
  name: string;
  ok: boolean;
  errorReason?: string;
  ms?: number;
}

/** A file the run wrote, as the host recorded it. */
export interface RunFileRef {
  uri: string;
  name?: string;
}

/** A run's whole deliverable and what the host reported of it (`run_result`'s `result`). */
export interface TaskRunResultBody {
  completedAt: string;
  output: string;
  /** The deliverable parsed against the output schema. */
  structured?: unknown;
  error?: string;
  activityLog?: RunToolCall[];
  outputFiles?: RunFileRef[];
  usage?: { inputTokens?: number; outputTokens?: number; iterations?: number };
  stopReason?: string;
  skillsDelivered?: { name: string; loadedBy?: string; status?: string }[];
}

/** `run_result`. */
export interface RunResultData {
  run: TaskRun;
  result?: TaskRunResultBody;
  message?: string;
}

/** An ended run's result as the screens show it: the body, with the run's ids and derived reading. */
export interface TaskRunResult extends TaskRunResultBody {
  runId: string;
  taskId: string;
  execution: string;
  label: string;
}

/** Whether a run has not ended yet. Any execution this screen does not know reads as ended. */
export function isOpenExecution(execution: string | undefined): boolean {
  return execution === "queued" || execution === "running";
}

/** How many of a batch's items are in each state. */
export interface BatchCounts {
  pending: number;
  queued: number;
  running: number;
  pass: number;
  fail: number;
  not_assessed: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

/** A batch as the batch tools return it. */
export interface TaskBatch {
  id: string;
  taskId: string;
  /** running, paused, completed or cancelled; another value is unknown and not acted on. */
  state: string;
  counts: BatchCounts;
  name?: string;
  items?: number;
  /** Items with an outcome. */
  done?: number;
  /** pass / (pass + fail); absent before either. */
  passRate?: number;
  concurrency?: number;
  sharing?: number;
  budgetUsd?: number;
  costUsd?: number;
  stopWhen?: { minPassRate: number; afterItems: number };
  stopRuleDisarmed?: boolean;
  pause?: { reason: string; message?: string; at?: string };
  idempotencyKey?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

/** One item's result row. */
export interface BatchItemResult {
  index: number;
  /** pending, queued, running or done; another value is unknown. */
  state: string;
  runId?: string;
  previousRunIds?: string[];
  execution?: string;
  verdict?: string;
  label?: string;
  inputSummary?: string;
  costUsd?: number;
  error?: string;
  errorCode?: string;
  output?: Record<string, string | number | boolean | null>;
  structured?: unknown;
  structuredOmitted?: boolean;
}

/** A run running or waiting (`upcoming`'s `running` and `queued` rows). */
export interface UpcomingRun {
  taskId: string;
  runId?: string;
  taskName?: string;
  startedAt?: string;
  queuedAt?: string;
  trigger?: string;
  batchId?: string;
  batchIndex?: number;
}

/** A run from `upcoming`, marked with the list it came from. */
export type LiveRun = UpcomingRun & { state: "running" | "queued" };

/** One scheduled fire. */
export interface UpcomingFire {
  taskId: string;
  at: string;
  taskName?: string;
  scheduleHuman?: string;
  scheduleType?: string;
  /** Past the window: the task's next fire, shown so a rare schedule is not missing. */
  beyondWindow?: boolean;
}

/** A schedule that fires too often to list each fire. */
export interface UpcomingFrequent {
  taskId: string;
  count: number;
  first: string;
  taskName?: string;
  scheduleHuman?: string;
  scheduleType?: string;
  /** `count` is a floor: a cron is counted only until it is known to be frequent. */
  countCapped?: boolean;
  /** Absent when `countCapped`. */
  last?: string;
}

/** A task that fires on events. */
export interface UpcomingEventTask {
  taskId: string;
  taskName?: string;
  enabled?: boolean;
  maxFiresPerHour?: number;
  firesLastHour?: number;
}

/** `upcoming`. */
export interface UpcomingData {
  running: UpcomingRun[];
  queued: UpcomingRun[];
  scheduled: UpcomingFire[];
  days?: number;
  windowEnd?: string;
  frequent?: UpcomingFrequent[];
  events?: UpcomingEventTask[];
}

/** One task's figures over a window (`stats`). */
export interface TaskStats {
  taskId: string;
  runs: number;
  pass: number;
  fail: number;
  passRate?: number;
  costUsd?: number;
  lastRun?: { id: string; label: string; startedAt?: string };
  /** The newest runs, newest first (batch runs left out). */
  recent?: {
    id: string;
    label: string;
    startedAt?: string;
    error?: string;
    toolFailures?: { name: string; errorReason?: string }[];
  }[];
}
