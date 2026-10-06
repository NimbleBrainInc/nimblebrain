/**
 * Type definitions for the tasks domain.
 */

import type { NotificationRouteMatch } from "../schemas/notifications.ts";

// ---------------------------------------------------------------------------
// Task Definition
// ---------------------------------------------------------------------------

/** Who created this task. */
export type TaskSource = "user" | "agent";

/** How a once schedule's one occurrence ended, and when (see {@link Task.onceDone}). */
export interface OnceDone {
  /** ISO time the occurrence was settled: the run's start, or when it was judged missed. */
  at: string;
  outcome: "ran" | "missed";
}

/** Whether a task is a kept definition or a one-off (see {@link Task.kind}). */
export type TaskKind = "saved" | "oneoff";

/** A task's kind, reading an absent one as `saved`. */
export function kindOf(task: Pick<Task, "kind">): TaskKind {
  return task.kind ?? "saved";
}

export interface Task {
  /** Unique identifier. Kebab-case, derived from name. */
  id: string;

  /** Human-readable name. */
  name: string;

  /** What this task does. */
  description?: string;

  /** The message that opens each run. */
  prompt: string;

  /**
   * What fires it unattended. Absent: nothing does, and it runs only when
   * someone runs it (Run now, `tasks__run`).
   */
  schedule?: ScheduleSpec;

  /**
   * `saved`: a definition someone keeps and lists. `oneoff`: made to be run
   * once with no trigger, kept with its run history but left out of the
   * default list. Absent reads as `saved`.
   */
  kind?: TaskKind;

  /**
   * Set when a once schedule's occurrence is over: it fired (`ran`, whatever
   * the run's outcome) or was too late to fire (`missed`). The task is
   * then inert until a new `at` re-arms it, which clears this. Absent on every
   * other task, and on a once still to come.
   */
  onceDone?: OnceDone;

  /** Force a specific skill match (bypass trigger/keyword matching). */
  skill?: string;

  /** Tool allowlist (glob patterns) for this task's runs. Empty or absent: every tool. */
  allowedTools?: string[];

  /**
   * JSON Schema each run's `input` must match. Set: a run whose input does not
   * match is refused before it is requested. Absent: any JSON input is taken.
   */
  inputSchema?: Record<string, unknown>;

  /**
   * JSON Schema the deliverable must match. Set: the run is told to answer with
   * JSON matching it, and the executor parses and validates the final output,
   * keeping the parsed value as the deliverable's `structured` and recording
   * whether it matched (`TaskRun.outputSchemaValid`).
   */
  outputSchema?: Record<string, unknown>;

  /**
   * Acceptance criteria: plain-language rules a judge answers about each run's
   * deliverable (see `assessment.ts`). Absent: no judging; the output schema,
   * when set, is the only check.
   */
  criteria?: Criterion[];

  /**
   * Judge confidence below which a run whose criteria all passed is
   * `uncertain` rather than `pass`. 0..1, default
   * {@link DEFAULT_CONFIDENCE_THRESHOLD}. Each criterion's own pass level is
   * separate; this decides only `uncertain`.
   */
  confidenceThreshold?: number;

  /**
   * Which judge answers the criteria: `server` names a connected judge server
   * (needed only when the workspace has more than one), `id` and `options` pick
   * a judge on it (from its `list_judges`). Absent: the one connected judge
   * server's default judge.
   */
  judge?: TaskJudge;

  /**
   * What happens when a run's assessment is `fail`. Default
   * {@link DEFAULT_ON_POOR_RESULT}.
   */
  onPoorResult?: OnPoorResult;

  /**
   * Max agentic iterations per run. Default: the runtime's chat default (25).
   * Held at execution to the operator's `tasks.maxRunIterations` (at
   * most 50); see `effectiveRunLimits`.
   */
  maxIterations?: number;

