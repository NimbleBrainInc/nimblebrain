/**
 * Task tool handlers + helpers for the in-process `tasks` platform
 * source (`src/platform/tasks/source.ts`). Exposes the create / update /
 * delete / list / status / runs / run_result / run / cancel handlers and the
 * `ToolContext` they run against. The former standalone stdio MCP server was
 * removed when tasks moved in-process and workspace-owned; this file is
 * handlers + formatting only.
 */

import { createHash, randomBytes } from "node:crypto";
import { Cron } from "croner";
import {
  describeClampedLimits,
  type EffectiveRunLimits,
  effectiveRunLimits,
} from "../../config/tasks.ts";
import { MAX_ITERATIONS, TASKS_LIST_DEFAULT_LIMIT, TASKS_LIST_MAX_LIMIT } from "../../limits.ts";
import type {
  TaskEffectiveLimits,
  TaskRunStats,
  TaskSummary,
  TasksAssessOutput,
  TasksCancelOutput,
  TasksCreateOutput,
  TasksDeleteOutput,
  TasksJudgesOutput,
  TasksListOutput,
  TasksRunOutput,
  TasksRunResultOutput,
  TasksRunsOutput,
  TasksStatsOutput,
  TasksStatusOutput,
  TasksUpcomingOutput,
  TasksUpdateOutput,
  TaskUpcomingEventTask,
  TaskUpcomingFire,
  TaskUpcomingFrequent,
  TaskUpcomingRun,
  TaskWarning,
} from "../schemas/tasks.ts";
import {
  effectiveVerdict,
  executionOf,
  isAssessable,
  labelOf,
  toRunView,
  validateAssessmentFields,
} from "./assessment.ts";
import type { BatchAction, BatchControlResult } from "./batch.ts";
import { createTask, deleteTask, updateTask } from "./domain.ts";
import { containsRecursiveTool } from "./executor.ts";
import { assertJsonSchema, checkAgainstSchema } from "./json-schema.ts";
import { type JudgeSourceView, judgeServersOf } from "./judge.ts";
import {
  countsAsEventFire,
  isOpenRun,
  type QueueViewEntry,
  type RequestedRun,
  type RunNowTicket,
} from "./scheduler.ts";
import type { ReadRunsOptions, RunsPage } from "./store.ts";
import {
  type Batch,
  type BatchItem,
  type BatchStopRule,
  type Criterion,
  DEFAULT_EVENT_DEBOUNCE_MS,
  DEFAULT_EVENT_MAX_FIRES_PER_HOUR,
  isEventSchedule,
  kindOf,
  MAX_EVENT_DEBOUNCE_MS,
  MAX_EVENT_MAX_FIRES_PER_HOUR,
  type OnPoorResult,
  onceRetirement,
  type RunTicket,
  type ScheduleSpec,
  type Task,
  type TaskJudge,
  type TaskKind,
  type TaskRun,
  type TaskRunResult,
  type TokenBudget,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TIMEZONE = process.env.NB_TIMEZONE ?? "Pacific/Honolulu";

function log(msg: string): void {
  process.stderr.write(`[tasks] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Human-readable formatting helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Convert a schedule into a human-readable string. `state` lets a once
 * schedule say whether it has run ("Ran once at …") or is still to come.
 */
export function formatSchedule(
  schedule: ScheduleSpec | undefined,
  state?: Pick<Task, "onceDone">,
): string {
  if (!schedule) return "Manual only";

  if (schedule.type === "once" && schedule.at) {
    const when = formatInstant(schedule.at, schedule.timezone);
    const retired = state ? onceRetirement({ schedule, ...state }) : null;
    if (retired === "ran") return `Ran once at ${when}`;
    if (retired === "missed") return `Missed its time (${when})`;
    return `Once at ${when}`;
  }

  if (schedule.type === "interval" && schedule.intervalMs) {
    return formatIntervalSchedule(schedule.intervalMs);
  }

  if (schedule.type === "cron" && schedule.expression) {
    return formatCronExpression(schedule.expression, schedule.timezone);
  }

  if (isEventSchedule(schedule)) return formatEventSchedule(schedule);

  return "Unknown schedule";
}

/**
 * Render an event schedule as the notifications it waits for.
 *
 * There is no time in it to render, so this names the match — which is the
 * whole of what an operator needs to recognise the task in a list.
 */
function formatEventSchedule(schedule: ScheduleSpec): string {
  const match = schedule.match ?? {};
  const parts: string[] = [];
  if (match.source) parts.push(`from ${match.source}`);
  if (match.name) parts.push(`matching ${match.name}`);
  if (match.level) parts.push(`at ${match.level} or above`);
  return parts.length > 0 ? `On notifications ${parts.join(", ")}` : "On any routed notification";
}

/** Render an ISO instant as a date and time in `timezone` (default the instance's). */
function formatInstant(iso: string, timezone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const tz = timezone ?? DEFAULT_TIMEZONE;
  try {
    const text = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    return `${text} ${formatTimezoneAbbr(tz)}`;
  } catch {
    return iso;
  }
}

/** Render an interval (in ms) as "Every N minutes/hours/days". */
function formatIntervalSchedule(intervalMs: number): string {
  const mins = Math.round(intervalMs / 60_000);
  if (mins < 60) return `Every ${mins} minute${mins === 1 ? "" : "s"}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Every ${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.round(hrs / 24);
  return `Every ${days} day${days === 1 ? "" : "s"}`;
}

function formatCronExpression(expr: string, timezone?: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [minute, hour, _dayOfMonth, _month, dayOfWeek] = parts;
  const tz = timezone ?? DEFAULT_TIMEZONE;
  const tzAbbr = formatTimezoneAbbr(tz);

  // "0 8 * * *" → "Daily at 8:00 AM HST"
  if (
    _dayOfMonth === "*" &&
    _month === "*" &&
    dayOfWeek === "*" &&
    hour !== "*" &&
    minute !== "*"
  ) {
    const timeStr = formatTime(Number(hour), Number(minute));
    return `Daily at ${timeStr} ${tzAbbr}`;
  }

  // "0 9 * * 1" → "Mondays at 9:00 AM HST"
  if (
    _dayOfMonth === "*" &&
    _month === "*" &&
    dayOfWeek !== "*" &&
    hour !== "*" &&
    minute !== "*"
  ) {
    const dayName = cronDayName(dayOfWeek!);
    const timeStr = formatTime(Number(hour), Number(minute));
    return `${dayName} at ${timeStr} ${tzAbbr}`;
  }

  // "*/30 * * * *" → "Every 30 minutes"
  if (
    minute?.startsWith("*/") &&
    hour === "*" &&
    _dayOfMonth === "*" &&
    _month === "*" &&
    dayOfWeek === "*"
  ) {
    const interval = Number(minute.slice(2));
    return `Every ${interval} minute${interval === 1 ? "" : "s"}`;
  }

  return expr;
}

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  const displayMinute = minute.toString().padStart(2, "0");
  return `${displayHour}:${displayMinute} ${period}`;
}

function formatTimezoneAbbr(tz: string): string {
  if (tz === "Pacific/Honolulu") return "HST";
  if (tz === "America/New_York") return "EST";
  if (tz === "America/Chicago") return "CST";
  if (tz === "America/Denver") return "MST";
  if (tz === "America/Los_Angeles") return "PST";
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
  return tz;
}

function cronDayName(dayOfWeek: string): string {
  const days: Record<string, string> = {
    "0": "Sundays",
    "1": "Mondays",
    "2": "Tuesdays",
    "3": "Wednesdays",
    "4": "Thursdays",
    "5": "Fridays",
    "6": "Saturdays",
    "7": "Sundays",
  };
  return days[dayOfWeek] ?? `Day ${dayOfWeek}`;
}

/** Format an ISO timestamp as a relative time string. */
export function formatRelativeTime(isoTimestamp: string, now?: number): string {
  const targetMs = new Date(isoTimestamp).getTime();
  const nowMs = now ?? Date.now();
  const diffMs = targetMs - nowMs;
  const absDiffMs = Math.abs(diffMs);

  if (absDiffMs < 60_000) return diffMs >= 0 ? "in <1m" : "<1m ago";

  const minutes = Math.floor(absDiffMs / 60_000);
  if (minutes < 60) {
    return diffMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }

  const hours = Math.floor(absDiffMs / 3_600_000);
  if (hours < 24) {
    return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }

  const days = Math.floor(absDiffMs / 86_400_000);
  return diffMs >= 0 ? `in ${days}d` : `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Cost estimation helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Approximate cost rates per 1M tokens (USD) for known model families. */
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-sonnet": { input: 3, output: 15 },
  "claude-haiku": { input: 0.8, output: 4 },
  "claude-opus": { input: 15, output: 75 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

export function getModelRates(model: string | null | undefined): { input: number; output: number } {
  if (!model) return MODEL_RATES["claude-sonnet"]!; // default
  const lower = model.toLowerCase();
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (lower.includes(key)) return rates;
  }
  return MODEL_RATES["claude-sonnet"]!; // fallback
}

export function estimateRunsPerDay(schedule: ScheduleSpec | undefined): number {
  // No schedule, or one moment: no daily rate to project. A once's single run
  // is a one-time cost, not a daily one.
  if (!schedule || schedule.type === "once") return 0;
  if (schedule.type === "interval" && schedule.intervalMs) {
    return 86_400_000 / schedule.intervalMs;
  }
  // An event schedule's run rate is a property of the connector, not of the
  // definition, so there is nothing here to estimate from — the fire ceiling is
  // the only number this side knows, and it is a bound rather than a rate.
  // Zero, so a cost projection reads as "not from the schedule" rather than as
  // a daily figure nothing supports.
  if (isEventSchedule(schedule)) return 0;

  if (schedule.type === "cron" && schedule.expression) {
    const parts = schedule.expression.trim().split(/\s+/);
    if (parts.length !== 5) return 1;
    const [minute, hour, , , dow] = parts;
    if (minute?.startsWith("*/")) return (24 * 60) / Number(minute.slice(2));
    if (hour === "*") return 24;
    if (dow !== "*") return 1 / 7; // weekly
    return 1; // daily
  }
  return 1;
}

export interface CostEstimate {
  perRunUsd: number;
  perDayUsd: number;
  perMonthUsd: number;
}

export function estimateCost(task: Task, workspaceDefaultModel?: string): CostEstimate {
  const rates = getModelRates(task.model ?? workspaceDefaultModel);
  // Use actual average if available, otherwise a realistic per-run estimate.
  // maxInputTokens is a ceiling (unset = none), NOT an estimate — actual runs
  // typically use 15-25K input tokens. Using the ceiling produces wildly inflated costs.
  const hasHistory = task.runCount > 0 && task.cumulativeInputTokens > 0;
  const inputTokens = hasHistory ? task.cumulativeInputTokens / task.runCount : 20_000; // realistic per-run estimate
  const outputTokens = hasHistory ? task.cumulativeOutputTokens / task.runCount : 500;
  const perRunUsd = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  const runsPerDay = estimateRunsPerDay(task.schedule);
  return {
    perRunUsd,
    perDayUsd: perRunUsd * runsPerDay,
    perMonthUsd: perRunUsd * runsPerDay * 30,
  };
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a kebab-case id from a name. */
export function toKebabCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Tool handler implementations (exported for direct testing)
// ---------------------------------------------------------------------------

export interface ToolContext {
  definitions: () => Map<string, Task>;
  save: (defs: Map<string, Task>) => void;
  reloadScheduler: () => void;
  /**
   * Ask the scheduler to run the task now; null when it is not loaded.
   * `requested` names the run (its id, input, and idempotency key), and the
   * run's ticket is written before this returns.
   */
  runNow: (taskId: string, requested?: RequestedRun) => RunNowTicket | null;
  /**
   * A requested run's ticket by run id (this owner, this workspace), settled
   * first when it was left open by a process that stopped. Null when none.
   */
  readRunTicket?: (runId: string) => RunTicket | null;
  /** The run an idempotency key started on this task, as its ticket; null when none. */
  findRunByKey?: (taskId: string, key: string) => RunTicket | null;
  /** A queued run's place in the run queue (1 is next), or null when it is not queued. */
  queuePosition?: (taskId: string) => number | null;
  cancelRun: (taskId: string) => boolean;
  /** Read one task's run history (workspace + owner bound at construction). */
  readRuns: (taskId: string, opts?: ReadRunsOptions) => TaskRun[];
  /** Read one page of a task's full history, back through its archive months. */
  readRunsPage: (taskId: string, opts: ReadRunsOptions) => RunsPage;
  /** Read run history across this owner's tasks in the focused workspace. */
  readAllRuns: (opts?: ReadRunsOptions) => TaskRun[];
  /** Read one run's full result sidecar (the deliverable). */
  readRunResult: (taskId: string, runId: string) => TaskRunResult | null;
  /** One run's record by id, hot or archived; null when it has none. */
  findRun?: (taskId: string, runId: string) => TaskRun | null;
  /** Rewrite one run's record (its index line and ticket); null when it has none. */
  updateRun?: (taskId: string, runId: string, update: (run: TaskRun) => TaskRun) => TaskRun | null;
  /**
   * Judge a run again with its task's current schema and criteria, and
   * record the new assessment (keeping a person's verdict). Null when the run
   * has no record. Absent where no judge port is wired.
   */
  reassessRun?: (task: Task, run: TaskRun) => Promise<TaskRun | null>;
  /**
   * Where the call in scope came from: `ui` for the first-party web shell
   * (its REST tool call, or an app view's `/mcp` call), `remote` for any other
   * caller. Attribution only.
   */
  callerVia?: () => "ui" | "remote";
  defaultTimezone: string;
  /**
   * The caps a run of a task executes under, for create and update to
   * report. The executor applies the same function. Absent: the built-in
   * ceilings and the runtime's built-in iteration default.
   */
  runLimitsOf?: (task: Task) => EffectiveRunLimits;
  /** Workspace default model (for cost estimation when task.model is null). */
  defaultModel?: string;
  /** Current user ID (for setting task ownership at creation time). */
  currentUserId?: string;
  /** Current workspace ID (for setting task workspace scope at creation time). */
  currentWorkspaceId?: string;
  /**
   * Override the `handleRun` sync-wait deadline (ms). Production callers
   * leave this unset and get the default `HANDLE_RUN_SYNC_WAIT_MS`; tests
   * use it to exercise the "dispatched, still running" envelope without
   * having to wait 30s. Has no effect outside `handleRun`.
   */
  handleRunSyncWaitMs?: number;
  /**
   * This owner's batches in this workspace (`batch-tools.ts`). Absent where
   * no batch driver is wired.
   */
  batches?: BatchPort;
  /** This owner's runs in this workspace holding a run slot or waiting for one. */
  queueView?: () => QueueViewEntry[];
  /** The sources connected in this workspace, with their tool names (judge discovery). */
  judgeSources?: () => Promise<JudgeSourceView[]>;
}

/** The batch driver, bound to the caller's workspace and owner. */
export interface BatchPort {
  create(spec: {
    task: Task;
    inputs: readonly unknown[];
    concurrency: number;
    budgetUsd?: number;
    stopWhen?: BatchStopRule;
    idempotencyKey?: string;
  }): Batch;
  get(batchId: string): { batch: Batch; items: BatchItem[] } | null;
  /** The batch an idempotency key made, or null. */
  findByKey(key: string): Batch | null;
  control(batchId: string, action: BatchAction, budgetUsd?: number): BatchControlResult;
  /** Newest first. */
  list(): Batch[];
  /** The runtime's concurrent-run limit: a batch's concurrency is held to it. */
  maxConcurrentRuns: number;
}

/**
 * Validate schedule, iteration, and token fields. Throws on invalid input.
 *
 * Accepts either a full create-manifest or a partial update-patch — both
 * have the same load-bearing fields (`schedule`, `maxIterations`,
 * `maxInputTokens`, `maxRunDurationMs`). The signature is the union so
 * callers don't need synthetic flat-record casts.
 */
export interface ValidatableTaskFields {
  /** `null` is an update's clear: nothing to validate. */
  schedule?: ScheduleSpec | null;
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  allowedTools?: string[];
  /** `null` is an update's clear: nothing to validate. */
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  criteria?: Criterion[] | null;
  confidenceThreshold?: number | null;
  judge?: TaskJudge | null;
  onPoorResult?: OnPoorResult | null;
}

export function validateTaskFields(args: ValidatableTaskFields): void {
  if (args.schedule) validateSchedule(args.schedule);
  validateNumericLimits(args);
  validateAssessmentFields(args);
  if (args.inputSchema != null) assertJsonSchema(args.inputSchema, "inputSchema");
  if (args.outputSchema != null) assertJsonSchema(args.outputSchema, "outputSchema");
  // The executor refuses to run such a task; refusing it here tells the
  // author at write time instead of at the first run.
  const recursive = containsRecursiveTool(args.allowedTools);
  if (recursive !== null) {
    throw new Error(
      `allowedTools may not include "${recursive}": a task cannot create, update, or ` +
        "delete tasks from its own runs.",
    );
  }
}

/**
 * Validate an event schedule's own fields. Throws on invalid input.
 *
 * `match` is required because an event schedule without one runs on everything
 * a route sends it, which is a decision worth writing down rather than falling
 * into. Both bounds are two-sided: a debounce of a day is a run nobody connects
 * to the thing that caused it, and a ceiling of a thousand is not a ceiling.
 */
function validateEventSchedule(schedule: ScheduleSpec): void {
  if (!schedule.match) {
    throw new Error(
      "match is required for event schedules — say which notifications should run this " +
        'task, e.g. { source: "acme", name: "reply.*" }',
    );
  }
  const debounce = schedule.debounceMs;
  if (debounce != null && (debounce < 1000 || debounce > MAX_EVENT_DEBOUNCE_MS)) {
    throw new Error(
      `debounceMs must be between 1000 and ${MAX_EVENT_DEBOUNCE_MS} ` +
        `(default ${DEFAULT_EVENT_DEBOUNCE_MS})`,
    );
  }
  const fires = schedule.maxFiresPerHour;
  if (
    fires != null &&
    (!Number.isInteger(fires) || fires < 1 || fires > MAX_EVENT_MAX_FIRES_PER_HOUR)
  ) {
    throw new Error(
      `maxFiresPerHour must be a whole number between 1 and ${MAX_EVENT_MAX_FIRES_PER_HOUR} ` +
        `(default ${DEFAULT_EVENT_MAX_FIRES_PER_HOUR})`,
    );
  }
}

/** An ISO-8601 timestamp that names its offset (`Z` or `±HH:MM`), so it means one instant. */
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a once schedule. Throws on invalid input.
 *
 * The offset is required because a bare local time names a different instant
 * on every server, and a time in the past is refused because the schedule
 * would never fire it (creating one, or re-arming one, is a request to act
 * later, never "now").
 */
function validateOnceSchedule(schedule: ScheduleSpec, now: number): void {
  const at = schedule.at;
  if (!at) {
    throw new Error(
      'at is required for once schedules — an ISO-8601 time with an offset, e.g. "2026-07-01T13:12:00-07:00"',
    );
  }
  const ms = new Date(at).getTime();
  if (!ISO_WITH_OFFSET_RE.test(at) || Number.isNaN(ms)) {
    throw new Error(
      `Invalid once time "${at}": use an ISO-8601 time with an offset, e.g. "2026-07-01T13:12:00-07:00"`,
    );
  }
  if (ms <= now) {
    throw new Error(
      `Once time "${at}" has already passed. Give a time in the future; to run it now, use tasks__run.`,
    );
  }
  if (schedule.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone });
    } catch {
      throw new Error(`Unknown timezone "${schedule.timezone}"`);
    }
  }
}

/** Validate a schedule spec's type-specific fields. Throws on invalid input. */
function validateSchedule(schedule: ScheduleSpec): void {
  if (schedule.type === "once") {
    validateOnceSchedule(schedule, Date.now());
    return;
  }
  if (schedule.type === "interval") {
    if (schedule.intervalMs == null) {
      throw new Error("intervalMs is required for interval schedules");
    }
    if (schedule.intervalMs < 60_000) {
      throw new Error("Interval must be at least 1 minute (60000ms)");
    }
  }
  if (isEventSchedule(schedule)) {
    validateEventSchedule(schedule);
    return;
  }
  if (schedule.type === "cron") {
    if (!schedule.expression) {
      throw new Error("expression is required for cron schedules");
    }
    validateCronExpression(schedule.expression, schedule.timezone);
  }
}

/**
 * Validate a cron expression by constructing a Croner instance and asking it
 * for the next run. Throws on a parse error, an unknown timezone, or an
 * expression that matches no future date (`0 9 31 2 *`, or a year that has
 * passed), which the scheduler could never place in time.
 */
function validateCronExpression(expression: string, timezone?: string): void {
  let next: Date | null;
  try {
    next = new Cron(expression, { timezone }).nextRun();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression: ${msg}`);
  }
  if (next === null) {
    throw new Error(
      `Invalid cron expression: "${expression}" matches no future date, so it would never run`,
    );
  }
}

