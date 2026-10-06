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
  TaskRunLabel,
  TaskRunResultBody,
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
import {
  createTask,
  type DomainUpdatePatch,
  deleteTask,
  requireTask,
  updateTask,
} from "./domain.ts";
import { containsRecursiveTool } from "./executor.ts";
import { assertJsonSchema, checkAgainstSchema } from "./json-schema.ts";
import { type JudgeSourceView, judgeServersOf } from "./judge.ts";
import {
  countsAsEventFire,
  isOpenRun,
  newRunId,
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
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = parts;
  if (month !== "*") return expr;
  const repeating = repeatingCron(minute, hour, dayOfMonth, dayOfWeek);
  if (repeating) return repeating;
  if (!isCronNumber(minute, 59) || !isCronNumber(hour, 23)) return expr;
  const at = `at ${formatTime(Number(hour), Number(minute))} ${formatTimezoneAbbr(timezone ?? DEFAULT_TIMEZONE)}`;
  if (dayOfMonth !== "*") {
    return dayOfWeek === "*" && isCronNumber(dayOfMonth, 31)
      ? `Monthly on the ${ordinal(Number(dayOfMonth))} ${at}`
      : expr;
  }
  const days = cronDaysInWords(dayOfWeek);
  return days ? `${days} ${at}` : expr;
}

/** A field holding one number from 0 to `max`. */
function isCronNumber(field: string, max: number): boolean {
  return /^\d{1,2}$/.test(field) && Number(field) <= max;
}

/** "Every 5 minutes", "Every hour", "Every 3 hours", "Every hour at :15"; null for any other shape. */
function repeatingCron(
  minute: string,
  hour: string,
  dayOfMonth: string,
  dayOfWeek: string,
): string | null {
  if (dayOfMonth !== "*" || dayOfWeek !== "*") return null;
  return hour === "*" ? everyMinutes(minute) : everyHours(minute, hour);
}

/** A repeating schedule within each hour: "Every minute", "Every 5 minutes", "Every hour at :15". */
function everyMinutes(minute: string): string | null {
  if (minute === "*") return "Every minute";
  if (/^\*\/\d+$/.test(minute)) {
    const n = Number(minute.slice(2));
    return `Every ${n} minute${n === 1 ? "" : "s"}`;
  }
  if (!isCronNumber(minute, 59)) return null;
  return Number(minute) === 0 ? "Every hour" : `Every hour at :${minute.padStart(2, "0")}`;
}

/** A schedule every few hours on the hour: "Every 3 hours". */
function everyHours(minute: string, hour: string): string | null {
  if (!/^\*\/\d+$/.test(hour) || !isCronNumber(minute, 59) || Number(minute) !== 0) return null;
  const n = Number(hour.slice(2));
  return n === 1 ? "Every hour" : `Every ${n} hours`;
}

const CRON_DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const CRON_DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** A day-of-week field's day, 0 (Sunday) to 6, from a number or a three-letter name; null otherwise. */
function cronDay(field: string): number | null {
  if (/^[0-7]$/.test(field)) return Number(field) % 7;
  const i = CRON_DAY_ABBR.indexOf(field.toUpperCase());
  return i >= 0 ? i : null;
}

/** The days a day-of-week field names, sorted, or null when it is not a plain list or range. */
function cronDaySet(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const [from, to] = part.split("-");
    const a = cronDay(from ?? "");
    const b = to === undefined ? a : cronDay(to);
    if (a === null || b === null || b < a) return null;
    for (let d = a; d <= b; d++) days.add(d);
  }
  return [...days].sort((x, y) => x - y);
}