  /**
   * Input tokens one run may spend, summed over every model call. Before each
   * call the engine ends the run with stopReason `max_input_tokens` if that
   * call's projected input would pass it (see `EngineConfig.maxRunInputTokens`).
   * Held at execution to the operator's `tasks.maxRunInputTokens` when
   * one is configured, which also applies when this is unset. Unset with no
   * ceiling configured: no per-run cap.
   */
  maxInputTokens?: number;

  /**
   * Max execution time in ms for a single run. Default: 120_000 (2 minutes).
   * Held at execution to the operator's `tasks.maxRunDurationMs`.
   */
  maxRunDurationMs?: number;

  /** Model override for this task. Null = workspace default. */
  model?: string | null;

  /** Whether this task is active. */
  enabled: boolean;

  /** User ID of the task owner. Set at creation time. Used for scheduled runs. */
  ownerId?: string;

  /** Workspace this task belongs to. Set at creation time. Used for scheduled runs. */
  workspaceId?: string;

  /** Who created this task. */
  source: TaskSource;

  /** ISO timestamp. */
  createdAt: string;

  /** ISO timestamp. */
  updatedAt: string;

  // --- Scheduling state (persisted, survives restarts) ---

  /** ISO timestamp of last completed run. */
  lastRunAt?: string;

  /** Status of last completed run. */
  lastRunStatus?: "success" | "degraded" | "failure" | "timeout" | "skipped";

  /** ISO timestamp of next scheduled run. */
  nextRunAt?: string;

  /**
   * The scheduled run in flight, written before the executor is called and
   * cleared by the write that records the run and advances `nextRunAt`. Found
   * at start, it names a run the process stopped under: the scheduler records
   * it and moves to the next occurrence rather than running it again, since
   * the run may already have done part of its work.
   */
  scheduledRunInFlight?: ScheduledRunInFlight;

  /** Total completed runs. */
  runCount: number;

  /** Consecutive failed runs (resets on success). Drives backoff. */
  consecutiveErrors: number;

  /** ISO timestamp when auto-disabled. */
  disabledAt?: string;