/** Validate the optional numeric limit fields against their allowed ranges. Throws on out-of-range. */
function validateNumericLimits(args: ValidatableTaskFields): void {
  const { maxIterations, maxInputTokens, maxRunDurationMs } = args;
  if (maxIterations != null && (maxIterations < 1 || maxIterations > MAX_ITERATIONS)) {
    throw new Error(`maxIterations must be between 1 and ${MAX_ITERATIONS}`);
  }
  if (maxInputTokens != null && (maxInputTokens < 1_000 || maxInputTokens > 1_000_000)) {
    throw new Error("maxInputTokens must be between 1,000 and 1,000,000");
  }
  if (maxRunDurationMs != null && (maxRunDurationMs < 10_000 || maxRunDurationMs > 600_000)) {
    throw new Error("maxRunDurationMs must be between 10 seconds and 10 minutes");
  }
}

/**
 * Strict input shape for `tasks__create`. The validator has already
 * enforced shape — handler reads typed fields directly. The operator-only
 * field `source` is NOT in this shape; the LLM-facing handler hardcodes
 * `source: "agent"`. An internal caller bypasses this handler and calls
 * `createTask` from `domain.ts` directly with the full shape.
 */
interface CreateInput {
  manifest: {
    name: string;
    description?: string;
    schedule?: ScheduleSpec;
    enabled?: boolean;
    skill?: string;
    model?: string;
    maxIterations?: number;
    maxInputTokens?: number;
    maxRunDurationMs?: number;
    allowedTools?: string[];
    tokenBudget?: Task["tokenBudget"];
    kind?: TaskKind;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    criteria?: Criterion[];
    confidenceThreshold?: number;
    judge?: TaskJudge;
    onPoorResult?: OnPoorResult;
  };
  body: string;
}

