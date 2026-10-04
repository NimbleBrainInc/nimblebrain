/**
 * Automation tool handlers + helpers for the in-process `automations` platform
 * source (`src/platform/tasks/source.ts`). Exposes the create / update /
 * delete / list / status / runs / run_result / run / cancel handlers and the
 * `ToolContext` they run against. The former standalone stdio MCP server was
 * removed when automations moved in-process and workspace-owned; this file is
 * handlers + formatting only.
 */

import { createHash, randomBytes } from "node:crypto";
import { Cron } from "croner";
import {
  describeClampedLimits,
  type EffectiveRunLimits,
  effectiveRunLimits,
} from "../../config/automations.ts";
import {
  AUTOMATIONS_LIST_DEFAULT_LIMIT,
  AUTOMATIONS_LIST_MAX_LIMIT,
  MAX_ITERATIONS,
} from "../../limits.ts";
import type {
  AutomationEffectiveLimits,
  AutomationSummary,
  AutomationsCancelOutput,
  AutomationsCreateOutput,
  AutomationsDeleteOutput,
  AutomationsListOutput,
  AutomationsRunOutput,
  AutomationsRunResultOutput,
  AutomationsRunsOutput,
  AutomationsStatusOutput,
  AutomationsUpdateOutput,
} from "../schemas/tasks.ts";
import { createAutomation, deleteAutomation, updateAutomation } from "./domain.ts";
import { containsRecursiveTool } from "./executor.ts";
import { assertJsonSchema, checkAgainstSchema } from "./json-schema.ts";
import { isOpenRun, type RequestedRun, type RunNowTicket } from "./scheduler.ts";
import type { ReadRunsOptions, RunsPage } from "./store.ts";
import {
  type Automation,
  type AutomationKind,
  type AutomationRun,
  type AutomationRunResult,
  DEFAULT_EVENT_DEBOUNCE_MS,
  DEFAULT_EVENT_MAX_FIRES_PER_HOUR,
  isEventSchedule,
  kindOf,
  MAX_EVENT_DEBOUNCE_MS,
  MAX_EVENT_MAX_FIRES_PER_HOUR,
  onceRetirement,
  type RunTicket,
  type ScheduleSpec,
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
  state?: Pick<Automation, "onceDone">,
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
 * whole of what an operator needs to recognise the automation in a list.
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

export function estimateCost(automation: Automation, workspaceDefaultModel?: string): CostEstimate {
  const rates = getModelRates(automation.model ?? workspaceDefaultModel);
  // Use actual average if available, otherwise a realistic per-run estimate.
  // maxInputTokens is a ceiling (unset = none), NOT an estimate — actual runs
  // typically use 15-25K input tokens. Using the ceiling produces wildly inflated costs.
  const hasHistory = automation.runCount > 0 && automation.cumulativeInputTokens > 0;
  const inputTokens = hasHistory ? automation.cumulativeInputTokens / automation.runCount : 20_000; // realistic per-run estimate
  const outputTokens = hasHistory ? automation.cumulativeOutputTokens / automation.runCount : 500;
  const perRunUsd = (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
  const runsPerDay = estimateRunsPerDay(automation.schedule);
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
  definitions: () => Map<string, Automation>;
  save: (defs: Map<string, Automation>) => void;
  reloadScheduler: () => void;
  /**
   * Ask the scheduler to run the automation now; null when it is not loaded.
   * `requested` names the run (its id, input, and idempotency key), and the
   * run's ticket is written before this returns.
   */
  runNow: (automationId: string, requested?: RequestedRun) => RunNowTicket | null;
  /**
   * A requested run's ticket by run id (this owner, this workspace), settled
   * first when it was left open by a process that stopped. Null when none.
   */
  readRunTicket?: (runId: string) => RunTicket | null;
  /** The run an idempotency key started on this automation, as its ticket; null when none. */
  findRunByKey?: (automationId: string, key: string) => RunTicket | null;
  /** A queued run's place in the run queue (1 is next), or null when it is not queued. */
  queuePosition?: (automationId: string) => number | null;
  cancelRun: (automationId: string) => boolean;
  /** Read one automation's run history (workspace + owner bound at construction). */
  readRuns: (automationId: string, opts?: ReadRunsOptions) => AutomationRun[];
  /** Read one page of an automation's full history, back through its archive months. */
  readRunsPage: (automationId: string, opts: ReadRunsOptions) => RunsPage;
  /** Read run history across this owner's automations in the focused workspace. */
  readAllRuns: (opts?: ReadRunsOptions) => AutomationRun[];
  /** Read one run's full result sidecar (the deliverable). */
  readRunResult: (automationId: string, runId: string) => AutomationRunResult | null;
  defaultTimezone: string;
  /**
   * The caps a run of an automation executes under, for create and update to
   * report. The executor applies the same function. Absent: the built-in
   * ceilings and the runtime's built-in iteration default.
   */
  runLimitsOf?: (automation: Automation) => EffectiveRunLimits;
  /** Workspace default model (for cost estimation when automation.model is null). */
  defaultModel?: string;
  /** Current user ID (for setting automation ownership at creation time). */
  currentUserId?: string;
  /** Current workspace ID (for setting automation workspace scope at creation time). */
  currentWorkspaceId?: string;
  /**
   * Override the `handleRun` sync-wait deadline (ms). Production callers
   * leave this unset and get the default `HANDLE_RUN_SYNC_WAIT_MS`; tests
   * use it to exercise the "dispatched, still running" envelope without
   * having to wait 30s. Has no effect outside `handleRun`.
   */
  handleRunSyncWaitMs?: number;
}

/**
 * Validate schedule, iteration, and token fields. Throws on invalid input.
 *
 * Accepts either a full create-manifest or a partial update-patch — both
 * have the same load-bearing fields (`schedule`, `maxIterations`,
 * `maxInputTokens`, `maxRunDurationMs`). The signature is the union so
 * callers don't need synthetic flat-record casts.
 */
export interface ValidatableAutomationFields {
  /** `null` is an update's clear: nothing to validate. */
  schedule?: ScheduleSpec | null;
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  allowedTools?: string[];
  /** `null` is an update's clear: nothing to validate. */
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
}

export function validateAutomationFields(args: ValidatableAutomationFields): void {
  if (args.schedule) validateSchedule(args.schedule);
  validateNumericLimits(args);
  if (args.inputSchema != null) assertJsonSchema(args.inputSchema, "inputSchema");
  if (args.outputSchema != null) assertJsonSchema(args.outputSchema, "outputSchema");
  // The executor refuses to run such an automation; refusing it here tells the
  // author at write time instead of at the first run.
  const recursive = containsRecursiveTool(args.allowedTools);
  if (recursive !== null) {
    throw new Error(
      `allowedTools may not include "${recursive}": an automation cannot create, update, or ` +
        "delete automations from its own runs.",
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
        'automation, e.g. { source: "acme", name: "reply.*" }',
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
function validateNumericLimits(args: ValidatableAutomationFields): void {
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
 * `createAutomation` from `domain.ts` directly with the full shape.
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
    tokenBudget?: Automation["tokenBudget"];
    kind?: AutomationKind;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  };
  body: string;
}

export function handleCreate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): AutomationsCreateOutput {
  const { manifest, body } = args as unknown as CreateInput;

  validateAutomationFields(manifest);

  const result = createAutomation(
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
 * Attach the caps the automation's runs execute under, and name any cap the
 * definition sets above its ceiling, so the caller learns at write time what a
 * run will actually be held to.
 */
function withEffectiveLimits<T extends { automation: Automation; message: string }>(
  result: T,
  ctx: ToolContext,
): T & { effectiveLimits: AutomationEffectiveLimits } {
  const effectiveLimits = (ctx.runLimitsOf ?? effectiveRunLimits)(result.automation);
  const notes = describeClampedLimits(result.automation, effectiveLimits);
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
    Omit<CreateInput["manifest"], "name" | "schedule" | "kind" | "inputSchema" | "outputSchema">
  > & {
    /** `null` clears it: nothing fires the automation unattended. */
    schedule?: ScheduleSpec | null;
    /** `null` clears it: runs take any input. */
    inputSchema?: Record<string, unknown> | null;
    /** `null` clears it: the deliverable is not checked. */
    outputSchema?: Record<string, unknown> | null;
  };
  body?: string;
}

export function handleUpdate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): AutomationsUpdateOutput {
  const { name, manifest: patch, body } = args as unknown as UpdateInput;
  if (!name) throw new Error("Missing required field: name");

  if (patch) {
    validateAutomationFields(patch);
  }

  const result = updateAutomation(
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

export function handleDelete(
  args: Record<string, unknown>,
  ctx: ToolContext,
): AutomationsDeleteOutput {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");
  return deleteAutomation(name, ctx);
}

export function handleList(args: Record<string, unknown>, ctx: ToolContext): AutomationsListOutput {
  const defs = ctx.definitions();
  const now = Date.now();

  let automations = Array.from(defs.values());

  // Apply filters
  if (args.enabled !== undefined) {
    automations = automations.filter((a) => a.enabled === args.enabled);
  }
  if (args.source !== undefined) {
    automations = automations.filter((a) => a.source === args.source);
  }
  // Saved by default: a one-off is kept with its history, not listed with the
  // automations someone keeps.
  const kind = (args.kind as AutomationKind | "all" | undefined) ?? "saved";
  if (kind !== "all") {
    automations = automations.filter((a) => kindOf(a) === kind);
  }

  // Page AFTER filtering so `total` describes the filter's real match count,
  // which is what a caller deciding whether it has seen everything needs.
  const total = automations.length;

  // Definitions come off readdirSync with no ordering anywhere on the path, so
  // without this the sequence a page slices is undefined — two calls could
  // interleave differently and a record could appear on both pages or neither.
  // Sort by id: unique by construction, so the order is total rather than
  // merely deterministic, which is what makes the cursor below unambiguous.
  automations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Cursor, not offset: the caller may delete an automation between pages, and
  // a numeric offset would re-slice the shortened list and skip whatever moved
  // across the boundary — the same "concluded it wasn't there" failure this
  // tool's paging exists to prevent. Anchoring to the last id read is the
  // pattern conversation listing already uses. An unknown cursor (its record
  // was deleted) leaves the slice untouched and re-serves the first page,
  // which repeats work rather than skipping any.
  const cursor = args.cursor as string | undefined;
  if (cursor) {
    const idx = automations.findIndex((a) => a.id === cursor);
    if (idx >= 0) automations = automations.slice(idx + 1);
  }

  const limit = Math.min(
    Math.max(1, Math.floor((args.limit as number) ?? AUTOMATIONS_LIST_DEFAULT_LIMIT)),
    AUTOMATIONS_LIST_MAX_LIMIT,
  );
  // Remaining after this page, computed from what is actually left rather than
  // from `total` minus a running count — the caller's history is not knowable
  // here, and guessing at it is how the withheld figure goes wrong.
  const remaining = Math.max(0, automations.length - limit);
  automations = automations.slice(0, limit);

  const summaries: AutomationSummary[] = automations.map((a) => ({
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
  }));

  const hasMore = remaining > 0;
  const nextCursor = hasMore ? (summaries[summaries.length - 1]?.id ?? null) : null;
  return {
    automations: summaries,
    total,
    returned: summaries.length,
    nextCursor,
    hasMore,
    ...(hasMore && nextCursor
      ? {
          truncated:
            `Showing ${summaries.length} of ${total} matching automations. ` +
            `${remaining} more remain after this page — this is a partial view. ` +
            `Re-call with cursor="${nextCursor}" to continue before concluding anything ` +
            `about the full set.`,
        }
      : {}),
  };
}

export function handleStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
): AutomationsStatusOutput {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  const limit = (args.limit as number) ?? 5;
  const now = Date.now();

  const runs = ctx.readRuns(automation.id, { limit });

  const cost = estimateCost(automation, ctx.defaultModel);

  const rates = getModelRates(automation.model ?? ctx.defaultModel);
  const actualCostUsd =
    automation.cumulativeInputTokens > 0
      ? (automation.cumulativeInputTokens * rates.input +
          automation.cumulativeOutputTokens * rates.output) /
        1_000_000
      : 0;

  return {
    automation: {
      ...automation,
      scheduleHuman: formatSchedule(automation.schedule, automation),
      lastRunAtHuman: automation.lastRunAt ? formatRelativeTime(automation.lastRunAt, now) : null,
      nextRunAtHuman: automation.nextRunAt ? formatRelativeTime(automation.nextRunAt, now) : null,
      cumulativeInputTokens: automation.cumulativeInputTokens,
      cumulativeOutputTokens: automation.cumulativeOutputTokens,
      tokenBudget: automation.tokenBudget ?? null,
      budgetResetAt: automation.budgetResetAt ?? null,
      actualCostUsd,
      estimatedCostPerRun: cost.perRunUsd,
      estimatedCostPerDay: cost.perDayUsd,
      estimatedCostPerMonth: cost.perMonthUsd,
    },
    recentRuns: runs,
  };
}

export function handleRuns(args: Record<string, unknown>, ctx: ToolContext): AutomationsRunsOutput {
  const automationId = args.automationId as string | undefined;
  const status = args.status as AutomationRun["status"] | undefined;
  const since = args.since as string | undefined;
  const before = args.before as string | undefined;
  const limit = (args.limit as number) ?? 20;
  if (before !== undefined && Number.isNaN(new Date(before).getTime())) {
    throw new Error(`Invalid before timestamp: "${before}"`);
  }

  // One automation's history pages back through its archive with a cursor.
  // The first page (no `before`) reads only the hot index; its `nextBefore`
  // says older runs exist.
  if (automationId) {
    const page = ctx.readRunsPage(automationId, { limit, status, since, before });
    return {
      runs: page.runs,
      total: page.runs.length,
      ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
    };
  }

  const runs = ctx.readAllRuns({ limit, status, since, before });
  return { runs, total: runs.length };
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
): AutomationsRunResultOutput {
  const name = args.name as string | undefined;
  const runId = args.runId as string;
  if (!runId) throw new Error("Missing required field: runId");

  // A run `tasks__run` started is found by its id alone, through its
  // ticket, which also says when it has not ended yet.
  if (!name) {
    const ticket = ctx.readRunTicket?.(runId);
    if (!ticket) {
      throw new Error(
        `Run not found: "${runId}". Pass the automation's name too for a run not started by tasks__run.`,
      );
    }
    if (isOpenRun(ticket.run)) {
      throw new Error(
        `Run "${runId}" is still ${ticket.run.status}; its result is written when it ends.`,
      );
    }
    const result = ctx.readRunResult(ticket.automationId, runId);
    if (!result) {
      throw new Error(
        `Run "${runId}" ended without a result (${ticket.run.status}${ticket.run.error ? `: ${ticket.run.error}` : ""}).`,
      );
    }
    return result;
  }

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  const result = ctx.readRunResult(automation.id, runId);
  if (!result) {
    throw new Error(`Run result not found: "${runId}" for automation "${name}".`);
  }
  return result;
}

/**
 * Maximum time `handleRun` will hold the MCP request awaiting completion
 * before returning a "dispatched, still running" envelope. Sized well
 * below the SDK's 60s default request timeout — without this cap, any
 * automation that takes longer than ~60s collides with the timeout and
 * the agent sees `-32001 Request timed out` while the run is healthy
 * and proceeding in the background. The scheduler continues to track
 * the run; callers can poll `tasks__runs` for the final record.
 */
const HANDLE_RUN_SYNC_WAIT_MS = 30_000;

/** The most a run's JSON `input` may take, serialized. It is kept on the run record. */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

/** The longest idempotency key `tasks__run` takes. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * An inline one-off's definition: `tasks__run` with these instead of
 * `name` creates a `oneoff` automation with no schedule and runs it once.
 */
interface InlineDefinition {
  prompt?: string;
  skill?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  limits?: { maxIterations?: number; maxInputTokens?: number; maxRunDurationMs?: number };
  budget?: TokenBudget;
}

/** The fields of `tasks__run` that make it an inline one-off. */
const INLINE_FIELDS = [
  "prompt",
  "skill",
  "inputSchema",
  "outputSchema",
  "allowedTools",
  "limits",
  "budget",
] as const;

/** `tasks__run`'s arguments, already shape-checked by the tool's input schema. */
interface RunArgs extends InlineDefinition {
  name?: string;
  input?: unknown;
  idempotencyKey?: string;
}

/** What `tasks__run` became: a run it asked for, or one an idempotency key already started. */
export type PreparedRun =
  | { kind: "existing"; automation: Automation; ticket: RunTicket }
  | {
      kind: "requested";
      automation: Automation;
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
function oneoffId(idempotencyKey: string | undefined): string {
  const token =
    idempotencyKey !== undefined
      ? createHash("sha256").update(idempotencyKey, "utf-8").digest("hex").slice(0, 20)
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
  source: Partial<Pick<Automation, (typeof ONEOFF_DEFINITION_FIELDS)[number]>>,
): string {
  return canonicalJson(Object.fromEntries(ONEOFF_DEFINITION_FIELDS.map((f) => [f, source[f]])));
}

/**
 * Find or create the `oneoff` automation an inline `tasks__run` names.
 * The definition and the run's input are checked before anything is written,
 * so a refused call leaves no one-off behind. A key that already names a
 * one-off with a different definition is refused rather than run against the
 * old one.
 */
function ensureOneoff(args: RunArgs, ctx: ToolContext): Automation {
  if (!args.prompt && !args.skill) {
    throw new Error(
      "tasks__run needs `name` (an automation to run) or an inline definition with " +
        "`prompt` or `skill`.",
    );
  }
  const limits = args.limits ?? {};
  validateAutomationFields({
    ...limits,
    ...(args.allowedTools ? { allowedTools: args.allowedTools } : {}),
    ...(args.inputSchema ? { inputSchema: args.inputSchema } : {}),
    ...(args.outputSchema ? { outputSchema: args.outputSchema } : {}),
  });
  const id = oneoffId(args.idempotencyKey);
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
  };

  checkRunInput(id, args.inputSchema, args.input);

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

  const { automation } = createAutomation(
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
  return automation;
}

/** Refuse a run input that is too large or does not match the `inputSchema` of the automation `name`. */
function checkRunInput(
  name: string,
  inputSchema: Record<string, unknown> | undefined,
  input: unknown,
): void {
  if (input === undefined) {
    if (inputSchema && !checkAgainstSchema(inputSchema, null).valid) {
      throw new Error(`"${name}" takes an input matching its inputSchema; none was given.`);
    }
    return;
  }
  const size = Buffer.byteLength(JSON.stringify(input) ?? "", "utf-8");
  if (size > MAX_RUN_INPUT_BYTES) {
    throw new Error(
      `input is ${size} bytes serialized; a run's input may be at most ${MAX_RUN_INPUT_BYTES}. ` +
        "Pass a reference (a file id or URL) instead of the content.",
    );
  }
  if (!inputSchema) return;
  const verdict = checkAgainstSchema(inputSchema, input);
  if (!verdict.valid) {
    throw new Error(
      `input does not match the inputSchema of "${name}": ${verdict.errors.join("; ")}`,
    );
  }
}

/**
 * Resolve what `tasks__run` runs and ask for the run: a saved
 * automation by `name`, or an inline definition run as a one-off. The input
 * is checked first, and an idempotency key already used on the automation
 * returns that run instead of asking for another. Shared by the inline call
 * and the task-augmented one, so the two cannot disagree on what a call
 * starts.
 */
export function prepareRun(rawArgs: Record<string, unknown>, ctx: ToolContext): PreparedRun {
  const args = rawArgs as RunArgs;
  const inline = INLINE_FIELDS.filter((field) => args[field] !== undefined);
  if (args.name && inline.length > 0) {
    throw new Error(
      `Give either \`name\` (an automation to run) or an inline definition, not both ` +
        `(also given: ${inline.join(", ")}).`,
    );
  }
  const key = args.idempotencyKey;
  if (key !== undefined && (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
    throw new Error(`idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }

  // Ensure scheduler has fresh definitions (e.g., automation just created)
  ctx.reloadScheduler();

  let automation: Automation;
  if (args.name) {
    const found = findByName(ctx.definitions(), args.name);
    if (!found) throw new Error(`Automation not found: "${args.name}"`);
    automation = found;
    checkRunInput(automation.name, automation.inputSchema, args.input);
  } else {
    // Checks the input against the inline definition before creating anything.
    automation = ensureOneoff(args, ctx);
  }

  if (key !== undefined) {
    const existing = ctx.findRunByKey?.(automation.id, key);
    if (existing) return { kind: "existing", automation, ticket: existing };
  }

  const requested: RequestedRun = {
    runId: newRunId(),
    requestedAt: new Date().toISOString(),
    ...(args.input !== undefined ? { input: args.input } : {}),
    ...(key !== undefined ? { idempotencyKey: key } : {}),
  };
  log(`handleRun: running "${automation.id}" as ${requested.runId}`);
  const ticket = ctx.runNow(automation.id, requested);
  if (!ticket) {
    const ids = Array.from(ctx.definitions().keys());
    log(
      `handleRun: runNow returned null for "${automation.id}". Scheduler has ${ids.length} definitions: [${ids.join(", ")}]`,
    );
    throw new Error(
      `Failed to trigger run for "${automation.name}" (id=${automation.id}). The scheduler could not find this automation. Try reloading.`,
    );
  }
  return { kind: "requested", automation, requested, ticket };
}

/** The answer for a run an earlier call with the same idempotency key started. */
function existingRunAnswer(
  automation: Automation,
  ticket: RunTicket,
  ctx: ToolContext,
): AutomationsRunOutput {
  const { enabled } = disabledState(ctx, automation.name, automation);
  const same = "An earlier call with this idempotencyKey already started this run";
  const { run } = ticket;
  if (!isOpenRun(run)) {
    return { run, enabled, message: `${same}; this is its record.` };
  }
  const where =
    `Its record appears in tasks__runs (automationId "${automation.id}") when it ends; ` +
    `read it with tasks__run_result (runId "${ticket.runId}").`;
  if (run.status === "queued") {
    return {
      status: "queued",
      automationId: automation.id,
      runId: ticket.runId,
      position: ctx.queuePosition?.(automation.id) ?? 1,
      queuedAt: ticket.requestedAt,
      enabled,
      message: `${same}, and it is still queued. ${where}`,
    };
  }
  return {
    status: "dispatched",
    automationId: automation.id,
    runId: ticket.runId,
    startedAt: run.startedAt,
    enabled,
    message: `${same}, and it is still running. ${where}`,
  };
}

export async function handleRun(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<AutomationsRunOutput> {
  const prepared = prepareRun(args, ctx);
  const { automation } = prepared;
  const name = automation.name;
  if (prepared.kind === "existing") return existingRunAnswer(automation, prepared.ticket, ctx);
  const { ticket, requested } = prepared;
  const runId = requested.runId;

  if (ticket.state === "refused") {
    const { enabled } = disabledState(ctx, name, automation);
    return {
      run: ticket.run,
      enabled,
      message: `"${name}" did not run: ${ticket.run.error ?? "the scheduler refused it"}`,
    };
  }

  if (ticket.state === "queued") {
    // The queued run is the scheduler's to finish; nothing awaits it here.
    ticket.run.catch(() => {});
    const queuedAt = requested.requestedAt;
    const { enabled, disabledNote } = disabledState(ctx, name, automation);
    return {
      status: "queued",
      automationId: automation.id,
      runId,
      position: ticket.position,
      queuedAt,
      enabled,
      message:
        `"${name}" is queued at position ${ticket.position}: every automation run slot is busy, ` +
        `and it starts as soon as one frees. When it ends, read it with tasks__run_result ` +
        `(runId "${runId}"); it also appears in tasks__runs (automationId ` +
        `"${automation.id}", since "${queuedAt}"). Remove it from the queue with ` +
        `tasks__cancel.${disabledNote}`,
    };
  }

  // Race the run against a sync-wait deadline. Quick automations finish
  // inside the window and return their full run record; longer ones get
  // a "dispatched" envelope so the agent can poll instead of seeing a
  // false -32001 failure.
  //
  // `Scheduler.dispatchRun` synthesizes a failure record for any
  // executor throw and returns it — so the EXECUTOR side never rejects.
  // BUT `updateAfterRun` (called from `dispatchRun` after the executor
  // settles) does filesystem I/O — `appendRun` + `saveAutomation` — and
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
  // past handleRun returning. Quick automations + bursty traffic would
  // accumulate live timers under load and delay clean process shutdown.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), waitMs);
  });
  let outcome: AutomationRun | typeof PENDING;
  try {
    outcome = await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // Read after the run settles: the run itself can disable it (failure
  // auto-disable, token budget).
  const { enabled, disabledNote } = disabledState(ctx, name, automation);

  if (outcome === PENDING) {
    return {
      status: "dispatched",
      automationId: automation.id,
      runId,
      startedAt,
      enabled,
      message:
        `"${name}" is still running after ${waitMs / 1000}s and continues in the background; ` +
        `it has not failed. When it ends, read its full output with tasks__run_result ` +
        `(runId "${runId}"); it also appears in tasks__runs (automationId ` +
        `"${automation.id}", since "${startedAt}"). Stop it with tasks__cancel.${disabledNote}`,
    };
  }

  return disabledNote
    ? { run: outcome, enabled, message: disabledNote.trim() }
    : { run: outcome, enabled };
}

/**
 * The automation's current `enabled` flag, and a note for a disabled one. Run
 * now runs a disabled automation (see `Scheduler.requestRunNow`); the note says
 * so, since its schedule and events will not fire it again.
 */
function disabledState(
  ctx: ToolContext,
  name: string,
  automation: Automation,
): { enabled: boolean; disabledNote: string } {
  const current = findByName(ctx.definitions(), name) ?? automation;
  const enabled = current.enabled;
  // `enabled` gates only the trigger; with none there is nothing to say.
  const disabledNote =
    enabled || !current.schedule
      ? ""
      : ` "${name}" is disabled, so its schedule and events will not fire it; enable it to run unattended.`;
  return { enabled, disabledNote };
}

export function handleCancel(
  args: Record<string, unknown>,
  ctx: ToolContext,
): AutomationsCancelOutput {
  const name = args.name as string;
  if (!name) throw new Error("Missing required field: name");

  // Ensure scheduler has fresh definitions
  ctx.reloadScheduler();

  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  const cancelled = ctx.cancelRun(automation.id);
  return {
    cancelled,
    id: automation.id,
    message: cancelled
      ? `Automation "${name}" run cancelled.`
      : `Automation "${name}" has no running or queued run to cancel.`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByName(defs: Map<string, Automation>, name: string): Automation | undefined {
  // First try direct id lookup (kebab-case of name)
  const byId = defs.get(toKebabCase(name));
  if (byId) return byId;

  // Fall back to name match
  for (const auto of defs.values()) {
    if (auto.name === name) return auto;
  }
  return undefined;
}