  /** Reason the task was auto-disabled. */
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
// Assessment (acceptance criteria and the judge)
// ---------------------------------------------------------------------------

/**
 * One acceptance criterion, in the judge contract's shape so a task's criteria
 * go to the judge unchanged. `pass` is the runtime's pass rule; a judge
 * carries it and never applies it.
 *
 *   - boolean: passes when the answer equals `pass` (default `true`).
 *   - score:   `levels` are ordered lowest first; passes when the level reached
 *              is at least `pass` (default: the upper half, see
 *              `defaultScorePass`).
 *   - choice:  passes when the answer is `pass` or one of `pass` (required).
 */
export interface Criterion {
  id: string;
  rule: string;
  type: "boolean" | "score" | "choice";
  levels?: string[];
  options?: string[];
  pass?: boolean | number | string | string[];
}

/** Which judge answers a task's criteria. */
export interface TaskJudge {
  /** The connected source to call; required only when more than one judge server is connected. */
  server?: string;
  /** A judge id from that server's `list_judges`. Absent: its default judge. */
  id?: string;
  /** That judge's settings, valid against its `options_schema`. Needs `id`. */
  options?: Record<string, unknown>;
}

/** What a `fail` assessment sets off (see {@link Task.onPoorResult}). */
export type OnPoorResult = "record" | "notify" | "retry_once";

/** Confidence threshold when a task sets none. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/** `onPoorResult` when a task sets none. */
export const DEFAULT_ON_POOR_RESULT: OnPoorResult = "notify";

/** Whether a run's deliverable is acceptable (ADR-0045). */
export type AssessmentVerdict = "pass" | "fail" | "uncertain" | "not_assessed";

/** One criterion as judged and decided. */
export interface CriterionResult {
  id: string;
  /** The judge's answer: a boolean, a level index, or an option. */
  answer: boolean | number | string;
  /** Decided by the runtime from the criterion's pass rule. */
  passed: boolean;
  confidence: number;
  probabilities?: Record<string, number>;
  rationale?: string;
}

/** A person's verdict on a run. It replaces the judge's in the derived label. */
export interface HumanVerdict {
  verdict: "pass" | "fail";
  note?: string;
  /** The user who set it. */
  by: string;
  /** `ui`: set from the first-party web shell. `remote`: any other caller. */
  via: "ui" | "remote";
  at: string;
}

/**
 * Whether a run's deliverable is acceptable, recorded on the run. Never
 * changes the run's execution (its `status`).
 */
export interface RunAssessment {
  verdict: AssessmentVerdict;
  /**
   * Why: `nothing_to_check` for `not_assessed`, `schema_invalid` for a schema
   * `fail`, or why criteria could not be judged for an `uncertain` with no
   * criterion answers (`no_judge`, `judge_ambiguous`, `judge_not_found`,
   * `judge_error`, `judge_unavailable`, `judge_refused`, `judge_unreadable`, ...).
   */
  reason?: { code: string; message: string };
  /** The output schema check, when the task has an output schema. */
  schema?: { valid: boolean; errors?: string[] };
  criteria?: CriterionResult[];
  /** The source called and the judge that answered. */
  judge?: { server: string; id: string; version?: string; calibrated: boolean };
  /** The judge's reported usage. */
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  /** True when the state sent to the judge was cut to fit its size cap. */
  stateTruncated?: boolean;
  assessedAt: string;
  human?: HumanVerdict;
}

/**
 * How a run ended, in ADR-0045's vocabulary, derived from the stored
 * `status`, `stopReason`, and whether a deliverable exists (never stored).
 */
export type RunExecution =
  | "queued"
  | "running"
  | "skipped"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

/** The one label a person sees for a run, derived from execution and assessment (never stored). */
export type RunLabel =
  | "Succeeded"
  | "Poor result"
  | "Needs review"
  | "Failed"
  | "Skipped"
  | "Cancelled"
  | "Queued"
  | "Running";

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
// Schedule Specification
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
 * The run limits a task already carries bound how much ONE run costs;
 * none of them bounds how many runs there are, because a run that succeeds
 * every time never trips consecutive-error auto-disable. A self-feeding loop —
 * a run approves something, the connector emits the fact, the route fires the
 * run — is exactly that shape, so this is the bound that terminates it.
 */
export const DEFAULT_EVENT_MAX_FIRES_PER_HOUR = 12;

/** Highest fire ceiling an event schedule may ask for. */
export const MAX_EVENT_MAX_FIRES_PER_HOUR = 60;

/** What `disabledReason` says when the fire ceiling turned a task off. */
export const EVENT_FIRE_CEILING_REASON = "event_fire_ceiling";

/**
 * How late a once schedule may still fire after the runtime was down at its
 * time. Judged once, when the scheduler starts: a once whose `at` passed more
 * than this long ago is recorded as skipped and goes inert, because a one-time
 * action hours after its time is more often wrong than useful (an email sent
 * the next morning). A once deferred while running because every run slot is
 * busy is never judged late; it waits for a slot however long that takes.
 */
export const ONCE_GRACE_MS = 3_600_000;

/** What `disabledReason` (display text only) starts with once a once schedule has fired. */
export const ONCE_RAN_REASON = "Ran once at ";

/** What `disabledReason` (display text only) starts with when a once schedule missed its time. */
export const ONCE_MISSED_REASON = "Missed its one time at ";

/**
 * When a task runs.
 *
 * Four kinds, discriminated by `type`, with each kind's own fields optional on
 * the shared shape — the arrangement `cron` and `interval` already had.
 *
 * `cron`, `interval`, and `once` are positions in time and the scheduler's
 * timer arms itself to them. A `once` fires at `at` and then leaves the
 * task inert (disabled, no next run) until a new `at` re-arms it. `event`
 * is not a position in time: it has no next run, the timer never arms for
 * it, and it fires when a notification the workspace routed to it arrives.
 * Reaching a task that way is an operator's decision twice over — an
 * admin writes the route that names it, and the task's own `match` says
 * which of the routed items it wants — so neither half alone opens the path.
 */
export interface ScheduleSpec {
  type: "cron" | "interval" | "event" | "once";