export function handleCreate(args: Record<string, unknown>, ctx: ToolContext): TasksCreateOutput {
  const { manifest, body } = args as unknown as CreateInput;

  validateTaskFields(manifest);

  const result = createTask(
    {
      name: manifest.name,
      prompt: body,
      schedule: manifest.schedule,
      description: manifest.description,
      skill: manifest.skill,
      model: manifest.model,
      maxIterations: manifest.maxIterations,
      maxInputTokens: manifest.maxInputTokens,
      maxRunDurationMs: manifest.maxRunDurationMs,
      allowedTools: manifest.allowedTools,
      tokenBudget: manifest.tokenBudget,
      enabled: manifest.enabled,
      kind: manifest.kind,
      inputSchema: manifest.inputSchema,
      outputSchema: manifest.outputSchema,
      criteria: manifest.criteria,
      confidenceThreshold: manifest.confidenceThreshold,
      judge: manifest.judge,
      onPoorResult: manifest.onPoorResult,
      // LLM-facing path: stamp `agent` source and derive ownership from
      // request context.
      source: "agent",
      ownerId: ctx.currentUserId,
      workspaceId: ctx.currentWorkspaceId,
    },
    ctx,
  );
  return withEffectiveLimits(result, ctx);
}

/**
 * Attach the caps the task's runs execute under, and name any cap the
 * definition sets above its ceiling, so the caller learns at write time what a
 * run will actually be held to.
 */
function withEffectiveLimits<T extends { task: Task; message: string }>(
  result: T,
  ctx: ToolContext,
): T & { effectiveLimits: TaskEffectiveLimits } {
  const effectiveLimits = (ctx.runLimitsOf ?? effectiveRunLimits)(result.task);
  const notes = describeClampedLimits(result.task, effectiveLimits);
  const message = notes.length > 0 ? `${result.message} ${notes.join(" ")}` : result.message;
  return { ...result, message, effectiveLimits };
}

/**
 * Strict input shape for `tasks__update`. `manifest` is a partial
 * of the create-shape; `body` is an optional new prompt. `name` at root
 * is the reference key — `manifest.name` cannot be patched (renaming is
 * a separate operation, blocked at the schema layer).
 */