/** "Every day", "Weekdays", "Weekends", "Mondays", "Mondays and Thursdays"; null when unreadable. */
function cronDaysInWords(field: string): string | null {
  if (field === "*") return "Every day";
  const days = cronDaySet(field);
  if (!days || days.length === 0) return null;
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (days.length === 7) return "Every day";
  const names = days.map((d) => `${CRON_DAY_NAMES[d]}s`);
  return names.length === 1
    ? (names[0] as string)
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
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
  /** Cancel a run by id: abort it in flight, or take it out of the queue. False when none. */
  cancelRun: (runId: string) => boolean;
  /** Whether a run's record has landed but its assessment has not yet been written. */
  isAssessing?: (runId: string) => boolean;
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
  maxIterations?: number | null;
  maxInputTokens?: number | null;
  maxRunDurationMs?: number | null;
  allowedTools?: string[] | null;
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
  const recursive = containsRecursiveTool(args.allowedTools ?? undefined);
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

/** The IANA timezone a task's schedule is read in: its own, else the instance's. */
function timezoneOf(task: Task, ctx: ToolContext): string {
  return task.schedule?.timezone ?? ctx.defaultTimezone;
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
  return { ...withEffectiveLimits(result, ctx), timezone: timezoneOf(result.task, ctx) };
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
 * Strict input shape for `tasks__update`. `manifest` is a patch of the
 * create-shape in which `null` clears a field; `body` is an optional new
 * prompt. `name` and `kind` are not patchable (a rename would move the id).
 */
interface UpdateInput {
  taskId: string;
  manifest?: Omit<DomainUpdatePatch, "prompt">;
  body?: string;
}

export function handleUpdate(args: Record<string, unknown>, ctx: ToolContext): TasksUpdateOutput {
  const { taskId, manifest: patch, body } = args as unknown as UpdateInput;
  if (patch) validateTaskFields(patch);
  const result = updateTask(
    taskId,
    {
      ...(patch ?? {}),
      // Tool's `body` field maps to domain's `prompt`.
      ...(body !== undefined ? { prompt: body } : {}),
    },
    ctx,
  );
  return { ...withEffectiveLimits(result, ctx), timezone: timezoneOf(result.task, ctx) };
}

export function handleDelete(args: Record<string, unknown>, ctx: ToolContext): TasksDeleteOutput {
  const { taskId } = args as unknown as { taskId: string };
  return deleteTask(taskId, ctx);
}

export function handleList(args: Record<string, unknown>, ctx: ToolContext): TasksListOutput {
  const defs = ctx.definitions();

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
    lastRunAt: a.lastRunAt ?? null,
    // A disabled task keeps its stored `nextRunAt`, but nothing fires it.
    nextRunAt: a.enabled ? (a.nextRunAt ?? null) : null,
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
  const { taskId, limit = 5 } = args as unknown as { taskId: string; limit?: number };
  const task = requireTask(ctx.definitions(), taskId);
  const runs = limit > 0 ? ctx.readRuns(task.id, { limit }) : [];
  const cost = estimateCost(task, ctx.defaultModel);
  return {
    task: {
      ...task,
      scheduleHuman: formatSchedule(task.schedule, task),
      timezone: timezoneOf(task, ctx),
      cumulativeInputTokens: task.cumulativeInputTokens,
      cumulativeOutputTokens: task.cumulativeOutputTokens,
      tokenBudget: task.tokenBudget ?? null,
      budgetResetAt: task.budgetResetAt ?? null,
      estimatedCostPerRun: cost.perRunUsd,
      estimatedCostPerDay: cost.perDayUsd,
      estimatedCostPerMonth: cost.perMonthUsd,
    },
    recentRuns: runs.map(toRunView),
  };
}

/** Runs read per page while `tasks__runs` filters by label or verdict. */
const FILTER_SCAN_PAGE = 500;
/** Most runs one filtered `tasks__runs` call reads before it answers with `nextBefore`. */
const FILTER_SCAN_CAP = 5_000;

/** `tasks__runs`' arguments, already shape-checked by its input schema. */
interface RunsInput {
  taskId?: string;
  label?: TaskRunLabel;
  verdict?: "pass" | "fail" | "uncertain" | "not_assessed";
  since?: string;
  before?: string;
  limit?: number;
  excludeBatchRuns?: boolean;
}

export function handleRuns(args: Record<string, unknown>, ctx: ToolContext): TasksRunsOutput {
  const {
    taskId,
    label,
    verdict,
    since,
    before,
    limit = 20,
    excludeBatchRuns,
  } = args as unknown as RunsInput;
  if (before !== undefined && Number.isNaN(new Date(before).getTime())) {
    throw new Error(`Invalid before timestamp: "${before}"`);
  }
  // A deleted task's history is still read by its id, so the task need not exist.
  const excludeBatch = excludeBatchRuns === true ? { excludeBatch: true } : {};
  const read = (pageBefore: string | undefined, pageLimit: number): RunsPage =>
    readRunsPageOf(ctx, taskId, { limit: pageLimit, since, before: pageBefore, ...excludeBatch });

  if (label === undefined && verdict === undefined) {
    const page = read(before, limit);
    return {
      runs: page.runs.map(toRunView),
      total: page.runs.length,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    };
  }

  // Filtered: read pages back until the page is full or the scan cap is
  // reached, then answer with where to go on from.
  const keep = (run: TaskRun): boolean =>
    (label === undefined || labelOf(run) === label) &&
    (verdict === undefined || (isAssessable(run) && effectiveVerdict(run.assessment) === verdict));
  const matched: TaskRun[] = [];
  let cursor = before;
  let scanned = 0;
  let next: string | undefined;
  for (;;) {
    const page = read(cursor, FILTER_SCAN_PAGE);
    scanned += page.runs.length;
    matched.push(...page.runs.filter(keep));
    next = page.nextBefore;
    if (matched.length >= limit || !next || scanned >= FILTER_SCAN_CAP) break;
    cursor = next;
  }
  if (matched.length <= limit) {
    return {
      runs: matched.map(toRunView),
      total: matched.length,
      ...(next ? { nextBefore: next } : {}),
    };
  }
  const runs = cutPage(matched, limit);
  const last = runs[runs.length - 1];
  return {
    runs: runs.map(toRunView),
    total: runs.length,
    ...(last ? { nextBefore: last.startedAt } : {}),
  };
}

/**
 * The first `limit` runs (newest first), extended so runs that share a start
 * time are never split: a `before` cursor at that time would skip the rest.
 */
function cutPage(runs: TaskRun[], limit: number): TaskRun[] {
  const startedMs = (r: TaskRun) => new Date(r.startedAt).getTime();
  let cut = limit;
  while (cut > 0 && cut < runs.length && startedMs(runs[cut]!) === startedMs(runs[cut - 1]!)) {
    cut++;
  }
  return runs.slice(0, cut);
}

/**
 * One page of runs, newest first, with the `before` that continues it: one
 * task's history through its archive months, or every task's (one extra run
 * read to know whether more remain, a start-time group never split).
 */
function readRunsPageOf(
  ctx: ToolContext,
  taskId: string | undefined,
  opts: ReadRunsOptions & { limit: number },
): RunsPage {
  if (taskId !== undefined) return ctx.readRunsPage(taskId, opts);
  const read = ctx.readAllRuns({ ...opts, limit: opts.limit + 1 });
  if (read.length <= opts.limit) return { runs: read };
  const runs = cutPage(read, opts.limit);
  const last = runs[runs.length - 1];
  return { runs, ...(last ? { nextBefore: last.startedAt } : {}) };
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
    tasks = [requireTask(defs, taskId)];
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
 * One of the caller's runs by id, wherever it is: through the task named, the
 * run's ticket (a run `tasks__run` asked for), the runs in flight or queued
 * now, or the hot run index of each of the caller's tasks. `task` is absent
 * when the run's task has since been deleted.
 */
function locateRun(
  ctx: ToolContext,
  runId: string,
  taskId: string | undefined,
): { taskId: string; task?: Task; run: TaskRun } {
  const defs = ctx.definitions();
  if (taskId !== undefined) {
    const task = requireTask(defs, taskId);
    const run = ctx.findRun?.(task.id, runId) ?? openRunOf(ctx, runId, task.id);
    if (!run) throw new Error(`No run "${runId}" in task "${task.id}".`);
    return { taskId: task.id, task, run };
  }
  const ticket = ctx.readRunTicket?.(runId);
  if (ticket) {
    const run = isOpenRun(ticket.run)
      ? ticket.run
      : (ctx.findRun?.(ticket.taskId, runId) ?? ticket.run);
    return { taskId: ticket.taskId, task: defs.get(ticket.taskId), run };
  }
  const open = openRunOf(ctx, runId);
  if (open) return { taskId: open.taskId, task: defs.get(open.taskId), run: open };
  for (const task of defs.values()) {
    const run = ctx.readRuns(task.id).find((r) => r.id === runId);
    if (run) return { taskId: task.id, task, run };
  }
  throw new Error(
    `No run "${runId}" among your tasks' recent runs. Pass its taskId too for a run past the ` +
      "newest 1000 of its task.",
  );
}

/**
 * A run in flight or queued now, as a record of what is known of it so far;
 * null when none has that id. A scheduled or event run has no ticket, and its
 * record is written only when it ends.
 */
function openRunOf(ctx: ToolContext, runId: string, taskId?: string): TaskRun | null {
  const entry = ctx.queueView?.().find((e) => e.runId === runId);
  if (!entry || (taskId !== undefined && entry.taskId !== taskId)) return null;
  return {
    id: runId,
    taskId: entry.taskId,
    startedAt: entry.startedAt ?? new Date().toISOString(),
    status: entry.state,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    iterations: 0,
    ...(entry.trigger ? { trigger: entry.trigger } : {}),
  };
}

/** A result sidecar less the ids the run record beside it carries. */
function resultBody(result: TaskRunResult): TaskRunResultBody {
  const { runId: _runId, taskId: _taskId, ...body } = result;
  return body;
}

/**
 * `tasks__run_result`: one run by id, in whatever state it is. A run still
 * queued or running is an answer (`status`), so a caller polls by calling
 * again; an ended one carries its record and, when it left one, its full
 * deliverable: the untruncated output, the activity log, file refs, usage,
 * and the parsed `structured` output.
 */
export function handleRunResult(
  args: Record<string, unknown>,
  ctx: ToolContext,
): TasksRunResultOutput {
  const { runId, taskId: givenTaskId } = args as unknown as { runId: string; taskId?: string };
  const { taskId, run } = locateRun(ctx, runId, givenTaskId);
  // Recorded but not yet judged: its label would read Succeeded until the
  // verdict lands, so it is not ended yet.
  if (ctx.isAssessing?.(runId)) {
    return {
      status: "running",
      run: { ...toRunView(run), label: "Running" },
      message:
        `Run "${runId}" has finished and is being assessed against its criteria. Call ` +
        "tasks__run_result again until its status is ended.",
    };
  }
  if (run.status === "queued" || run.status === "running") {
    const position =
      run.status === "queued"
        ? ctx.queueView?.().find((e) => e.runId === runId)?.position
        : undefined;
    return {
      status: run.status,
      run: toRunView(run),
      ...(position !== undefined ? { position } : {}),
      message:
        `Run "${runId}" is ${run.status === "queued" ? "queued" : "still running"}; it has not ` +
        "failed. Call tasks__run_result again until its status is ended, or stop it with " +
        `tasks__cancel (runId "${runId}").`,
    };
  }
  const result = ctx.readRunResult(taskId, runId);
  return {
    status: "ended",
    run: toRunView(run),
    ...(result ? { result: resultBody(result) } : {}),
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
 * An inline one-off's manifest: create's definition fields, without identity
 * (name, kind) or trigger (schedule, enabled).
 */
export interface InlineManifest {
  skill?: string;
  model?: string;
  allowedTools?: string[];
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  tokenBudget?: TokenBudget;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  criteria?: Criterion[];
  confidenceThreshold?: number;
  judge?: TaskJudge;
  onPoorResult?: OnPoorResult;
}

/**
 * An inline one-off's definition (`definition` on `tasks__run` and
 * `tasks__run_batch`): the shape of `tasks__create`'s `{ manifest, body }`.
 */
export interface InlineDefinition {
  manifest?: InlineManifest;
  body?: string;
}

/** `tasks__run`'s arguments, already shape-checked by the tool's input schema. */
interface RunArgs {
  taskId?: string;
  definition?: InlineDefinition;
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
  "model",
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

/**
 * Find or create the `oneoff` task an inline `definition` names
 * (`tasks__run`, `tasks__run_batch`). The definition and the input(s) are
 * checked (`checkInput`, given the one-off's id and input schema) before
 * anything is written, so a refused call leaves no one-off behind. With
 * `idSeed` (the call's idempotency key, namespaced by tool) the one-off's id
 * is derived from it, and a seed that already names a one-off with a different
 * definition is refused rather than run against the old one.
 */
export function ensureOneoff(
  def: InlineDefinition,
  ctx: ToolContext,
  checkInput: (id: string, inputSchema: Record<string, unknown> | undefined) => void,
  idSeed: string | undefined,
): Task {
  const manifest = def.manifest ?? {};
  if (!def.body && !manifest.skill) {
    throw new Error("A `definition` needs a `body` (the prompt), or a `manifest.skill`.");
  }
  validateTaskFields(manifest);
  const id = oneoffId(idSeed);
  const prompt =
    def.body ||
    `Carry out the "${manifest.skill}" skill on this run's input, and give its result as the deliverable.`;
  const definition = { prompt, ...manifest };

  checkInput(id, manifest.inputSchema);

  const existing = ctx.definitions().get(id);
  if (existing) {
    if (oneoffDefinition(existing) !== oneoffDefinition(definition)) {
      throw new Error(
        "idempotencyKey reused with a different definition: this key already started a one-off " +
          "with another body or manifest. Use a new key for a new definition, or repeat the " +
          "original definition to get its run.",
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
  if ((args.taskId === undefined) === (args.definition === undefined)) {
    throw new Error(
      "Give `taskId` (a task to run, from tasks__list) or `definition` (a one-off), not both.",
    );
  }
  const key = args.idempotencyKey;
  if (key !== undefined && (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
    throw new Error(`idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }

  // Ensure scheduler has fresh definitions (e.g., task just created)
  ctx.reloadScheduler();

  let task: Task;
  if (args.taskId !== undefined) {
    task = requireTask(ctx.definitions(), args.taskId);
    checkRunInput(task.name, task.inputSchema, args.input);
  } else {
    // Checks the input against the inline definition before creating anything.
    task = ensureOneoff(
      args.definition ?? {},
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
  const { enabled } = disabledState(ctx, task);
  const same = "An earlier call with this idempotencyKey already started this run";
  const { run } = ticket;
  if (!isOpenRun(run)) {
    return { run: toRunView(run), enabled, message: `${same}; this is its record.` };
  }
  const where = followUp(ticket.runId);
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
    const { enabled } = disabledState(ctx, task);
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
    const { enabled, disabledNote } = disabledState(ctx, task);
    return {
      status: "queued",
      taskId: task.id,
      runId,
      position: ticket.position,
      queuedAt,
      enabled,
      message:
        `"${name}" is queued at position ${ticket.position}: every task run slot is busy, ` +
        `and it starts as soon as one frees. ${followUp(runId)}${disabledNote}`,
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
  const { enabled, disabledNote } = disabledState(ctx, task);

  if (outcome === PENDING) {
    return {
      status: "dispatched",
      taskId: task.id,
      runId,
      startedAt,
      enabled,
      message:
        `"${name}" is still running after ${waitMs / 1000}s and continues in the background; ` +
        `it has not failed. ${followUp(runId)}${disabledNote}`,
    };
  }

  return disabledNote
    ? { run: toRunView(outcome), enabled, message: disabledNote.trim() }
    : { run: toRunView(outcome), enabled };
}

/** How to follow a run that has not ended. */
function followUp(runId: string): string {
  return (
    `Call tasks__run_result (runId "${runId}") until its status is ended; ` +
    `tasks__cancel (runId "${runId}") stops it.`
  );
}

/**
 * The task's current `enabled` flag, and a note for a disabled one. Run
 * now runs a disabled task (see `Scheduler.requestRunNow`); the note says
 * so, since its schedule and events will not fire it again.
 */
function disabledState(ctx: ToolContext, task: Task): { enabled: boolean; disabledNote: string } {
  const current = ctx.definitions().get(task.id) ?? task;
  const enabled = current.enabled;
  // `enabled` gates only the trigger; with none there is nothing to say.
  const disabledNote =
    enabled || !current.schedule
      ? ""
      : ` "${current.name}" is disabled, so its schedule and events will not fire it; enable it to run unattended.`;
  return { enabled, disabledNote };
}

/**
 * Cancel one run by id: abort it in flight, or take it out of the queue
 * (recorded cancelled). A batch's runs are cancelled with the batch
 * (`tasks__batch_control`), but one of them can be cancelled here too.
 */
export function handleCancel(args: Record<string, unknown>, ctx: ToolContext): TasksCancelOutput {
  const { runId } = args as unknown as { runId: string };
  const taskId =
    ctx.queueView?.().find((e) => e.runId === runId)?.taskId ?? ctx.readRunTicket?.(runId)?.taskId;
  const cancelled = ctx.cancelRun(runId);
  return {
    cancelled,
    runId,
    ...(taskId !== undefined ? { taskId } : {}),
    message: cancelled
      ? `Run "${runId}" cancelled.`
      : `Run "${runId}" is not queued or running (it has ended, or no run of yours has that id).`,
  };
}

/** `tasks__assess`'s arguments, already shape-checked by its input schema. */
interface AssessInput {
  runId: string;
  taskId?: string;
  verdict?: "pass" | "fail";
  note?: string;
  reassess?: boolean;
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
  const { runId, taskId, verdict, note, reassess } = args as unknown as AssessInput;
  if ((verdict === undefined) === (reassess !== true)) {
    throw new Error("Give `verdict` (pass or fail) or `reassess: true`: one of the two.");
  }
  if (note !== undefined && verdict === undefined) {
    throw new Error("`note` goes with a `verdict`.");
  }
  const located = locateRun(ctx, runId, taskId);
  const { run } = located;
  const task = located.task ?? requireTask(ctx.definitions(), located.taskId);
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