  /** Standard 5-field cron expression. Required when type is "cron". */
  expression?: string;

  /** IANA timezone. Defaults to home.timezone or system timezone. */
  timezone?: string;

  /**
   * The moment a `once` schedule fires: an ISO-8601 timestamp with an explicit
   * offset (`2026-07-01T13:12:00-07:00` or `…Z`). Required when type is "once".
   */
  at?: string;

  /** Interval in milliseconds. Required when type is "interval". Minimum: 60_000 (1 min). */
  intervalMs?: number;

  /**
   * Which notifications this task wants. Required when type is "event".
   *
   * The same match expression a delivery route carries, imported rather than
   * restated so one grammar governs both ends: a route decides that a path from
   * the inbox to this task exists at all, and this decides which of the
   * items arriving down it are worth a run.
   */
  match?: NotificationRouteMatch;

  /**
   * How long matching items coalesce into one batch before the run starts, in
   * milliseconds. Default {@link DEFAULT_EVENT_DEBOUNCE_MS}.
   */
  debounceMs?: number;

  /**
   * Most runs this task may fire from events in any rolling hour.
   * Default {@link DEFAULT_EVENT_MAX_FIRES_PER_HOUR}. Exceeding it disables the
   * task, through the same fields consecutive-error auto-disable uses.
   */
  maxFiresPerHour?: number;
}

/** Whether a schedule fires from notifications rather than from the clock. */
export function isEventSchedule(schedule: ScheduleSpec | undefined): boolean {
  return schedule?.type === "event";
}

/** Whether a schedule fires once, at `at`. */
export function isOnceSchedule(schedule: ScheduleSpec | undefined): boolean {
  return schedule?.type === "once";
}

/**
 * Whether a once task has fired (`ran`) or missed its time (`missed`)
 * and is inert until re-armed, or null when it is not a once task or is
 * still to come. Read from {@link Task.onceDone}.
 */
export function onceRetirement(task: Pick<Task, "schedule" | "onceDone">): "ran" | "missed" | null {
  if (!isOnceSchedule(task.schedule)) return null;
  return task.onceDone?.outcome ?? null;
}

/** A scheduled run that has started and not yet been recorded ({@link Task.scheduledRunInFlight}). */
export interface ScheduledRunInFlight {
  runId: string;
  startedAt: string;
  /** The once occurrence the run is (`schedule.at` at dispatch), so settling it retires only that one. */
  onceAt?: string;
}

// ---------------------------------------------------------------------------
// Task Run
// ---------------------------------------------------------------------------

export interface TaskRun {
  id: string;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  /**
   * `degraded`: the run finished, but a tool call failed and no later call made
   * it good, so part of its work did not happen (`error` names the tools). It is
   * not a failure: it neither extends an error streak nor backs the schedule off.
   */
  /**
   * `queued` and `running` appear only on an open run's ticket (see
   * {@link RunTicket}); the run index holds only runs that ended or never started.
   */
  status:
    | "queued"
    | "running"
    | "success"
    | "degraded"
    | "failure"
    | "timeout"
    | "cancelled"
    | "skipped";
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
   * Absent on the record of a run that never started (the reason names what
   * asked for it), so the fire ceiling counts only fires that ran. Absent too
   * on records written before the field existed, which is why the ceiling
   * counts `"event"` explicitly rather than everything that is not scheduled.
   */
  trigger?: "scheduled" | "manual" | "event";
  /** Final agent response, truncated for the run list. The full deliverable,
   *  activity log, and output-file refs live in the run's `TaskRunResult`
   *  sidecar (see {@link TaskRunResult}). */
  resultPreview?: string;
  /**
   * Engine-level stop reason. Mirrors `StopReason` from `src/engine/types.ts`
   * (intentionally duplicated here to keep this app's types decoupled
   * from the engine package). Keep in sync when the engine union changes.
   */
  stopReason?:
    | "complete"
    | "max_iterations"
    | "max_input_tokens"
    | "spend_limit"
    | "length"
    | "content_filter"
    | "error"
    | "other";
  /** The spend account that stopped the run, when `stopReason` is `spend_limit`. */
  spendAccountId?: string;
  /** The JSON input the run was given (`tasks__run` `input`). */
  input?: unknown;
  /** The idempotency key the run was requested with; a repeat returns this run. */
  idempotencyKey?: string;
  /**
   * Whether the deliverable matched the task's `outputSchema`. Absent
   * when the task has none, or the run produced no deliverable.
   */
  outputSchemaValid?: boolean;
  /** Why the deliverable did not match the `outputSchema`, when it did not. */
  outputSchemaErrors?: string[];
  /**
   * Tools whose calls failed with no later call making them good, so part of
   * the run's work did not happen. Recorded whatever the status.
   */
  unrecoveredToolFailures?: string[];
  /** Whether the deliverable is acceptable; absent until assessed, and on runs with no deliverable. */
  assessment?: RunAssessment;
  /** The run this one retries (`onPoorResult: "retry_once"`). */
  retryOf?: string;
  /** The batch this run is an item of (`tasks__run_batch`). */
  batchId?: string;
  /** The item's index in its batch (0-based). Set with `batchId`. */
  batchIndex?: number;
  /**
   * What the run's model calls cost, in USD, at the model's known rates (0 for
   * a model with none). Computed from the usage the run reported; absent on a
   * run that never reached the model and on records from before it was kept.
   */
  costUsd?: number;
}

/**
 * A run requested by id (`tasks__run`), found again by that id alone.
 * `run` is the run's current record: `queued` or `running` while it is open,
 * then the same record the run index holds once it ends or is refused. A task
 * handle's status is read from here.
 */
export interface RunTicket {
  runId: string;
  taskId: string;
  /** When the run was asked for. */
  requestedAt: string;
  run: TaskRun;
}

// ---------------------------------------------------------------------------
// Task Run Result (the deliverable)
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
 * The full result of a task run — what the run *produced*, persisted
 * once per run as a sidecar to the lightweight {@link TaskRun} summary.
 * A task run is no longer a conversation: instead of a chat trace, it
 * leaves a deliverable (the final output), the activity log of what it did,
 * and references to any files it wrote (in the workspace file store).
 */
export interface TaskRunResult {
  /** Matches the owning {@link TaskRun.id}. */
  runId: string;
  taskId: string;
  completedAt: string;
  /** The agent's final deliverable, in full (untruncated). */
  output: string;
  /** What the run did — every tool call, in order. */
  activityLog: RunToolCall[];
  /** Files the run wrote, as refs into `workspaces/<wsId>/files/<ownerId>/`. */
  outputFiles: RunFileRef[];
  usage: { inputTokens: number; outputTokens: number; iterations: number };
  stopReason?: TaskRun["stopReason"];
  /**
   * The deliverable parsed as JSON, when the task has an `outputSchema`
   * and the output parsed. Kept whether or not it matched; the run record says
   * whether it did (`TaskRun.outputSchemaValid`).
   */
  structured?: unknown;
}

// ---------------------------------------------------------------------------
// Persistence — tasks.json structure
// ---------------------------------------------------------------------------

export interface TasksFile {
  version: number;
  updatedAtMs: number;
  tasks: Task[];
}

// ---------------------------------------------------------------------------
// Helper types — tool inputs
// ---------------------------------------------------------------------------

/** Input for tasks__create. Omits computed/state fields. */
export type CreateTaskInput = Omit<
  Task,
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
  | "scheduledRunInFlight"
  | "disabledAt"
  | "disabledReason"
  | "cumulativeInputTokens"
  | "cumulativeOutputTokens"
  | "budgetResetAt"
>;

/** Input for tasks__update. Partial of user-editable fields. */
export type UpdateTaskInput = Partial<
  Pick<
    Task,
    | "description"
    | "prompt"
    | "schedule"
    | "skill"
    | "allowedTools"
    | "inputSchema"
    | "outputSchema"
    | "criteria"
    | "confidenceThreshold"
    | "judge"
    | "onPoorResult"
    | "maxIterations"
    | "maxInputTokens"
    | "maxRunDurationMs"
    | "model"
    | "enabled"
    | "tokenBudget"
  >
>;

// ---------------------------------------------------------------------------
// Batch — one task run over many inputs (`tasks__run_batch`)
// ---------------------------------------------------------------------------

/**
 * Where a batch stands. `running`: its driver feeds items into runs.
 * `paused`: no new item starts (runs already started finish). `completed`:
 * every item has an outcome. `cancelled`: stopped for good.
 */
export type BatchState = "running" | "paused" | "completed" | "cancelled";

/**
 * Why a batch paused. `manual`: someone paused it. `budget`: its own budget,
 * or the task's token budget, has too little left for another run.
 * `pass_rate`: its stop rule fired. `unavailable`: its task can no longer be
 * run (deleted).
 */
export type BatchPauseReason = "manual" | "budget" | "pass_rate" | "unavailable";

/** Pause the batch when its pass rate collapses (see `Batch.stopWhen`). */
export interface BatchStopRule {
  /** 0..1. The batch pauses when pass / (pass + fail) falls below it. */
  minPassRate: number;
  /** Assessed runs (pass, fail, or uncertain) before the rule is applied. */
  afterItems: number;
}

/**
 * How many of a batch's items are in each state. Derived from the items
 * (`countItems`); the batch record keeps a copy, rebuilt at boot.
 */
export interface BatchCounts {
  /** Not asked for yet. */
  pending: number;
  /** Asked for, waiting for a run slot. */
  queued: number;
  running: number;
  /** Ended with a deliverable, by its assessment. */
  pass: number;
  fail: number;
  uncertain: number;
  not_assessed: number;
  /** Ended without a deliverable. */
  failed: number;
  /** Never started (refused at the door). */
  skipped: number;
  cancelled: number;
}

/**
 * A batch: the task it runs (by id; each run reads the task as it is when the
 * run starts), its own settings, and where it stands.
 * `…/tasks/<ownerId>/batches/<id>.json`.
 */
export interface Batch {
  /** `batch_<12 hex>`. */
  id: string;
  /** The task every item runs (a saved task, or the one-off an inline call made). */
  taskId: string;
  workspaceId: string;
  ownerId: string;
  /** How many items; their inputs and outcomes are in `<id>.items.jsonl`. */
  items: number;
  /** Most of the batch's runs asked for at once (queued or running); at most `tasks.maxConcurrentRuns`. */
  concurrency: number;
  /** Whole-batch ceiling in USD, enforced before each model call as one shared spend account. */
  budgetUsd?: number;
  stopWhen?: BatchStopRule;
  /** True once a resume after a `pass_rate` pause: the stop rule is not applied again. */
  stopRuleDisarmed?: boolean;
  state: BatchState;
  /** Set while paused. */
  pause?: { reason: BatchPauseReason; message: string; at: string };
  counts: BatchCounts;
  /** What the batch's runs cost so far, summed from its items. */
  costUsd: number;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** The user who asked for it. */
  createdBy: string;
}

/** Where one item stands. `done` carries its outcome. */
export type BatchItemState = "pending" | "queued" | "running" | "done";

/** One item of a batch, folded from its lines in `<id>.items.jsonl`. */
export interface BatchItem {
  index: number;
  input: unknown;
  state: BatchItemState;
  /** The item's current run, once asked for. */
  runId?: string;
  /** Runs of this item that `rerun_failed` replaced, oldest first. */
  previousRunIds?: string[];
  /** How the current run ended (with `state: "done"`). */
  execution?: RunExecution;
  /** The current run's effective verdict, when it left a deliverable and was assessed. */
  verdict?: AssessmentVerdict;
  /**
   * The current run finished with part of its work undone (unrecovered tool
   * failures, or `degraded`), so it never reads Succeeded.
   */
  degraded?: boolean;
  /** What every run of this item has cost so far, in USD. */
  costUsd?: number;
  /** Why the run did not succeed, when it says. */
  error?: string;
}