interface UpdateInput {
  name: string;
  manifest?: Partial<
    Omit<
      CreateInput["manifest"],
      | "name"
      | "schedule"
      | "kind"
      | "inputSchema"
      | "outputSchema"
      | "criteria"
      | "confidenceThreshold"
      | "judge"
      | "onPoorResult"
    >
  > & {
    /** `null` clears it: nothing fires the task unattended. */
    schedule?: ScheduleSpec | null;
    /** `null` clears it: runs take any input. */
    inputSchema?: Record<string, unknown> | null;
    /** `null` clears it: the deliverable is not checked. */
    outputSchema?: Record<string, unknown> | null;
    /** `null` clears them: runs are not judged. */
    criteria?: Criterion[] | null;
    /** `null` clears it: the default threshold applies. */
    confidenceThreshold?: number | null;
    /** `null` clears it: the one connected judge server is used. */
    judge?: TaskJudge | null;
    /** `null` clears it: the default policy applies. */
    onPoorResult?: OnPoorResult | null;
  };
  body?: string;
}

export function handleUpdate(args: Record<string, unknown>, ctx: ToolContext): TasksUpdateOutput {
  const { name, manifest: patch, body } = args as unknown as UpdateInput;
  if (!name) throw new Error("Missing required field: name");

  if (patch) {
    validateTaskFields(patch);
  }

  const result = updateTask(
    name,
    {
      ...(patch ?? {}),
      // Tool's `body` field maps to domain's `prompt`.
      ...(body !== undefined ? { prompt: body } : {}),
    },
    ctx,
  );
  return withEffectiveLimits(result, ctx);
}

export function handleDelete(args: Record<string, unknown>, ctx: ToolContext): TasksDeleteOutput {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");
  return deleteTask(name, ctx);
}

export function handleList(args: Record<string, unknown>, ctx: ToolContext): TasksListOutput {
  const defs = ctx.definitions();
  const now = Date.now();

  let tasks = Array.from(defs.values());

  // Apply filters
  if (args.enabled !== undefined) {
    tasks = tasks.filter((a) => a.enabled === args.enabled);
  }
  if (args.source !== undefined) {
    tasks = tasks.filter((a) => a.source === args.source);
  }
  // Saved by default: a one-off is kept with its history, not listed with the
  // tasks someone keeps.
  const kind = (args.kind as TaskKind | "all" | undefined) ?? "saved";
  if (kind !== "all") {
    tasks = tasks.filter((a) => kindOf(a) === kind);
  }

  // Page AFTER filtering so `total` describes the filter's real match count,
  // which is what a caller deciding whether it has seen everything needs.
  const total = tasks.length;

  // Definitions come off readdirSync with no ordering anywhere on the path, so
  // without this the sequence a page slices is undefined — two calls could
  // interleave differently and a record could appear on both pages or neither.
  // Sort by id: unique by construction, so the order is total rather than
  // merely deterministic, which is what makes the cursor below unambiguous.
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Cursor, not offset: the caller may delete a task between pages, and
  // a numeric offset would re-slice the shortened list and skip whatever moved
  // across the boundary — the same "concluded it wasn't there" failure this
  // tool's paging exists to prevent. Anchoring to the last id read is the
  // pattern conversation listing already uses. An unknown cursor (its record
  // was deleted) leaves the slice untouched and re-serves the first page,
  // which repeats work rather than skipping any.
  const cursor = args.cursor as string | undefined;
  if (cursor) {
    const idx = tasks.findIndex((a) => a.id === cursor);
    if (idx >= 0) tasks = tasks.slice(idx + 1);
  }

  const limit = Math.min(
    Math.max(1, Math.floor((args.limit as number) ?? TASKS_LIST_DEFAULT_LIMIT)),
    TASKS_LIST_MAX_LIMIT,
  );
  // Remaining after this page, computed from what is actually left rather than
  // from `total` minus a running count — the caller's history is not knowable
  // here, and guessing at it is how the withheld figure goes wrong.
  const remaining = Math.max(0, tasks.length - limit);
  tasks = tasks.slice(0, limit);

  const summaries: TaskSummary[] = tasks.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    schedule: formatSchedule(a.schedule, a),
    scheduleType: a.schedule?.type ?? "none",
    kind: kindOf(a),
    ...(a.onceDone ? { onceDone: a.onceDone } : {}),
    enabled: a.enabled,
    source: a.source,
    runCount: a.runCount,
    lastRunStatus: a.lastRunStatus ?? null,
    lastRunAt: a.lastRunAt ? formatRelativeTime(a.lastRunAt, now) : null,
    nextRunAt: a.nextRunAt ? formatRelativeTime(a.nextRunAt, now) : null,
    disabledAt: a.disabledAt ?? null,
    disabledReason: a.disabledReason ?? null,
    estimatedCostPerDay: estimateCost(a, ctx.defaultModel).perDayUsd,
    ...(a.inputSchema ? { inputSchema: a.inputSchema } : {}),
  }));

  const hasMore = remaining > 0;
  const nextCursor = hasMore ? (summaries[summaries.length - 1]?.id ?? null) : null;
  return {
    tasks: summaries,
    total,
    returned: summaries.length,
    nextCursor,
    hasMore,
    ...(hasMore && nextCursor
      ? {
          truncated:
            `Showing ${summaries.length} of ${total} matching tasks. ` +
            `${remaining} more remain after this page — this is a partial view. ` +
            `Re-call with cursor="${nextCursor}" to continue before concluding anything ` +
            `about the full set.`,
        }
      : {}),
  };
}

export function handleStatus(args: Record<string, unknown>, ctx: ToolContext): TasksStatusOutput {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  const defs = ctx.definitions();
  const task = findByName(defs, name);
  if (!task) {
    throw new Error(`Task not found: "${name}"`);
  }

  const limit = (args.limit as number) ?? 5;
  const now = Date.now();

  const runs = ctx.readRuns(task.id, { limit });

  const cost = estimateCost(task, ctx.defaultModel);

  const rates = getModelRates(task.model ?? ctx.defaultModel);
  const actualCostUsd =
    task.cumulativeInputTokens > 0
      ? (task.cumulativeInputTokens * rates.input + task.cumulativeOutputTokens * rates.output) /
        1_000_000
      : 0;

  return {
    task: {
      ...task,
      scheduleHuman: formatSchedule(task.schedule, task),
      lastRunAtHuman: task.lastRunAt ? formatRelativeTime(task.lastRunAt, now) : null,
      nextRunAtHuman: task.nextRunAt ? formatRelativeTime(task.nextRunAt, now) : null,
      cumulativeInputTokens: task.cumulativeInputTokens,
      cumulativeOutputTokens: task.cumulativeOutputTokens,
      tokenBudget: task.tokenBudget ?? null,
      budgetResetAt: task.budgetResetAt ?? null,
      actualCostUsd,
      estimatedCostPerRun: cost.perRunUsd,
      estimatedCostPerDay: cost.perDayUsd,
      estimatedCostPerMonth: cost.perMonthUsd,
    },
    recentRuns: runs.map(toRunView),
  };
}

export function handleRuns(args: Record<string, unknown>, ctx: ToolContext): TasksRunsOutput {
  const taskId = args.taskId as string | undefined;
  const status = args.status as TaskRun["status"] | undefined;
  const since = args.since as string | undefined;
  const before = args.before as string | undefined;
  const limit = (args.limit as number) ?? 20;
  const excludeBatch = args.excludeBatchRuns === true ? { excludeBatch: true } : {};
  if (before !== undefined && Number.isNaN(new Date(before).getTime())) {
    throw new Error(`Invalid before timestamp: "${before}"`);
  }

  // One task's history pages back through its archive with a cursor.
  // The first page (no `before`) reads only the hot index; its `nextBefore`
  // says older runs exist.
  if (taskId) {
    const page = ctx.readRunsPage(taskId, { limit, status, since, before, ...excludeBatch });
    return {
      runs: page.runs.map(toRunView),
      total: page.runs.length,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    };
  }

  // Every task's runs: one more than the page, to know whether more remain,
  // cut without splitting runs that share a start time (as `readRunsPage`).
  const read = ctx.readAllRuns({ limit: limit + 1, status, since, before, ...excludeBatch });
  if (read.length <= limit) return { runs: read.map(toRunView), total: read.length };
  const startedMs = (r: TaskRun) => new Date(r.startedAt).getTime();
  let cut = limit;
  while (cut > 0 && cut < read.length && startedMs(read[cut]!) === startedMs(read[cut - 1]!)) {
    cut++;
  }
  const runs = read.slice(0, cut);
  const last = runs[runs.length - 1];
  return {
    runs: runs.map(toRunView),
    total: runs.length,
    ...(last ? { nextBefore: last.startedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Views: what runs next, run statistics, judges
// ---------------------------------------------------------------------------

const DEFAULT_UPCOMING_DAYS = 7;
/** More fires than this in the window and a schedule is one `frequent` row, not one row per fire. */
const FREQUENT_THRESHOLD = 24;
/** Most cron fires counted in a window; past it the count is reported as capped. */
const FIRE_COUNT_CAP = 50_000;
const HOUR_MS = 3_600_000;
const STATS_DEFAULT_DAYS = 30;
/** A `before` later than any run, so a page read walks the archive months. */
const FAR_FUTURE = "9999-12-31T00:00:00.000Z";
/** Runs read per archive page while counting a task's stats. */
const STATS_PAGE = 5_000;

/**
 * `tasks__upcoming`: the caller's runs holding or waiting for a slot (from the
 * scheduler's own admission keys), the coming fires of timed schedules, and
 * the tasks events fire.
 */
export function handleUpcoming(
  args: Record<string, unknown>,
  ctx: ToolContext,
): TasksUpcomingOutput {
  const days = (args.days as number | undefined) ?? DEFAULT_UPCOMING_DAYS;
  const now = Date.now();
  const windowEnd = now + days * 24 * HOUR_MS;
  const defs = ctx.definitions();
  const runs = (ctx.queueView?.() ?? []).map((entry) => upcomingRunOf(entry, defs, ctx));
  const queued = runs.filter((r) => r.state === "queued");
  queued.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const saved = [...defs.values()].filter((t) => kindOf(t) === "saved" && t.schedule);
  const scheduled: TaskUpcomingFire[] = [];
  const frequent: TaskUpcomingFrequent[] = [];
  for (const task of saved) {
    if (!task.enabled || isEventSchedule(task.schedule)) continue;
    addWindowFires(task, windowEnd, ctx.defaultTimezone, scheduled, frequent);
  }
  scheduled.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  frequent.sort((a, b) => new Date(a.first).getTime() - new Date(b.first).getTime());
  const events = saved
    .filter((t) => isEventSchedule(t.schedule))
    .map((task) => eventTaskOf(task, ctx));
  events.sort((a, b) => a.taskName.localeCompare(b.taskName));

  return {
    running: runs.filter((r) => r.state === "running"),
    queued,
    days,
    windowEnd: new Date(windowEnd).toISOString(),
    scheduled,
    frequent,
    events,
  };
}

/**
 * Add a timed task's fires within the window: each one, or one `frequent`
 * row once it fires more than `FREQUENT_THRESHOLD` times, or its next fire
 * marked `beyondWindow` when none falls inside.
 */
function addWindowFires(
  task: Task,
  windowEnd: number,
  defaultTimezone: string,
  scheduled: TaskUpcomingFire[],
  frequent: TaskUpcomingFrequent[],
): void {
  const fires = windowFires(task, windowEnd, defaultTimezone);
  if (!fires) return;
  const base = {
    taskId: task.id,
    taskName: task.name,
    schedule: formatSchedule(task.schedule, task),
  };
  const type = task.schedule?.type as TaskUpcomingFire["scheduleType"];
  if (fires.count === 0) {
    scheduled.push({ ...base, scheduleType: type, at: fires.first, beyondWindow: true });
  } else if (fires.count > FREQUENT_THRESHOLD && type !== "once") {
    frequent.push({
      ...base,
      scheduleType: type,
      count: fires.count,
      ...(fires.capped ? { countCapped: true } : {}),
      first: fires.first,
      last: fires.last,
    });
  } else {
    for (const at of fires.listed) scheduled.push({ ...base, scheduleType: type, at });
  }
}

/** A timed task's fires within a window, counted; `count` 0 means its next fire is past it. */
interface WindowFires {
  first: string;
  last: string;
  count: number;
  capped: boolean;
  /** The fires, while there are at most `FREQUENT_THRESHOLD` of them. */
  listed: string[];
}

/**
 * Count a timed task's fires from its stored `nextRunAt` (it carries any
 * backoff) to `windowEnd`. Null when it has no next fire (no `nextRunAt`, or a
 * retired once). An interval is counted arithmetically; a cron is stepped up
 * to `FIRE_COUNT_CAP`.
 */
function windowFires(task: Task, windowEnd: number, defaultTimezone: string): WindowFires | null {
  const schedule = task.schedule;
  const first = new Date(task.nextRunAt ?? Number.NaN);
  if (!schedule || Number.isNaN(first.getTime())) return null;
  if (schedule.type === "once" && onceRetirement(task)) return null;
  const firstIso = first.toISOString();
  if (first.getTime() > windowEnd) {
    return { first: firstIso, last: firstIso, count: 0, capped: false, listed: [] };
  }
  if (schedule.type === "interval" && schedule.intervalMs) {
    const step = schedule.intervalMs;
    const count = Math.floor((windowEnd - first.getTime()) / step) + 1;
    const listed =
      count <= FREQUENT_THRESHOLD
        ? Array.from({ length: count }, (_, k) =>
            new Date(first.getTime() + k * step).toISOString(),
          )
        : [];
    const last = new Date(first.getTime() + (count - 1) * step).toISOString();
    return { first: firstIso, last, count, capped: false, listed };
  }
  if (schedule.type === "cron" && schedule.expression) {
    return cronWindowFires(
      schedule.expression,
      schedule.timezone ?? defaultTimezone,
      first,
      windowEnd,
    );
  }
  return { first: firstIso, last: firstIso, count: 1, capped: false, listed: [firstIso] };
}

/** A cron's fires from `first` to `windowEnd`, stepped and counted up to the cap. */
function cronWindowFires(
  expression: string,
  timezone: string,
  first: Date,
  windowEnd: number,
): WindowFires {
  const firstIso = first.toISOString();
  const listed = [firstIso];
  let count = 1;
  let last = first;
  let cron: Cron;
  try {
    cron = new Cron(expression, { timezone });
  } catch {
    // A cron that does not parse has no further fires to count.
    return { first: firstIso, last: firstIso, count, capped: false, listed };
  }
  let next = cron.nextRun(first);
  while (next && next.getTime() <= windowEnd && count < FIRE_COUNT_CAP) {
    count++;
    last = next;
    if (listed.length < FREQUENT_THRESHOLD) listed.push(next.toISOString());
    next = cron.nextRun(next);
  }
  const capped = count >= FIRE_COUNT_CAP && !!next && next.getTime() <= windowEnd;
  return {
    first: firstIso,
    last: last.toISOString(),
    count,
    capped,
    listed: count <= FREQUENT_THRESHOLD ? listed : [],
  };
}

/** One queue entry, with its task's name and what its ticket says. */
function upcomingRunOf(
  entry: QueueViewEntry,
  defs: Map<string, Task>,
  ctx: ToolContext,
): TaskUpcomingRun {
  const ticket = entry.runId ? ctx.readRunTicket?.(entry.runId) : null;
  const taskName = defs.get(entry.taskId)?.name;
  const trigger = entry.trigger ?? ticket?.run.trigger;
  const queuedAt = entry.state === "queued" ? ticket?.requestedAt : undefined;
  return {
    taskId: entry.taskId,
    ...(taskName ? { taskName } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    state: entry.state,
    ...(entry.position !== undefined ? { position: entry.position } : {}),
    ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(queuedAt ? { queuedAt } : {}),
    ...(trigger ? { trigger } : {}),
    ...(ticket?.run.batchId ? { batchId: ticket.run.batchId } : {}),
    ...(ticket?.run.batchIndex !== undefined ? { batchIndex: ticket.run.batchIndex } : {}),
  };
}

/** An event-fired task, its fire ceiling, and the fires of the last hour. */
function eventTaskOf(task: Task, ctx: ToolContext): TaskUpcomingEventTask {
  const since = new Date(Date.now() - HOUR_MS).toISOString();
  return {
    taskId: task.id,
    taskName: task.name,
    schedule: formatSchedule(task.schedule, task),
    enabled: task.enabled,
    maxFiresPerHour: task.schedule?.maxFiresPerHour ?? DEFAULT_EVENT_MAX_FIRES_PER_HOUR,
    firesLastHour: ctx.readRuns(task.id, { since }).filter(countsAsEventFire).length,
  };
}

/**
 * `tasks__stats`: per task, the runs started since a time, their verdicts,
 * pass rate and cost, read back through the archive months, and the newest
 * run's label.
 */
export function handleStats(args: Record<string, unknown>, ctx: ToolContext): TasksStatsOutput {
  const sinceArg = args.since as string | undefined;
  const taskId = args.taskId as string | undefined;
  const since = sinceArg ?? new Date(Date.now() - STATS_DEFAULT_DAYS * 24 * HOUR_MS).toISOString();
  if (Number.isNaN(new Date(since).getTime())) {
    throw new Error(`Invalid since timestamp: "${since}"`);
  }
  const defs = ctx.definitions();
  let tasks: Task[];
  if (taskId !== undefined) {
    const task = defs.get(taskId);
    if (!task) throw new Error(`Task not found: "${taskId}"`);
    tasks = [task];
  } else {
    tasks = [...defs.values()].filter((t) => kindOf(t) === "saved");
  }
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { since, tasks: tasks.map((t) => statsOf(t.id, since, ctx)) };
}

/** One task's figures since `since`. */
function statsOf(taskId: string, since: string, ctx: ToolContext): TaskRunStats {
  const stats: TaskRunStats = {
    taskId,
    runs: 0,
    pass: 0,
    fail: 0,
    uncertain: 0,
    passRate: null,
    costUsd: 0,
  };
  let before: string | undefined = FAR_FUTURE;
  while (before) {
    const page = ctx.readRunsPage(taskId, { since, before, limit: STATS_PAGE });
    for (const run of page.runs) countRun(stats, run);
    before = page.nextBefore;
  }
  const decided = stats.pass + stats.fail;
  stats.passRate = decided > 0 ? stats.pass / decided : null;
  const last = ctx.readRuns(taskId, { limit: 1 })[0];
  if (last) stats.lastRun = { id: last.id, startedAt: last.startedAt, label: labelOf(last) };
  return stats;
}

/** Add one run to a task's figures. */
function countRun(stats: TaskRunStats, run: TaskRun): void {
  stats.runs++;
  stats.costUsd += run.costUsd ?? 0;
  const verdict = effectiveVerdict(run.assessment);
  if (verdict === "pass") stats.pass++;
  else if (verdict === "fail") stats.fail++;
  else if (verdict === "uncertain") stats.uncertain++;
}

/** `tasks__judges`: the judge servers connected in this workspace, and why a task naming none would not be judged. */
export async function handleJudges(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<TasksJudgesOutput> {
  const sources = ctx.judgeSources ? await ctx.judgeSources() : [];
  return judgeServersOf(sources);
}

/**
 * Fetch a single run's full result (the deliverable) — the untruncated output,
 * the activity log of every tool call, and refs to any files the run wrote.
 * The run-list summary (`handleRuns`/`handleStatus`) carries only a truncated
 * preview; this is how a caller pulls the whole thing.
 */
export function handleRunResult(
  args: Record<string, unknown>,
  ctx: ToolContext,
): TasksRunResultOutput {
  const name = args.name as string | undefined;
  const runId = args.runId as string;
  if (!runId) throw new Error("Missing required field: runId");

  // A run `tasks__run` started is found by its id alone, through its
  // ticket, which also says when it has not ended yet.
  if (!name) {
    const ticket = ctx.readRunTicket?.(runId);
    if (!ticket) {
      throw new Error(
        `Run not found: "${runId}". Pass the task's name too for a run not started by tasks__run.`,
      );
    }
    if (isOpenRun(ticket.run)) {
      throw new Error(
        `Run "${runId}" is still ${ticket.run.status}; its result is written when it ends.`,
      );
    }
    const result = ctx.readRunResult(ticket.taskId, runId);
    if (!result) {
      throw new Error(
        `Run "${runId}" ended without a result (${ticket.run.status}${ticket.run.error ? `: ${ticket.run.error}` : ""}).`,
      );
    }
    return withRunOutcome(result, ticket.run);
  }

  const defs = ctx.definitions();
  const task = findByName(defs, name);
  if (!task) {
    throw new Error(`Task not found: "${name}"`);
  }

  const result = ctx.readRunResult(task.id, runId);
  if (!result) {
    throw new Error(`Run result not found: "${runId}" for task "${name}".`);
  }
  return withRunOutcome(result, ctx.findRun?.(task.id, runId) ?? null);
}

/** A run's result with the outcome its record says: execution, label, and assessment. */
function withRunOutcome(result: TaskRunResult, run: TaskRun | null): TasksRunResultOutput {
  if (!run) return result;
  return {
    ...result,
    execution: executionOf(run),
    label: labelOf(run),
    ...(run.assessment ? { assessment: run.assessment } : {}),
  };
}

/**
 * Maximum time `handleRun` will hold the MCP request awaiting completion
 * before returning a "dispatched, still running" envelope. Sized well
 * below the SDK's 60s default request timeout — without this cap, any
 * task that takes longer than ~60s collides with the timeout and
 * the agent sees `-32001 Request timed out` while the run is healthy
 * and proceeding in the background. The scheduler continues to track
 * the run; callers can poll `tasks__runs` for the final record.
 */
const HANDLE_RUN_SYNC_WAIT_MS = 30_000;

/** The most a run's JSON `input` may take, serialized. It is kept on the run record. */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

/** The longest idempotency key `tasks__run` and `tasks__run_batch` take. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * An inline one-off's definition: `tasks__run` with these instead of
 * `taskId` creates a `oneoff` task with no schedule and runs it once.
 */
export interface InlineDefinition {
  prompt?: string;
  skill?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  limits?: { maxIterations?: number; maxInputTokens?: number; maxRunDurationMs?: number };
  budget?: TokenBudget;
  criteria?: Criterion[];
  confidenceThreshold?: number;
  judge?: TaskJudge;
  onPoorResult?: OnPoorResult;
}

/** The fields of `tasks__run` that make it an inline one-off. */
export const INLINE_FIELDS = [
  "prompt",
  "skill",
  "inputSchema",
  "outputSchema",
  "allowedTools",
  "limits",
  "budget",
  "criteria",
  "confidenceThreshold",
  "judge",
  "onPoorResult",
] as const;

/** `tasks__run`'s arguments, already shape-checked by the tool's input schema. */
interface RunArgs extends InlineDefinition {
  taskId?: string;
  input?: unknown;
  idempotencyKey?: string;
}

/** What `tasks__run` became: a run it asked for, or one an idempotency key already started. */
export type PreparedRun =
  | { kind: "existing"; task: Task; ticket: RunTicket }
  | {
      kind: "requested";
      task: Task;
      requested: RequestedRun;
      ticket: RunNowTicket;
    };

/** A fresh run id, in the runtime's shape (`run_<12 chars>`). */
function newRunId(): string {
  return `run_${randomBytes(6).toString("hex")}`;
}

/**
 * The id of the one-off an inline `tasks__run` creates. With an
 * idempotency key it is derived from the key, so a repeat finds the same
 * one-off (and through the key, the same run) under the caller's own
 * partition; without one it is fresh.
 */
function oneoffId(idSeed: string | undefined): string {
  const token =
    idSeed !== undefined
      ? createHash("sha256").update(idSeed, "utf-8").digest("hex").slice(0, 20)
      : randomBytes(8).toString("hex");
  return `oneoff-${token}`;
}

/** The fields of a one-off that make up its definition, for comparing two of them. */
const ONEOFF_DEFINITION_FIELDS = [
  "prompt",
  "skill",
  "inputSchema",
  "outputSchema",
  "allowedTools",
  "maxIterations",
  "maxInputTokens",
  "maxRunDurationMs",
  "tokenBudget",
  "criteria",
  "confidenceThreshold",
  "judge",
  "onPoorResult",
] as const;

/** JSON with object keys sorted and undefined dropped, so equal definitions compare equal. */
function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const field = (v as Record<string, unknown>)[k];
      if (field !== undefined) out[k] = normalize(field);
    }
    return out;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

function oneoffDefinition(
  source: Partial<Pick<Task, (typeof ONEOFF_DEFINITION_FIELDS)[number]>>,
): string {
  return canonicalJson(Object.fromEntries(ONEOFF_DEFINITION_FIELDS.map((f) => [f, source[f]])));
}

/** The assessment fields an inline definition sets, and only those. */
function assessmentDefinition(
  args: InlineDefinition,
): Pick<InlineDefinition, "criteria" | "confidenceThreshold" | "judge" | "onPoorResult"> {
  return {
    ...(args.criteria ? { criteria: args.criteria } : {}),
    ...(args.confidenceThreshold !== undefined
      ? { confidenceThreshold: args.confidenceThreshold }
      : {}),
    ...(args.judge ? { judge: args.judge } : {}),
    ...(args.onPoorResult ? { onPoorResult: args.onPoorResult } : {}),
  };
}

/**
 * Find or create the `oneoff` task an inline `tasks__run` (or
 * `tasks__run_batch`) names. The definition and the input(s) are checked
 * (`checkInput`, given the one-off's id and input schema) before anything is
 * written, so a refused call leaves no one-off behind. With `idSeed` (the
 * call's idempotency key, namespaced by tool) the one-off's id is derived
 * from it, and a seed that already names a one-off with a different definition
 * is refused rather than run against the old one.
 */
export function ensureOneoff(
  args: InlineDefinition,
  ctx: ToolContext,
  checkInput: (id: string, inputSchema: Record<string, unknown> | undefined) => void,
  idSeed: string | undefined,
  missing = "tasks__run needs `taskId` (a task to run)",
): Task {
  if (!args.prompt && !args.skill) {
    throw new Error(`${missing} or an inline definition with \`prompt\` or \`skill\`.`);
  }
  const limits = args.limits ?? {};
  validateTaskFields({
    ...limits,
    ...(args.allowedTools ? { allowedTools: args.allowedTools } : {}),
    ...(args.inputSchema ? { inputSchema: args.inputSchema } : {}),
    ...(args.outputSchema ? { outputSchema: args.outputSchema } : {}),
    ...assessmentDefinition(args),
  });
  const id = oneoffId(idSeed);
  const prompt =
    args.prompt ??
    `Carry out the "${args.skill}" skill on this run's input, and give its result as the deliverable.`;
  const definition = {
    prompt,
    ...(args.skill ? { skill: args.skill } : {}),
    ...(args.inputSchema ? { inputSchema: args.inputSchema } : {}),
    ...(args.outputSchema ? { outputSchema: args.outputSchema } : {}),
    ...(args.allowedTools ? { allowedTools: args.allowedTools } : {}),
    ...limits,
    ...(args.budget ? { tokenBudget: args.budget } : {}),
    ...assessmentDefinition(args),
  };

  checkInput(id, args.inputSchema);

  const existing = ctx.definitions().get(id);
  if (existing) {
    if (oneoffDefinition(existing) !== oneoffDefinition(definition)) {
      throw new Error(
        "idempotencyKey reused with a different definition: this key already started a one-off " +
          "with another prompt, skill, schema, tools, limits, or budget. Use a new key for a new " +
          "definition, or repeat the original definition to get its run.",
      );
    }
    return existing;
  }

  const { task } = createTask(
    {
      name: id,
      kind: "oneoff",
      ...definition,
      source: "agent",
      ownerId: ctx.currentUserId,
      workspaceId: ctx.currentWorkspaceId,
    },
    ctx,
  );
  return task;
}

/**
 * Why a run input is refused for the task `name` (too large, or not matching
 * its `inputSchema`), or null when it is taken.
 */
export function runInputProblem(
  name: string,
  inputSchema: Record<string, unknown> | undefined,
  input: unknown,
): string | null {
  if (input === undefined) {
    if (inputSchema && !checkAgainstSchema(inputSchema, null).valid) {
      return `"${name}" takes an input matching its inputSchema; none was given.`;
    }
    return null;
  }
  const size = Buffer.byteLength(JSON.stringify(input) ?? "", "utf-8");
  if (size > MAX_RUN_INPUT_BYTES) {
    return (
      `input is ${size} bytes serialized; a run's input may be at most ${MAX_RUN_INPUT_BYTES}. ` +
      "Pass a reference (a file id or URL) instead of the content."
    );
  }
  if (!inputSchema) return null;
  const verdict = checkAgainstSchema(inputSchema, input);
  return verdict.valid
    ? null
    : `input does not match the inputSchema of "${name}": ${verdict.errors.join("; ")}`;
}

/** Refuse a run input that is too large or does not match the `inputSchema` of the task `name`. */
function checkRunInput(
  name: string,
  inputSchema: Record<string, unknown> | undefined,
  input: unknown,
): void {
  const problem = runInputProblem(name, inputSchema, input);
  if (problem) throw new Error(problem);
}

/**
 * Resolve what `tasks__run` runs and ask for the run: a saved
 * task by `taskId`, or an inline definition run as a one-off. The input
 * is checked first, and an idempotency key already used on the task
 * returns that run instead of asking for another. Shared by the inline call
 * and the task-augmented one, so the two cannot disagree on what a call
 * starts.
 */
export function prepareRun(rawArgs: Record<string, unknown>, ctx: ToolContext): PreparedRun {
  const args = rawArgs as RunArgs;
  const inline = INLINE_FIELDS.filter((field) => args[field] !== undefined);
  if (args.taskId && inline.length > 0) {
    throw new Error(
      `Give either \`taskId\` (a task to run) or an inline definition, not both ` +
        `(also given: ${inline.join(", ")}).`,
    );
  }
  const key = args.idempotencyKey;
  if (key !== undefined && (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
    throw new Error(`idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }

  // Ensure scheduler has fresh definitions (e.g., task just created)
  ctx.reloadScheduler();

  let task: Task;
  if (args.taskId) {
    const found = findByName(ctx.definitions(), args.taskId);
    if (!found) throw new Error(`Task not found: "${args.taskId}"`);
    task = found;
    checkRunInput(task.name, task.inputSchema, args.input);
  } else {
    // Checks the input against the inline definition before creating anything.
    task = ensureOneoff(
      args,
      ctx,
      (id, schema) => checkRunInput(id, schema, args.input),
      args.idempotencyKey,
    );
  }

  if (key !== undefined) {
    const existing = ctx.findRunByKey?.(task.id, key);
    if (existing) return { kind: "existing", task, ticket: existing };
  }

  const requested: RequestedRun = {
    runId: newRunId(),
    requestedAt: new Date().toISOString(),
    ...(args.input !== undefined ? { input: args.input } : {}),
    ...(key !== undefined ? { idempotencyKey: key } : {}),
  };
  log(`handleRun: running "${task.id}" as ${requested.runId}`);
  const ticket = ctx.runNow(task.id, requested);
  if (!ticket) {
    const ids = Array.from(ctx.definitions().keys());
    log(
      `handleRun: runNow returned null for "${task.id}". Scheduler has ${ids.length} definitions: [${ids.join(", ")}]`,
    );
    throw new Error(
      `Failed to trigger run for "${task.name}" (id=${task.id}). The scheduler could not find this task. Try reloading.`,
    );
  }
  return { kind: "requested", task, requested, ticket };
}

/** The answer for a run an earlier call with the same idempotency key started. */
function existingRunAnswer(task: Task, ticket: RunTicket, ctx: ToolContext): TasksRunOutput {
  const { enabled } = disabledState(ctx, task.name, task);
  const same = "An earlier call with this idempotencyKey already started this run";
  const { run } = ticket;
  if (!isOpenRun(run)) {
    return { run: toRunView(run), enabled, message: `${same}; this is its record.` };
  }
  const where =
    `Its record appears in tasks__runs (taskId "${task.id}") when it ends; ` +
    `read it with tasks__run_result (runId "${ticket.runId}").`;
  if (run.status === "queued") {
    return {
      status: "queued",
      taskId: task.id,
      runId: ticket.runId,
      position: ctx.queuePosition?.(task.id) ?? 1,
      queuedAt: ticket.requestedAt,
      enabled,
      message: `${same}, and it is still queued. ${where}`,
    };
  }
  return {
    status: "dispatched",
    taskId: task.id,
    runId: ticket.runId,
    startedAt: run.startedAt,
    enabled,
    message: `${same}, and it is still running. ${where}`,
  };
}

export async function handleRun(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<TasksRunOutput> {
  const prepared = prepareRun(args, ctx);
  const { task } = prepared;
  const name = task.name;
  if (prepared.kind === "existing") return existingRunAnswer(task, prepared.ticket, ctx);
  const { ticket, requested } = prepared;
  const runId = requested.runId;

  if (ticket.state === "refused") {
    const { enabled } = disabledState(ctx, name, task);
    return {
      run: toRunView(ticket.run),
      enabled,
      message: `"${name}" did not run: ${ticket.run.error ?? "the scheduler refused it"}`,
    };
  }

  if (ticket.state === "queued") {
    // The queued run is the scheduler's to finish; nothing awaits it here.
    ticket.run.catch(() => {});
    const queuedAt = requested.requestedAt;
    const { enabled, disabledNote } = disabledState(ctx, name, task);
    return {
      status: "queued",
      taskId: task.id,
      runId,
      position: ticket.position,
      queuedAt,
      enabled,
      message:
        `"${name}" is queued at position ${ticket.position}: every task run slot is busy, ` +
        `and it starts as soon as one frees. When it ends, read it with tasks__run_result ` +
        `(runId "${runId}"); it also appears in tasks__runs (taskId ` +
        `"${task.id}", since "${queuedAt}"). Remove it from the queue with ` +
        `tasks__cancel.${disabledNote}`,
    };
  }

  // Race the run against a sync-wait deadline. Quick tasks finish
  // inside the window and return their full run record; longer ones get
  // a "dispatched" envelope so the agent can poll instead of seeing a
  // false -32001 failure.
  //
  // `Scheduler.dispatchRun` synthesizes a failure record for any
  // executor throw and returns it — so the EXECUTOR side never rejects.
  // BUT `updateAfterRun` (called from `dispatchRun` after the executor
  // settles) does filesystem I/O — `appendRun` + `saveTask` — and
  // can reject on disk-full, EBUSY, or permission flaps. In the
  // synchronous-completion path the rejection surfaces through
  // Promise.race and our outer catch handles it; in the dispatched path
  // the run keeps going in the background and an `updateAfterRun` throw
  // would become an unhandled rejection. The `.catch(noop)` swallows
  // exactly that case — the scheduler's own logging is the right place
  // for filesystem diagnostics, not the MCP request frame.
  const startedAt = new Date().toISOString();
  const runPromise = ticket.run;
  runPromise.catch(() => {});

  const waitMs = ctx.handleRunSyncWaitMs ?? HANDLE_RUN_SYNC_WAIT_MS;
  const PENDING = Symbol("pending");
  // Track the timer so we can clear it when the run wins the race —
  // otherwise the pending timeout pins the event loop for up to waitMs
  // past handleRun returning. Quick tasks + bursty traffic would
  // accumulate live timers under load and delay clean process shutdown.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), waitMs);
  });
  let outcome: TaskRun | typeof PENDING;
  try {
    outcome = await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // Read after the run settles: the run itself can disable it (failure
  // auto-disable, token budget).
  const { enabled, disabledNote } = disabledState(ctx, name, task);

  if (outcome === PENDING) {
    return {
      status: "dispatched",
      taskId: task.id,
      runId,
      startedAt,
      enabled,
      message:
        `"${name}" is still running after ${waitMs / 1000}s and continues in the background; ` +
        `it has not failed. When it ends, read its full output with tasks__run_result ` +
        `(runId "${runId}"); it also appears in tasks__runs (taskId ` +
        `"${task.id}", since "${startedAt}"). Stop it with tasks__cancel.${disabledNote}`,
    };
  }

  return disabledNote
    ? { run: toRunView(outcome), enabled, message: disabledNote.trim() }
    : { run: toRunView(outcome), enabled };
}

/**
 * The task's current `enabled` flag, and a note for a disabled one. Run
 * now runs a disabled task (see `Scheduler.requestRunNow`); the note says
 * so, since its schedule and events will not fire it again.
 */
function disabledState(
  ctx: ToolContext,
  name: string,
  task: Task,
): { enabled: boolean; disabledNote: string } {
  const current = findByName(ctx.definitions(), name) ?? task;
  const enabled = current.enabled;
  // `enabled` gates only the trigger; with none there is nothing to say.
  const disabledNote =
    enabled || !current.schedule
      ? ""
      : ` "${name}" is disabled, so its schedule and events will not fire it; enable it to run unattended.`;
  return { enabled, disabledNote };
}

export function handleCancel(args: Record<string, unknown>, ctx: ToolContext): TasksCancelOutput {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  // Ensure scheduler has fresh definitions
  ctx.reloadScheduler();

  const defs = ctx.definitions();
  const task = findByName(defs, name);
  if (!task) {
    throw new Error(`Task not found: "${name}"`);
  }

  const cancelled = ctx.cancelRun(task.id);
  return {
    cancelled,
    id: task.id,
    message: cancelled
      ? `Task "${name}" run cancelled.`
      : `Task "${name}" has no running or queued run to cancel.`,
  };
}

/** `tasks__assess`'s arguments, already shape-checked by its input schema. */
interface AssessInput {
  runId: string;
  name?: string;
  verdict?: "pass" | "fail";
  note?: string;
  reassess?: boolean;
}

/**
 * One of the caller's runs by id, with its task: through the task named, the
 * run's ticket, or the hot run index of each of the caller's tasks.
 */
function findOwnRun(
  ctx: ToolContext,
  runId: string,
  name: string | undefined,
): { task: Task; run: TaskRun } {
  const defs = ctx.definitions();
  if (name) {
    const task = findByName(defs, name);
    if (!task) throw new Error(`Task not found: "${name}"`);
    const run = ctx.findRun?.(task.id, runId) ?? null;
    if (!run) throw new Error(`Run not found: "${runId}" for task "${name}".`);
    return { task, run };
  }
  const ticket = ctx.readRunTicket?.(runId);
  const ticketTask = ticket ? defs.get(ticket.taskId) : undefined;
  if (ticket && ticketTask) {
    return { task: ticketTask, run: ctx.findRun?.(ticketTask.id, runId) ?? ticket.run };
  }
  for (const task of defs.values()) {
    const run = ctx.readRuns(task.id).find((r) => r.id === runId);
    if (run) return { task, run };
  }
  throw new Error(`Run not found: "${runId}". Pass the task's name too for an older run.`);
}

/**
 * Set a person's verdict on a run, or judge it again. A person's verdict is
 * recorded beside the judge's (`assessment.human`) and replaces it in how the
 * run reads; a re-assessment replaces the judge's part and keeps a person's.
 * Only a run that left a deliverable has an assessment to set.
 */
export async function handleAssess(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<TasksAssessOutput> {
  const { runId, name, verdict, note, reassess } = args as unknown as AssessInput;
  if ((verdict === undefined) === (reassess !== true)) {
    throw new Error("Give `verdict` (pass or fail) or `reassess: true`: one of the two.");
  }
  if (note !== undefined && verdict === undefined) {
    throw new Error("`note` goes with a `verdict`.");
  }
  const { task, run } = findOwnRun(ctx, runId, name);
  if (!isAssessable(run)) {
    throw new Error(
      `Run "${runId}" left no deliverable to assess (it ${executionOf(run)}); only a run that ` +
        "completed, or stopped at a limit with a partial deliverable, has an assessment.",
    );
  }

  if (reassess) {
    if (!ctx.reassessRun) throw new Error("Re-assessment is not available in this runtime.");
    const updated = await ctx.reassessRun(task, run);
    if (!updated?.assessment) throw new Error(`Run "${runId}" could not be re-assessed.`);
    const { verdict: judged, reason } = updated.assessment;
    return {
      run: toRunView(updated),
      message: `Run "${runId}" re-assessed: ${judged}${reason ? ` (${reason.message})` : ""}.`,
    };
  }

  return setHumanVerdict(ctx, task, runId, verdict as "pass" | "fail", note);
}

/** Record a person's verdict on a run beside the judge's. */
function setHumanVerdict(
  ctx: ToolContext,
  task: Task,
  runId: string,
  verdict: "pass" | "fail",
  note: string | undefined,
): TasksAssessOutput {
  if (!ctx.updateRun) throw new Error("Setting a verdict is not available in this runtime.");
  const at = new Date().toISOString();
  const human = {
    verdict,
    ...(note ? { note } : {}),
    by: ctx.currentUserId ?? "unknown",
    via: ctx.callerVia?.() ?? ("remote" as const),
    at,
  };
  const updated = ctx.updateRun(task.id, runId, (r) => ({
    ...r,
    assessment: {
      ...(r.assessment ?? {
        verdict: "not_assessed" as const,
        reason: { code: "not_judged", message: "not judged before a person's verdict" },
        assessedAt: at,
      }),
      human,
    },
  }));
  if (!updated) throw new Error(`Run "${runId}" has no record to set a verdict on.`);
  return {
    run: toRunView(updated),
    message: `Your verdict on run "${runId}" is recorded: ${human.verdict}. It now reads ${labelOf(updated)}.`,
  };
}

/**
 * Attach warnings about the saved task to a write's answer: as `warnings`,
 * and appended to its `message`, which is what a reader of the text sees. The
 * answer is returned unchanged when there are none.
 */
export function withWarnings<T extends { message?: string; warnings?: TaskWarning[] }>(
  out: T,
  warnings: TaskWarning[],
): T {
  if (warnings.length === 0) return out;
  const notes = warnings.map((w) => `Warning: ${w.message}`).join(" ");
  return {
    ...out,
    message: out.message ? `${out.message} ${notes}` : notes,
    warnings: [...(out.warnings ?? []), ...warnings],
  };
}

/** The task a `tasks__run` answer is about. */
export function runOutputTaskId(out: TasksRunOutput): string {
  return "run" in out ? out.run.taskId : out.taskId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findByName(defs: Map<string, Task>, name: string): Task | undefined {
  // First try direct id lookup (kebab-case of name)
  const byId = defs.get(toKebabCase(name));
  if (byId) return byId;

  // Fall back to name match
  for (const auto of defs.values()) {
    if (auto.name === name) return auto;
  }
  return undefined;
}
