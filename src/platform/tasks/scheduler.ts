/**
 * Scheduling engine for tasks.
 *
 * Uses setTimeout-based timer armed to the next-due job (max 60s wake).
 * Evaluates cron expressions via Croner. Handles interval scheduling,
 * per-task concurrency guards, and exponential backoff. How many runs
 * execute at once, and the queue beyond that, belong to the runtime's run
 * admission (`src/runtime/admission.ts`); the scheduler asks it for a slot and
 * renders its answers as run records.
 *
 * The scheduler does NOT execute runs directly — it delegates to an
 * executor function injected at construction time.
 */

import { randomBytes } from "node:crypto";
import { Cron } from "croner";
import { taskRunsTotal } from "../../api/metrics.ts";
import { log } from "../../observability/log.ts";
import {
  type AdmissionLease,
  type AdmissionRefusal,
  type AdmissionWithdrawal,
  createRunAdmission,
  type RunAdmission,
} from "../../runtime/admission.ts";
import { runDetached } from "../../runtime/request-context.ts";
import { WorkspaceRootMissingError } from "../../workspace/context.ts";
import { isAssessable, retryGuidance } from "./assessment.ts";
import {
  appendRun,
  loadAllTasks,
  loadTask,
  saveIdempotencyKey,
  saveRunResult,
  saveRunTicket,
  saveTask,
  updateRun,
} from "./store.ts";
import {
  DEFAULT_ON_POOR_RESULT,
  isEventSchedule,
  isOnceSchedule,
  ONCE_GRACE_MS,
  ONCE_MISSED_REASON,
  ONCE_RAN_REASON,
  type RunAssessment,
  type RunTicket,
  type Task,
  type TaskRun,
  type TaskRunResult,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max wake interval — timer fires at least every 60s to catch drift. */
const MAX_TIMER_MS = 60_000;

/** Backoff delays indexed by (consecutiveErrors - 1). Capped at last entry. */
const BACKOFF_DELAYS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;

/** Auto-disable after this many consecutive failures. */
export const MAX_CONSECUTIVE_ERRORS = 10;

/** Why a Run now or event run is refused once `stop()` has run: no slot frees and nothing drains the queue. */
const STOPPED_REASON = "the scheduler is stopped";

/**
 * Prefix on the admission key of every task run. Admission keys are
 * opaque to the runtime and shared by every source, so the scheduler's own
 * are namespaced: `stop()` and `dropWorkspace` withdraw only these.
 */
const ADMISSION_KEY_PREFIX = "task:";

/** The withdrawal reason `dropWorkspace` gives the runs it takes out of the queue. */
const WORKSPACE_DELETED = "workspace_deleted";

/** The withdrawal reason a paused batch gives its runs still waiting in the queue. */
const BATCH_PAUSED = "batch_paused";

/** What `runFromEvent` answers when the task already has a run. */
const EVENT_DUPLICATE_ANSWER = {
  "Already running": "a previous run of this task is still in flight",
  "Already queued": "a previous run of this task is still queued",
} as const;

/** Patterns that classify an error message as transient. */
const TRANSIENT_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /overloaded/i,
  /timeout/i,
  /network/i,
  /ECONNREFUSED/i,
  /5\d\d/,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What initiated a run: the timer (`scheduled`), an operator's Run now
 * (`manual`), or a batch of notifications (`event`). It is recorded on the run
 * and decides nothing about who the run acts as: every run acts as the
 * task's owner, in its workspace (see `resolveExecutorContext`).
 */
export type TaskRunTrigger = "scheduled" | "manual" | "event";

/**
 * Per-run input, for a trigger that carries something the stored prompt does
 * not. An `event` run carries the batch of notifications that fired it; a
 * `manual` run may carry the caller's JSON `input`; a `scheduled` run carries
 * nothing and passes none.
 *
 * It goes ahead of the prompt rather than into it, and it is never persisted
 * on the task: it is one run's input, not part of the definition and not
 * part of any cached prefix.
 */
export interface RunInput {
  /** Goes ahead of the task's own prompt, separated by a blank line. */
  preamble?: string;
  /** The caller's JSON input, rendered as data ahead of the prompt (see the executor). */
  data?: unknown;
}

/** A run holding a slot or waiting for one, as `Scheduler.queueView` reports it. */
export interface QueueViewEntry {
  taskId: string;
  runId?: string;
  state: "running" | "queued";
  /** Queued only: the place among this scheduler's queued runs, 1 next. */
  position?: number;
  /** Running only. */
  startedAt?: string;
  /** Running only: what started it. */
  trigger?: TaskRunTrigger;
}

/**
 * A run asked for by id (`tasks__run`): the id it was given before it
 * was asked for, and what it was asked with. A requested run has a ticket from
 * the moment it is asked for (`RunTicket`), updated as it starts and ends, and
 * its id is the run's id in every record, the runtime's included.
 */
export interface RequestedRun {
  runId: string;
  /** When it was asked for. */
  requestedAt: string;
  input?: unknown;
  idempotencyKey?: string;
  /** The run this one retries (`onPoorResult: "retry_once"`); recorded on the run. */
  retryOf?: string;
  /** Goes ahead of the prompt for this run only: a retry's account of what failed. */
  guidance?: string;
  /** The batch item this run is (`tasks__run_batch`); recorded on the run. */
  batch?: { batchId: string; index: number };
}

/**
 * What a batch run carries beyond a requested run (see
 * {@link Scheduler.requestBatchRun}).
 */
export interface BatchRunOptions {
  /**
   * Spend accounts the run names beyond the task's own (the batch's), read
   * when the run starts so a queued run names what is left then.
   */
  accounts: () => RunSpendAccount[];
  /** Called when the run takes its slot and starts (a queued one later than it was asked for). */
  onStarted?: () => void;
}

/**
 * What a batch run request became. `refused` writes no record: the item was
 * not asked for, and its batch decides what to do (retry later, or pause).
 */
export type BatchRunTicket =
  | { state: "started" | "queued"; run: Promise<TaskRun> }
  | {
      state: "refused";
      /** `queue_full`: no slot and no room to wait; asking again later may work. */
      reason: "not_found" | "stopped" | "queue_full" | "budget";
      message: string;
    };

/**
 * The executor function that the scheduler delegates to. Returns the run summary
 * AND the full run result (the deliverable). `result` is null only when the
 * executor had no clean data (the abort/timeout-as-throw path is handled via
 * rejection, not this shape).
 *
 * `lease` is the run slot the scheduler was admitted to. The executor hands it
 * to `runtime.executeTask` (`TaskRequest.admission`), which runs under it
 * instead of acquiring a second one.
 */
export type Executor = (
  task: Task,
  signal: AbortSignal,
  trigger: TaskRunTrigger,
  input?: RunInput,
  lease?: AdmissionLease,
  /** The run's id when it was minted ahead of the run (a requested run); the runtime adopts it. */
  runId?: string,
  /** Spend accounts the run names beyond the task's own token budget (a batch's). */
  extraAccounts?: readonly RunSpendAccount[],
) => Promise<{ run: TaskRun; result: TaskRunResult | null }>;

/**
 * What a Run now request became, known as soon as it is made.
 *
 * - `started`: a slot was free and the run is in flight.
 * - `queued`: every slot was busy; the run waits in the runtime's run queue
 *   at `position` (its place in arrival order) and starts when a slot frees
 *   and fair share picks it.
 * - `refused`: the run did not start, and `run` is the skipped record saying
 *   why (already running or queued, the queue is full, the budget is spent,
 *   the scheduler is stopped).
 *
 * `run` on the first two resolves with the run's record once it ends, so a
 * caller that wants to wait can, and one that wants to answer now can too.
 */
export type RunNowTicket =
  | { state: "started"; run: Promise<TaskRun> }
  | { state: "queued"; position: number; run: Promise<TaskRun> }
  | { state: "refused"; run: TaskRun };

/**
 * How a queued run left the queue: `started` when it took a slot and ran
 * (`run` is its record), not started when it was dropped, cancelled, or
 * refused on the way out (`run` is the not-started record saying why).
 */
interface QueuedOutcome {
  run: TaskRun;
  started: boolean;
}

/** One run waiting for a slot. */
interface QueuedRun {
  /** The task's key (`keyOf`). */
  key: string;
  /** The run's own key when it is not the task's: a batch run (see `requestBatchRun`). */
  runKey?: string;
  batch?: BatchRunOptions;
  trigger: "manual" | "event";
  input?: RunInput;
  requested?: RequestedRun;
  resolve: (outcome: QueuedOutcome) => void;
  reject: (err: unknown) => void;
}

export interface SchedulerConfig {
  /**
   * The runtime work directory (`{workDir}`). The scheduler is multi-workspace:
   * it scans `{workDir}/workspaces/<wsId>/tasks/<ownerId>/` across every
   * workspace and owner and fires each task as its owner, focused on its
   * provenance workspace. Tasks are workspace-owned (the path is the wall).
   */
  workDir: string;
  /**
   * The run admission every run is admitted through: the runtime's
   * (`Runtime.getRunAdmission`), so task runs share its slots and queue
   * with every other unattended run. Default: a pool of its own with the
   * default limits, for a scheduler run without a runtime (tests).
   */
  admission?: RunAdmission;
  /** Default timezone for cron expressions. Default: system timezone. */
  defaultTimezone?: string;
  /**
   * Called once a run's record is written — completed, failed, cancelled or
   * skipped — with the task's owner. The owner is known here and nowhere
   * upstream of a scheduled run, so this is where the tasks source
   * announces the change to that owner's views.
   */
  onRunRecorded?: (ownerId: string) => void;
  /**
   * Assess a run that left a deliverable, once its record is written (see
   * `judge.ts::assessRun`). Never rejects. Absent: runs are not assessed.
   */
  assess?: (task: Task, run: TaskRun, result: TaskRunResult | null) => Promise<RunAssessment>;
  /** Tell the task's owner a run's assessment failed (`onPoorResult: "notify"`). */
  notifyPoorResult?: (task: Task, run: TaskRun) => void;
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Returns true if the error message matches any transient pattern.
 */
export function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

/**
 * Compute the backoff delay for a given number of consecutive errors.
 * Returns 0 when consecutiveErrors is 0.
 *
 * `ladder` defaults to a task's own, which runs out to an hour because
 * a schedule that keeps failing should be asked less and less often. A caller
 * with a different bound passes its own — the shape (index, clamp at the last
 * entry, zero below one) is what is shared, and the delays are the caller's
 * policy. The notification route dispatcher is the second caller, with three
 * attempts inside five minutes.
 */
export function backoffDelay(
  consecutiveErrors: number,
  ladder: readonly number[] = BACKOFF_DELAYS,
): number {
  if (consecutiveErrors <= 0 || ladder.length === 0) return 0;
  const idx = Math.min(consecutiveErrors - 1, ladder.length - 1);
  return ladder[idx]!;
}

/**
 * Returns true if the task is currently in backoff (should be skipped).
 */
export function isInBackoff(task: Task, now: number): boolean {
  if (task.consecutiveErrors <= 0) return false;
  if (!task.nextRunAt) return false;
  return now < new Date(task.nextRunAt).getTime();
}

/**
 * Compute the next run time for a task based on its schedule.
 */
export function computeNextRunAt(task: Task, now: number, defaultTimezone?: string): number | null {
  const { schedule } = task;

  // No schedule: nothing fires it unattended, so it has no next run.
  if (!schedule) return null;

  // An event schedule has no position in time. Null means "no next run": every
  // caller clears nextRunAt on it (see setNextRunAt), so the timer never arms
  // for it and no backoff or skip path invents a moment for it either.
  if (isEventSchedule(schedule)) return null;

  if (schedule.type === "cron" && schedule.expression) {
    const tz = schedule.timezone ?? defaultTimezone;
    const cron = new Cron(schedule.expression, { timezone: tz });
    const next = cron.nextRun(new Date(now));
    return next ? next.getTime() : null;
  }

  // A once schedule's one moment. Whether it has already fired is not this
  // function's question: firing disables the task (`retireOnce`), and a
  // disabled task is never due.
  if (schedule.type === "once" && schedule.at) {
    const at = new Date(schedule.at).getTime();
    return Number.isNaN(at) ? null : at;
  }

  if (schedule.type === "interval" && schedule.intervalMs) {
    if (!task.lastRunAt) {
      // First run fires immediately
      return now;
    }
    return new Date(task.lastRunAt).getTime() + schedule.intervalMs;
  }

  return null;
}

/**
 * Store a computed next run on `task`, clearing `nextRunAt` when there is
 * none. A cron schedule can have no next run: a date that never occurs
 * (`0 9 31 2 *`) or a year field that has passed. Keeping the old value there
 * would leave a past `nextRunAt` that never advances, so the task stays
 * due and re-runs back to back.
 */
export function setNextRunAt(task: Task, nextRun: number | null): void {
  task.nextRunAt = nextRun === null ? undefined : new Date(nextRun).toISOString();
}

/**
 * The next run of a stored task, or null when its schedule cannot be
 * placed in time. Create and update refuse a schedule that throws here (an
 * unknown timezone), so a stored one reaches it only by a hand edit or a
 * default timezone that stopped resolving. Null clears `nextRunAt` like a
 * schedule with no next run: keeping a past value would leave it due, so it
 * would re-run on every tick. A later reconcile re-seeds it once the schedule
 * resolves again.
 */
function nextRunOrNone(auto: Task, now: number, defaultTimezone?: string): number | null {
  try {
    return computeNextRunAt(auto, now, defaultTimezone);
  } catch (err) {
    log.warn("[tasks] could not compute next run", {
      taskId: auto.id,
      workspaceId: auto.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Tasks ordered by `nextRunAt`, earliest first, so the oldest due run
 * takes a free slot. One with no `nextRunAt` (an interval's first run, due
 * immediately) sorts first.
 */
function byNextRunAt(tasks: Iterable<Task>): Task[] {
  const at = (a: Task) => (a.nextRunAt ? new Date(a.nextRunAt).getTime() : 0);
  return [...tasks].sort((a, b) => at(a) - at(b));
}

/**
 * Whether `nextRunAt` is a moment the task's cron schedule actually
 * fires at. A cron that never occurs (`0 9 31 2 *`) cannot have produced one,
 * so a stored value there is stale; a real occurrence that has passed is a run
 * still owed.
 */
function isPendingOccurrence(auto: Task, defaultTimezone?: string): boolean {
  const { schedule, nextRunAt } = auto;
  if (schedule?.type !== "cron" || !schedule.expression || !nextRunAt) return false;
  try {
    const tz = schedule.timezone ?? defaultTimezone;
    return new Cron(schedule.expression, { timezone: tz }).match(new Date(nextRunAt));
  } catch {
    return false;
  }
}

/**
 * Whether a task with no `nextRunAt` is due now. Only an interval
 * schedule that has not been given one yet is (its first run fires
 * immediately); a cron schedule without one has no next run, and an event
 * schedule never has one.
 */
function dueWithoutNextRunAt(task: Task): boolean {
  return task.schedule?.type === "interval";
}

/**
 * Check if a task is due to run.
 */
export function isDue(task: Task, now: number): boolean {
  if (!task.enabled) return false;
  // No schedule, no unattended run: only Run now starts one.
  if (!task.schedule) return false;
  // Never due from the timer. An event schedule has no `nextRunAt` by
  // construction, and the timer would otherwise fire it with the wrong
  // trigger, an empty batch, and none of the fire ceiling.
  if (isEventSchedule(task.schedule)) return false;
  if (!task.nextRunAt) return dueWithoutNextRunAt(task);
  return now >= new Date(task.nextRunAt).getTime();
}

/**
 * Compute the next budget reset timestamp for a given period.
 * Uses the target timezone so resets happen at local midnight.
 */
export function computeBudgetResetAt(
  period: "daily" | "monthly" | undefined,
  now: number,
  defaultTimezone?: string,
): string | undefined {
  if (!period) return undefined;
  const tz = defaultTimezone || "UTC";

  if (period === "daily") {
    // Find the current date in the target timezone, then compute start of next day
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dateStr = formatter.format(new Date(now)); // "2026-04-13" format
    const [y, m, d] = dateStr.split("-").map(Number);
    const nextDay = new Date(Date.UTC(y!, m! - 1, d! + 1));
    // Adjust for timezone offset
    const offsetMs = getTimezoneOffsetMs(tz, nextDay);
    return new Date(nextDay.getTime() + offsetMs).toISOString();
  }

  if (period === "monthly") {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
    });
    const dateStr = formatter.format(new Date(now)); // "2026-04"
    const [y, m] = dateStr.split("-").map(Number);
    const nextMonth = m === 12 ? new Date(Date.UTC(y! + 1, 0, 1)) : new Date(Date.UTC(y!, m!, 1));
    const offsetMs = getTimezoneOffsetMs(tz, nextMonth);
    return new Date(nextMonth.getTime() + offsetMs).toISOString();
  }

  return undefined;
}

/** Get the UTC offset in milliseconds for a timezone at a given date. */
function getTimezoneOffsetMs(tz: string, date: Date): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: tz });
  return new Date(utcStr).getTime() - new Date(tzStr).getTime();
}

/**
 * How a thrown run maps to a persisted failure record. One guard-clause row per
 * outcome keeps `status`, the `error` text, and the `transient` flag together
 * so they can't drift apart.
 */
function classifyRunFailure(err: unknown): {
  status: TaskRun["status"];
  error: string;
  transient: boolean;
} {
  if (err instanceof DOMException && err.name === "AbortError") {
    return { status: "cancelled", error: "Cancelled by user", transient: false };
  }
  const errorMsg = err instanceof Error ? err.message : String(err);
  // Owner removed from the task's provenance workspace: the runtime denied
  // the run (`executeTask` throws `WorkspaceMembershipRevokedError`). SKIPPED, not a
  // failure — it must not count toward consecutiveErrors or trip the auto-disable,
  // so the task self-heals the moment the owner is re-added. Matched by the
  // error's stable `code`, which crosses the in-process runtime→app boundary.
  if ((err as { code?: string })?.code === "workspace_membership_revoked") {
    return { status: "skipped", error: errorMsg, transient: false };
  }
  // A tool in the task's `allowedTools` matches nothing the run can reach
  // (`DeclaredToolsUnavailableError`, thrown before the first model call). A
  // FAILURE, never skipped: it feeds consecutiveErrors so a connector that
  // stays gone backs the task off and disables it, saying why. Not transient:
  // a retry minutes later meets the same missing connector.
  if ((err as { code?: string })?.code === "declared_tools_unavailable") {
    return { status: "failure", error: errorMsg, transient: false };
  }
  if (errorMsg.includes("timed out")) {
    return {
      status: "timeout",
      error: errorMsg,
      transient: isTransientError(errorMsg),
    };
  }
  return {
    status: "failure",
    error: errorMsg,
    transient: isTransientError(errorMsg),
  };
}

// ---------------------------------------------------------------------------
// State-update helpers (mutate the passed task in place)
// ---------------------------------------------------------------------------

/** Map a run's terminal status onto the persisted lastRunStatus field. */
function resolveLastRunStatus(status: TaskRun["status"]): NonNullable<Task["lastRunStatus"]> {
  if (status === "success") return "success";
  if (status === "degraded") return "degraded";
  if (status === "timeout") return "timeout";
  if (status === "skipped") return "skipped";
  return "failure";
}

/**
 * Update consecutive-error accounting and auto-disable after too many failures.
 * Skipped and cancelled runs don't affect consecutiveErrors. A degraded run
 * clears the streak like a success: it ran to completion, and backoff exists
 * for runs that could not run, not for work a tool refused.
 */
function applyConsecutiveErrors(auto: Task, run: TaskRun, now: number): void {
  if (run.status === "success" || run.status === "degraded") {
    auto.consecutiveErrors = 0;
    return;
  }
  if (run.status !== "failure" && run.status !== "timeout") return;

  auto.consecutiveErrors = (auto.consecutiveErrors ?? 0) + 1;

  // Auto-disable after too many consecutive failures
  if (auto.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    auto.enabled = false;
    auto.disabledAt = new Date(now).toISOString();
    auto.disabledReason = `Auto-disabled after ${auto.consecutiveErrors} consecutive failures. Last error: ${(run.error ?? "unknown").slice(0, 200)}`;
  }
}

/**
 * Leave a once task inert: disabled, with no next run, and a reason that
 * says what happened. Its schedule stays, so its history still reads, and a new
 * `at` re-arms it (`updateTask`).
 */
export function retireOnce(
  auto: Task,
  outcome: "ran" | "missed",
  settledAt: string,
  reason: string,
  now: number,
): void {
  auto.enabled = false;
  auto.nextRunAt = undefined;
  auto.onceDone = { at: settledAt, outcome };
  auto.disabledAt = new Date(now).toISOString();
  auto.disabledReason = reason;
}

/**
 * Whether an armed once was missed while the runtime was down: its time passed
 * more than {@link ONCE_GRACE_MS} ago. Asked only by `start()`, so a once
 * deferred at runtime because every run slot was busy is never judged late.
 */
export function onceMissedWhileDown(auto: Task, now: number): boolean {
  if (!auto.enabled || auto.onceDone || !isOnceSchedule(auto.schedule)) return false;
  const at = new Date(auto.schedule?.at ?? "").getTime();
  return !Number.isNaN(at) && now - at > ONCE_GRACE_MS;
}

/** Compute and set nextRunAt, pushing it out by backoff during an error streak. */
function applyNextRunAt(auto: Task, now: number, defaultTimezone?: string): void {
  const nextRun = nextRunOrNone(auto, now, defaultTimezone);
  if (nextRun === null) {
    setNextRunAt(auto, null);
    return;
  }

  // In backoff, push nextRunAt forward by the backoff delay but never schedule
  // sooner than the natural interval.
  if (auto.consecutiveErrors > 0) {
    const delay = backoffDelay(auto.consecutiveErrors);
    const naturalDelay = nextRun - now;
    const effectiveDelay = Math.max(delay, naturalDelay);
    auto.nextRunAt = new Date(now + effectiveDelay).toISOString();
  } else {
    auto.nextRunAt = new Date(nextRun).toISOString();
  }
}

/**
 * Where a task with a token budget stands in its window: `current`
 * before its boundary, `elapsed` once the boundary has passed, `unseeded` for
 * a periodic budget with no boundary yet, and `lifetime` for a budget with no
 * period. The next recorded run starts an `elapsed` or `unseeded` window
 * afresh (`rollBudgetWindow`), so until then its counters belong to no window.
 */
function budgetWindow(auto: Task, now: number): "current" | "elapsed" | "unseeded" | "lifetime" {
  const reset = auto.budgetResetAt;
  if (reset) return new Date(reset).getTime() <= now ? "elapsed" : "current";
  return auto.tokenBudget?.period ? "unseeded" : "lifetime";
}

/**
 * Roll the budget-reset window: reset the counters when the period has
 * elapsed, and seed the boundary when a periodic budget has none.
 *
 * Seeding starts a fresh window, the same as a reset: the counters may hold
 * spend from before the boundary existed (a definition written before windows
 * were anchored at write time), and that spend belongs to no window.
 */
function rollBudgetWindow(auto: Task, run: TaskRun, now: number, defaultTimezone?: string): void {
  if (!auto.tokenBudget) return;

  const window = budgetWindow(auto, now);
  if (window === "elapsed" || window === "unseeded") {
    auto.cumulativeInputTokens = run.inputTokens;
    auto.cumulativeOutputTokens = run.outputTokens;
    auto.budgetResetAt = computeBudgetResetAt(auto.tokenBudget.period, now, defaultTimezone);
  }
}

/**
 * Why the task's token budget is spent for the current window, or null
 * when it is not (or there is none).
 *
 * A window whose boundary has passed is not spent, though its counters still
 * hold the old window's total: the next recorded run resets them.
 */
export function tokenBudgetExceeded(auto: Task, now: number): string | null {
  const budget = auto.tokenBudget;
  if (!budget) return null;
  if (auto.budgetResetAt && new Date(auto.budgetResetAt).getTime() <= now) return null;
  const used = { input: auto.cumulativeInputTokens ?? 0, output: auto.cumulativeOutputTokens ?? 0 };
  const which =
    budget.maxInputTokens != null && used.input > budget.maxInputTokens
      ? "input"
      : budget.maxOutputTokens != null && used.output > budget.maxOutputTokens
        ? "output"
        : null;
  if (!which) return null;
  const limit = which === "input" ? budget.maxInputTokens! : budget.maxOutputTokens!;
  return `Token budget exceeded: ${used[which].toLocaleString()} / ${limit.toLocaleString()} ${which} tokens used`;
}

/**
 * A spend account a run names, in the runtime's shape (`TaskRequest.spendAccounts`).
 * Locally typed, like the rest of the executor's request.
 */
export interface RunSpendAccount {
  id: string;
  unit: "usd" | "input_tokens" | "output_tokens";
  remaining: number;
}

/** What every id `budgetSpendAccounts` produces starts with. */
export const BUDGET_ACCOUNT_PREFIX = "task-budget:";

/** What every batch's spend account id starts with (`task-batch:<wsId>/<ownerId>/<batchId>`). */
export const BATCH_ACCOUNT_PREFIX = "task-batch:";

/**
 * The token budget as the spend accounts a run names: one per cap, holding
 * what is left of the current window. The run-start door clamps each model
 * call's output to what they allow and stops the run (stopReason
 * `spend_limit`) when too little is left for another call, so a run cannot
 * spend past the budget.
 *
 * The ids are this app's to choose and mean nothing to the door: the
 * task's key, the window, and the unit. A window whose boundary has
 * passed is a fresh one (the next recorded run resets the counters), so it
 * starts full and gets an id of its own.
 */
export function budgetSpendAccounts(auto: Task, now: number): RunSpendAccount[] {
  const budget = auto.tokenBudget;
  if (!budget) return [];
  const window = budgetWindow(auto, now);
  const label =
    window === "elapsed"
      ? `after:${auto.budgetResetAt}`
      : window === "current"
        ? `until:${auto.budgetResetAt}`
        : window;
  const fresh = window === "elapsed" || window === "unseeded";
  const base = `${BUDGET_ACCOUNT_PREFIX}${auto.workspaceId ?? ""}/${auto.ownerId ?? ""}/${auto.id}@${label}`;
  const left = (cap: number, used: number | undefined) =>
    Math.max(0, cap - (fresh ? 0 : (used ?? 0)));
  const accounts: RunSpendAccount[] = [];
  if (budget.maxInputTokens != null) {
    accounts.push({
      id: `${base}:input_tokens`,
      unit: "input_tokens",
      remaining: left(budget.maxInputTokens, auto.cumulativeInputTokens),
    });
  }
  if (budget.maxOutputTokens != null) {
    accounts.push({
      id: `${base}:output_tokens`,
      unit: "output_tokens",
      remaining: left(budget.maxOutputTokens, auto.cumulativeOutputTokens),
    });
  }
  return accounts;
}

/**
 * Account a run against the token budget: roll the window, and disable an
 * enabled task whose window is spent.
 *
 * Every run counts, whatever triggered it and whether or not the task
 * is enabled. The window is spent when the counters pass a cap, or when the
 * run was stopped by one of the budget's spend accounts: too little was left
 * for its next model call, so the counters stop just short of a cap. A
 * disabled task has nothing left to disable, so its budget is enforced
 * where its runs start: Run now refuses it until the window resets (see
 * `Scheduler.requestRunNow`), and the door clamps and stops any run against
 * what is left.
 */
function applyTokenBudget(auto: Task, run: TaskRun, now: number, defaultTimezone?: string): void {
  if (!auto.tokenBudget) return;

  rollBudgetWindow(auto, run, now, defaultTimezone);

  // A spend stop spends the window only when one of the budget's own accounts
  // made it; any other account the run named is not this budget's to enforce.
  const budgetStop =
    run.stopReason === "spend_limit" &&
    run.spendAccountId?.startsWith(BUDGET_ACCOUNT_PREFIX) === true;
  const exceeded =
    tokenBudgetExceeded(auto, now) ?? (budgetStop ? (run.error ?? "Token budget reached") : null);
  if (!exceeded || !auto.enabled) return;

  auto.enabled = false;
  auto.disabledAt = new Date(now).toISOString();
  auto.disabledReason = exceeded;
}

/**
 * Why Run now refuses `auto` on budget grounds, or null when it may run. Only
 * a disabled task is refused here: an enabled one is disabled by the run
 * that spends its budget, so its next Run now finds it disabled.
 */
function runNowBudgetRefusal(auto: Task, now: number): string | null {
  if (auto.enabled) return null;
  const exceeded = tokenBudgetExceeded(auto, now);
  if (!exceeded) return null;
  const until = auto.budgetResetAt
    ? `until the budget resets at ${auto.budgetResetAt}`
    : "until its token budget is raised (the budget has no reset period)";
  return `${exceeded}. Run now is refused ${until}.`;
}

/**
 * A not-started run record for a queued run whose task is gone, so it
 * cannot be written to that task's history. Returned to the waiter only.
 * It carries no `trigger`, like every record of a run that never started (see
 * {@link countsAsEventFire}).
 */
function notStartedRun(
  key: string,
  reason: string,
  status: "skipped" | "cancelled" = "skipped",
  requested?: RequestedRun,
): QueuedOutcome {
  const now = new Date().toISOString();
  const run: TaskRun = {
    id: requested?.runId ?? `run_${Date.now()}_${status === "cancelled" ? "cancel" : "skip"}`,
    taskId: key.slice(key.lastIndexOf("/") + 1),
    startedAt: now,
    completedAt: now,
    status,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    iterations: 0,
    error: reason,
  };
  return { run: requested ? withRequest(run, requested) : run, started: false };
}

/** A fresh run id, in the runtime's shape (`run_<12 hex>`). */
export function newRunId(): string {
  return `run_${randomBytes(6).toString("hex")}`;
}

/** A requested run's record, carrying its id and what it was asked with. */
function withRequest(run: TaskRun, requested: RequestedRun): TaskRun {
  return {
    ...run,
    id: requested.runId,
    ...(requested.input !== undefined ? { input: requested.input } : {}),
    ...(requested.idempotencyKey !== undefined ? { idempotencyKey: requested.idempotencyKey } : {}),
    ...(requested.retryOf !== undefined ? { retryOf: requested.retryOf } : {}),
    ...(requested.batch
      ? { batchId: requested.batch.batchId, batchIndex: requested.batch.index }
      : {}),
  };
}

/** A requested run's per-run input: the caller's JSON and a retry's guidance. */
function requestedInput(requested: RequestedRun | undefined): RunInput | undefined {
  if (!requested) return undefined;
  const input: RunInput = {
    ...(requested.guidance ? { preamble: requested.guidance } : {}),
    ...(requested.input !== undefined ? { data: requested.input } : {}),
  };
  return Object.keys(input).length > 0 ? input : undefined;
}

/** Whether a dispatch's promise settles once the run is recorded or once its assessment is too. */
type DispatchSettles = "recorded" | "assessed";

/** Whether a run record is still open: asked for, and not yet ended or refused. */
export function isOpenRun(run: Pick<TaskRun, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

/**
 * Whether a run record counts as one fire toward an event task's hourly
 * ceiling (`maxFiresPerHour`): an event-triggered run that actually started.
 *
 * A run that never started carries no `trigger` — `recordSkipped` does not
 * stamp one — so a refused fire (already running or queued, the queue full,
 * disabled or cancelled while queued) is not counted. A `skipped` record with
 * the trigger is a dispatched run the runtime refused at the door (the owner's
 * membership re-check), which did no work either. A run that started and was
 * then cancelled still counts: it ran, and its work may have produced events.
 */
export function countsAsEventFire(run: TaskRun): boolean {
  return run.trigger === "event" && run.status !== "skipped";
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  /**
   * Loaded tasks across every workspace + owner, keyed by
   * `${wsId}/${ownerId}/${id}` — see `keyOf`. Composite-keyed (not bare id)
   * because task ids are kebab-case and collide across workspaces/owners.
   * `activeRuns` uses the same key.
   */
  private definitions: Map<string, Task> = new Map();
  /** In-flight runs' abort controllers, for cancel and stop. Slots are admission's. */
  private readonly activeRuns: Map<string, AbortController> = new Map();
  /** When each in-flight run started and what started it, by the same key, for `queueView`. */
  private readonly activeInfo: Map<
    string,
    { startedAt: string; trigger: TaskRunTrigger; runId: string }
  > = new Map();
  /**
   * Requested runs this process is carrying, by run id: queued or in flight,
   * with the task key and the promise of the run's record. A ticket that
   * says a run is open while this map has no entry for it was left by a
   * process that stopped before the run ended (see `settleLostRun`).
   */
  private readonly openRuns: Map<string, { key: string; ended: Promise<TaskRun> }> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * Assessments in flight by run id, so a caller can wait for them and a run
   * whose record has landed reads as not yet ended until its verdict has.
   */
  private readonly pendingAssessments = new Map<string, Promise<TaskRun>>();

  private readonly executor: Executor;
  private config: SchedulerConfig;
  /**
   * Slots and the queue Run now and event runs wait in. In memory only:
   * `stop()` records each of this scheduler's queued runs as skipped, and a
   * process that dies without stopping loses them with no record. Scheduled
   * runs never queue (see `considerForDispatch`).
   */
  private readonly admission: RunAdmission;

  constructor(executor: Executor, config: SchedulerConfig) {
    this.executor = executor;
    this.config = config;
    this.admission = config.admission ?? createRunAdmission();
  }

  /** Composite key for the cross-workspace/owner definitions/activeRuns maps. */
  private static keyOf(task: Pick<Task, "id" | "ownerId" | "workspaceId">): string {
    return `${task.workspaceId ?? ""}/${task.ownerId ?? ""}/${task.id}`;
  }

  /** The run admission request for the task at `key`. */
  private static admissionOf(key: string): { workspaceId: string; key: string } {
    return { workspaceId: key.slice(0, key.indexOf("/")), key: ADMISSION_KEY_PREFIX + key };
  }

  /** Whether an admission key is one of this scheduler's. */
  private static isOwnKey(admissionKey: string | undefined): boolean {
    return admissionKey?.startsWith(ADMISSION_KEY_PREFIX) ?? false;
  }

  /**
   * Load every workspace + owner's tasks into one composite-keyed map via
   * `store.loadAllTasks` (which scans every workspace + owner dir and
   * backfills `workspaceId`/`ownerId` from the path — the directory is the
   * binding).
   */
  private loadAll(): Map<string, Task> {
    const all = new Map<string, Task>();
    for (const auto of loadAllTasks(this.config.workDir)) {
      all.set(Scheduler.keyOf(auto), auto);
    }
    return all;
  }

  /**
   * Persist one task to its own `<id>.json` under its provenance
   * workspace + owner. No-op if the task lacks a workspace or owner
   * (defensive — every loaded task carries both via the path backfill).
   */
  private persistTask(auto: Task): void {
    if (!auto.workspaceId || !auto.ownerId) return;
    saveTask(this.config.workDir, auto.workspaceId, auto.ownerId, auto);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start the scheduler. Loads definitions from the store and arms the timer.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.definitions = this.loadAll();
    this.retireOncesMissedWhileDown();
    this.seedNextRunAt();
    this.armTimer();
  }

  /**
   * At start, retire every armed once whose time passed more than the grace
   * window ago: the runtime was not running when it was due. Only here, never
   * on a tick or a reload, so a once the running scheduler deferred for want
   * of a run slot fires whenever a slot frees, however late. A once within the
   * window stays due and fires on the first tick.
   */
  private retireOncesMissedWhileDown(): void {
    const now = Date.now();
    for (const auto of [...this.definitions.values()]) {
      if (!onceMissedWhileDown(auto, now)) continue;
      try {
        this.recordMissedOnce(auto, now);
      } catch (err) {
        log.warn("[tasks] could not record a missed once", {
          taskId: auto.id,
          workspaceId: auto.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Compute initial `nextRunAt` for any enabled task missing one, clear
   * it on any whose schedule has no next run, and persist the tasks that
   * changed. Shared by start + reload, so a stored task whose `nextRunAt`
   * outlived its schedule is corrected before the timer reads it.
   */
  private seedNextRunAt(): void {
    const now = Date.now();
    const dirty: Task[] = [];
    for (const auto of this.definitions.values()) {
      if (this.reconcileNextRunAt(auto, now)) dirty.push(auto);
    }
    for (const auto of dirty) this.persistTask(auto);
  }

  /**
   * Seed a missing `nextRunAt`, or clear one whose schedule has no next run.
   * One on a schedule that still has a next run is left alone, and so is an
   * occurrence of the schedule that has not run yet: a run deferred at the
   * concurrency limit holds its past `nextRunAt` until a slot frees, and for a
   * cron whose last date has passed that is the only run it has left. Returns
   * whether it changed.
   */
  private reconcileNextRunAt(auto: Task, now: number): boolean {
    if (isEventSchedule(auto.schedule)) return false;
    if (!auto.enabled || !auto.ownerId || !auto.workspaceId) return false;
    const next = nextRunOrNone(auto, now, this.config.defaultTimezone);
    if (next === null && isPendingOccurrence(auto, this.config.defaultTimezone)) return false;
    const changed = next === null ? Boolean(auto.nextRunAt) : !auto.nextRunAt;
    if (changed) setNextRunAt(auto, next);
    return changed;
  }

  /**
   * Stop the scheduler. Clears the timer and aborts all active runs.
   */
  stop(): void {
    this.running = false;
    this.clearTimer();

    // The queue lives in memory, so a queued run cannot outlive the process.
    // Each of this scheduler's is recorded as skipped while the store is still
    // reachable (see `leftQueue`), so the run history says it was asked for
    // and never ran.
    this.admission.withdraw((entry) => Scheduler.isOwnKey(entry.key), "stopped");

    // Abort all active runs
    for (const [id, controller] of this.activeRuns) {
      controller.abort();
      this.activeRuns.delete(id);
      this.activeInfo.delete(id);
    }
  }

  /**
   * Re-scan every workspace + owner's store and re-arm the timer. Called after
   * a tool mutates a task (create/update/delete) so the timer reflects
   * the change. Multi-workspace: always re-reads every workspace + owner store.
   *
   * This is a full-tenant filesystem rescan on every mutation. Acceptable under
   * the one-process-per-tenant model (a tenant's task count is small); if
   * a tenant ever accrues enough tasks for the rescan to matter, switch to
   * a per-(wsId,ownerId) incremental reload keyed off the mutation.
   */
  reload(): void {
    this.definitions = this.loadAll();
    this.seedNextRunAt();
    this.clearTimer();
    if (this.running) {
      this.armTimer();
    }
  }

  /**
   * Forget every task belonging to `wsId`, and re-arm.
   *
   * The in-memory `definitions` map is the only thing that decides what the
   * timer fires, and nothing reloads it on a workspace delete —
   * `reload()` is called from the tasks tool surface alone, so a deleted
   * workspace's tasks stayed armed here until the process restarted.
   * When one fired it wrote back through the store, and the store's mkdir
   * re-created the workspace directory that had just been archived.
   *
   * `ensureWorkspaceDir` is what makes that write fail rather than resurrect
   * the tree; this is what stops the run from being attempted at all, so the
   * correct behaviour does not rest on a write failing.
   *
   * A targeted drop, not `reload()`: a reload rescans every workspace and
   * owner on disk to learn one thing this call already knows.
   *
   * Returns how many were dropped. In-flight runs keep their `activeRuns`
   * entry so `stop()` can still abort them.
   */
  dropWorkspace(wsId: string): number {
    let dropped = 0;
    for (const [key, auto] of this.definitions) {
      if (auto.workspaceId !== wsId) continue;
      this.definitions.delete(key);
      dropped++;
    }
    // A queued run for the workspace has nowhere left to run or to be
    // recorded, so its waiter gets an unpersisted skipped record.
    const prefix = `${ADMISSION_KEY_PREFIX}${wsId}/`;
    this.admission.withdraw((entry) => entry.key?.startsWith(prefix) ?? false, WORKSPACE_DELETED);
    if (dropped === 0) return 0;
    this.clearTimer();
    if (this.running) this.armTimer();
    return dropped;
  }

  /**
   * Trigger an immediate run of a specific task, bypassing schedule
   * and backoff checks, and answer at once with what became of it (see
   * {@link RunNowTicket}). Null when the task is not loaded.
   *
   * Runs a disabled task. `enabled` decides whether the task fires
   * unattended — from its schedule or from events — and Run now is a person's
   * deliberate act, which is how a disabled task is tested before it is
   * enabled (the create form's test run creates it disabled and runs it).
   * `handleRun` tells the caller the task is disabled.
   *
   * Run now shares the runtime's run slots with every other unattended run.
   * At the limit it waits in the run queue rather than starting over the limit
   * or being dropped. It is refused, with a skipped record, when the
   * task already has a run in flight or queued, when the queue is full,
   * when the task is disabled and its token budget is spent for the
   * window, and when the scheduler is stopped (nothing would drain the queue).
   */
  requestRunNow(
    wsId: string,
    ownerId: string,
    taskId: string,
    requested?: RequestedRun,
  ): RunNowTicket | null {
    const key = Scheduler.keyOf({ id: taskId, ownerId, workspaceId: wsId });
    const auto = this.definitions.get(key);
    if (!auto) {
      const keys = Array.from(this.definitions.keys());
      process.stderr.write(
        `[tasks] runNow: "${key}" not found in ${keys.length} definitions: [${keys.join(", ")}]\n`,
      );
      return null;
    }

    // A requested run's record exists before anything can answer for it: its
    // ticket says queued from here, and every outcome below rewrites it.
    if (requested) this.openTicket(auto, requested);

    const refuse = (reason: string): RunNowTicket => ({
      state: "refused",
      run: this.recordSkipped(auto, reason, "manual", "skipped", requested),
    });

    if (!this.running) return refuse(STOPPED_REASON);
    const duplicate = this.duplicateOf(key);
    if (duplicate) return refuse(`${duplicate} (runNow)`);
    const budget = runNowBudgetRefusal(auto, Date.now());
    if (budget) return refuse(budget);

    const input = requestedInput(requested);
    const admitted = this.admit(key, "manual", input, requested);
    // Only an admitted run claims its idempotency key: a refused attempt
    // leaves the key free, so the same call retried later runs.
    if (requested && admitted.state !== "refused") this.recordKey(auto, requested);
    if (admitted.state === "started") {
      const run = this.dispatchRun(auto, "manual", input, admitted.lease, requested);
      return { state: "started", run: this.trackOpen(key, requested, run) };
    }
    if (admitted.state === "refused") return refuse(this.refusalReason(admitted.reason, "runNow"));
    return {
      state: "queued",
      position: admitted.position,
      run: this.trackOpen(
        key,
        requested,
        admitted.outcome.then((outcome) => outcome.run),
      ),
    };
  }

  /**
   * Ask for one batch item's run (`requested.batch` names it). Unlike Run now,
   * a task may have many of these at once: each holds its slot and its queue
   * place under its own key (the task's key plus the run id), so batch runs are
   * never duplicates of each other or of the task's own run. The door's
   * admission and fair share apply to each exactly as to any run.
   *
   * Nothing is written for a refused request (the batch keeps the item
   * pending); an admitted one gets its ticket, settles once assessed, and is
   * cancelled by run id (`cancelRunById`). A batch run's poor result sets off
   * no `onPoorResult` (see `afterAssessed`).
   */
  requestBatchRun(
    wsId: string,
    ownerId: string,
    taskId: string,
    requested: RequestedRun,
    options: BatchRunOptions,
  ): BatchRunTicket {
    const key = Scheduler.keyOf({ id: taskId, ownerId, workspaceId: wsId });
    const auto = this.definitions.get(key);
    if (!auto) {
      return { state: "refused", reason: "not_found", message: "the task is no longer here" };
    }
    if (!this.running) return { state: "refused", reason: "stopped", message: STOPPED_REASON };
    const budget = runNowBudgetRefusal(auto, Date.now());
    if (budget) return { state: "refused", reason: "budget", message: budget };

    const batchRun = { runKey: `${key}#${requested.runId}`, options };
    const input = requestedInput(requested);
    const admitted = this.admit(key, "manual", input, requested, batchRun);
    if (admitted.state === "refused") {
      return admitted.reason === "stopped"
        ? { state: "refused", reason: "stopped", message: STOPPED_REASON }
        : {
            state: "refused",
            reason: "queue_full",
            message: this.refusalReason(admitted.reason, "runNow"),
          };
    }
    // Before the dispatch below, which rewrites it `running` synchronously.
    this.openTicket(auto, requested);
    if (admitted.state === "started") {
      const run = this.dispatchRun(
        auto,
        "manual",
        input,
        admitted.lease,
        requested,
        "assessed",
        batchRun,
      );
      return { state: "started", run: this.trackOpen(batchRun.runKey, requested, run) };
    }
    return {
      state: "queued",
      run: this.trackOpen(
        batchRun.runKey,
        requested,
        admitted.outcome.then((outcome) => outcome.run),
      ),
    };
  }

  /** Record that a requested run admitted (started or queued) claims its idempotency key. */
  private recordKey(auto: Task, requested: RequestedRun): void {
    const { workspaceId: wsId, ownerId } = auto;
    if (!wsId || !ownerId || requested.idempotencyKey === undefined) return;
    saveIdempotencyKey(
      this.config.workDir,
      wsId,
      ownerId,
      auto.id,
      requested.idempotencyKey,
      requested.runId,
    );
  }

  /** Write a requested run's first ticket (queued). */
  private openTicket(auto: Task, requested: RequestedRun): void {
    const { workspaceId: wsId, ownerId } = auto;
    if (!wsId || !ownerId) return;
    this.writeTicket(wsId, ownerId, auto.id, requested, {
      id: requested.runId,
      taskId: auto.id,
      startedAt: requested.requestedAt,
      status: "queued",
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      iterations: 0,
    });
  }

  /** Rewrite a requested run's ticket with its current record. */
  private writeTicket(
    wsId: string,
    ownerId: string,
    taskId: string,
    requested: RequestedRun,
    run: TaskRun,
  ): void {
    const ticket: RunTicket = {
      runId: requested.runId,
      taskId,
      requestedAt: requested.requestedAt,
      run: withRequest(run, requested),
    };
    saveRunTicket(this.config.workDir, wsId, ownerId, ticket);
  }

  /** Remember a requested run as open until its record is written; returns `ended`. */
  private trackOpen(
    key: string,
    requested: RequestedRun | undefined,
    ended: Promise<TaskRun>,
  ): Promise<TaskRun> {
    if (!requested) return ended;
    const { runId } = requested;
    this.openRuns.set(runId, { key, ended });
    const forget = () => {
      if (this.openRuns.get(runId)?.ended === ended) this.openRuns.delete(runId);
    };
    ended.then(forget, forget);
    return ended;
  }

  /** Whether this process is carrying the requested run (queued or in flight). */
  isRunOpen(runId: string): boolean {
    return this.openRuns.has(runId);
  }

  /** The record of a requested run this process is carrying, once it ends; undefined when it carries none. */
  runEnded(runId: string): Promise<TaskRun> | undefined {
    return this.openRuns.get(runId)?.ended;
  }

  /**
   * Cancel a run by its id, when this process is carrying it for that owner
   * in that workspace: abort it in flight (a requested run, or a scheduled or
   * event run by the id minted at dispatch), or take a requested run out of
   * the queue. False when it carries no such run.
   */
  cancelRunById(wsId: string, ownerId: string, runId: string): boolean {
    const prefix = `${wsId}/${ownerId}/`;
    const open = this.openRuns.get(runId);
    if (open) return open.key.startsWith(prefix) && this.cancelKey(open.key);
    for (const [key, info] of this.activeInfo) {
      if (info.runId === runId && key.startsWith(prefix)) return this.cancelKey(key);
    }
    return false;
  }

  /**
   * Settle a requested run whose ticket says it is open while no process is
   * carrying it: the runtime stopped (or died) before it ended. A queued run
   * never started and is recorded skipped; one that was running is recorded as
   * a failure. Writes the run index and the ticket, and returns the new ticket.
   */
  settleLostRun(wsId: string, ownerId: string, ticket: RunTicket): RunTicket {
    if (!isOpenRun(ticket.run) || this.openRuns.has(ticket.runId)) return ticket;
    const wasRunning = ticket.run.status === "running";
    const now = new Date().toISOString();
    const run: TaskRun = {
      ...ticket.run,
      completedAt: now,
      status: wasRunning ? "failure" : "skipped",
      error: wasRunning
        ? "The runtime stopped while this run was in flight, so it did not finish."
        : "The runtime stopped before this queued run started.",
    };
    appendRun(this.config.workDir, wsId, ownerId, ticket.taskId, run);
    taskRunsTotal.inc({ status: run.status });
    const settled: RunTicket = { ...ticket, run };
    saveRunTicket(this.config.workDir, wsId, ownerId, settled);
    this.config.onRunRecorded?.(ownerId);
    return settled;
  }

  /**
   * Run now, awaited: the run's record once it ends (a queued run's once it
   * has waited for its slot and run), the skipped record when it is refused,
   * or null when the task is not loaded.
   */
  async runNow(wsId: string, ownerId: string, taskId: string): Promise<TaskRun | null> {
    const ticket = this.requestRunNow(wsId, ownerId, taskId);
    if (!ticket) return null;
    return ticket.run;
  }

  /**
   * Run one task from a batch of notifications, bypassing schedule and
   * backoff the way {@link runNow} does, and carrying the batch as this run's
   * input.
   *
   * Separate from `runNow` for two reasons that are not cosmetic: the run must
   * carry `trigger: "event"` so its record says what woke it and the fire
   * ceiling can count it, and the caller needs to be told the run did not start
   * — a per-task collision is a ledger row, not a silent no-op.
   *
   * At the global limit the batch waits in the same queue Run now uses and the
   * returned promise settles when its run ends: the limit is transient
   * capacity, not a verdict on the event. A queued run that leaves the queue
   * without starting (dropped, cancelled, disabled while it waited) answers
   * `skipped` like a run refused up front, so the caller never reports a run
   * that did not happen as delivered.
   */
  async runFromEvent(
    wsId: string,
    ownerId: string,
    taskId: string,
    input: RunInput,
  ): Promise<{ run: TaskRun } | { skipped: string }> {
    const key = Scheduler.keyOf({ id: taskId, ownerId, workspaceId: wsId });
    const auto = this.definitions.get(key);
    if (!auto) return { skipped: "the task is no longer in this workspace" };
    // Unattended, so `enabled` gates it; `runNow` is the attended trigger that does not.
    if (!auto.enabled) return { skipped: "the task is disabled" };
    if (!this.running) return { skipped: STOPPED_REASON };
    const duplicate = this.duplicateOf(key);
    if (duplicate) {
      this.recordSkipped(auto, `${duplicate} (event)`, "event");
      return { skipped: EVENT_DUPLICATE_ANSWER[duplicate] };
    }
    const admitted = this.admit(key, "event", input);
    if (admitted.state === "started") {
      return {
        run: await this.dispatchRun(auto, "event", input, admitted.lease, undefined, "recorded"),
      };
    }
    if (admitted.state === "refused") {
      this.recordSkipped(auto, this.refusalReason(admitted.reason, "event"), "event");
      return { skipped: this.eventRefusalAnswer(admitted.reason) };
    }
    const outcome = await admitted.outcome;
    if (!outcome.started) return { skipped: outcome.run.error ?? "the queued run did not start" };
    return { run: outcome.run };
  }

  /** Whether the task at `key` already has a run holding a slot or waiting for one. */
  private duplicateOf(key: string): "Already running" | "Already queued" | null {
    const { key: admissionKey } = Scheduler.admissionOf(key);
    if (this.activeRuns.has(key) || this.admission.isRunning(admissionKey))
      return "Already running";
    if (this.admission.isQueued(admissionKey)) return "Already queued";
    return null;
  }

  /**
   * Ask admission for a slot for a Run now or event run, waiting in the queue
   * when none is free. A queued run's outcome settles when it leaves the queue:
   * started (and ended) once it takes a slot, or not started (see `leftQueue`).
   */
  private admit(
    key: string,
    trigger: QueuedRun["trigger"],
    input?: RunInput,
    requested?: RequestedRun,
    batchRun?: { runKey: string; options: BatchRunOptions },
  ):
    | { state: "started"; lease: AdmissionLease }
    | { state: "queued"; position: number; outcome: Promise<QueuedOutcome> }
    | { state: "refused"; reason: AdmissionRefusal } {
    let entry!: QueuedRun;
    const outcome = new Promise<QueuedOutcome>((resolve, reject) => {
      entry = {
        key,
        ...(batchRun ? { runKey: batchRun.runKey, batch: batchRun.options } : {}),
        trigger,
        ...(input ? { input } : {}),
        ...(requested ? { requested } : {}),
        resolve,
        reject,
      };
    });
    const ticket = this.admission.request(Scheduler.admissionOf(batchRun?.runKey ?? key), {
      admitted: (lease) => this.startQueued(entry, lease),
      withdrawn: (reason) => this.leftQueue(entry, reason),
    });
    if (ticket.state === "admitted") return { state: "started", lease: ticket.lease };
    if (ticket.state === "refused") return ticket;
    return { state: "queued", position: ticket.position, outcome };
  }

  /** The skipped record's reason for a run admission refused. */
  private refusalReason(reason: AdmissionRefusal, label: "runNow" | "event"): string {
    if (reason === "running") return `Already running (${label})`;
    if (reason === "queued") return `Already queued (${label})`;
    if (reason === "stopped") return STOPPED_REASON;
    const { maxConcurrentRuns, maxQueuedRuns } = this.admission.limits;
    return (
      `Run queue full: ${maxConcurrentRuns} runs in flight (the concurrent-run limit) ` +
      `and ${maxQueuedRuns} waiting (the queue limit)`
    );
  }

  /** What `runFromEvent` answers for a run admission refused. */
  private eventRefusalAnswer(reason: AdmissionRefusal): string {
    if (reason === "running") return EVENT_DUPLICATE_ANSWER["Already running"];
    if (reason === "queued") return EVENT_DUPLICATE_ANSWER["Already queued"];
    if (reason === "stopped") return "the runtime is shutting down";
    return `the runtime was at its concurrent-run limit and its run queue was full (${this.admission.limits.maxQueuedRuns})`;
  }

  /**
   * Start a queued run that admission has just given a slot, re-checking what
   * may have changed while it waited: the task deleted, an event
   * task disabled, a Run now whose budget another run spent. A run
   * refused here gives its slot straight back.
   */
  private startQueued(entry: QueuedRun, lease: AdmissionLease): void {
    const auto = this.definitions.get(entry.key);
    if (!auto) {
      lease.release();
      try {
        entry.resolve(this.notStartedForKey(entry, "the task was deleted while queued"));
      } catch (err) {
        entry.reject(err);
      }
      return;
    }
    const refuse = (reason: string) =>
      entry.resolve({
        run: this.recordSkipped(auto, reason, entry.trigger, "skipped", entry.requested),
        started: false,
      });
    try {
      if (entry.trigger === "event" && !auto.enabled) {
        lease.release();
        refuse("Disabled while queued (event)");
        return;
      }
      // A batch run is held to the budget by the door's spend accounts; its
      // batch pauses when one stops it.
      const budget =
        entry.trigger === "manual" && !entry.batch ? runNowBudgetRefusal(auto, Date.now()) : null;
      if (budget) {
        lease.release();
        refuse(budget);
        return;
      }
    } catch (err) {
      lease.release();
      entry.reject(err);
      return;
    }
    // A Run now waits for its assessment, so its caller gets the judged record;
    // an event run settles its batch once the run is recorded.
    const settles: DispatchSettles = entry.trigger === "manual" ? "assessed" : "recorded";
    const batchRun =
      entry.runKey && entry.batch ? { runKey: entry.runKey, options: entry.batch } : undefined;
    this.dispatchRun(
      auto,
      entry.trigger,
      entry.input,
      lease,
      entry.requested,
      settles,
      batchRun,
    ).then((run) => entry.resolve({ run, started: true }), entry.reject);
  }

  /**
   * A queued run left the queue without a slot: cancelled, the scheduler
   * stopped, or its workspace deleted. Recorded where its task can still
   * hold the record; a deleted workspace's runs are answered without writing.
   */
  private leftQueue(entry: QueuedRun, reason: AdmissionWithdrawal): void {
    const auto = reason === WORKSPACE_DELETED ? undefined : this.definitions.get(entry.key);
    const cancelled = reason === "cancelled";
    const text = cancelled
      ? "Cancelled by user while queued"
      : reason === WORKSPACE_DELETED
        ? "the workspace was deleted"
        : reason === BATCH_PAUSED
          ? "Withdrawn from the queue: its batch paused before a run slot freed"
          : "Queued run dropped: the runtime stopped before a run slot freed";
    const status = cancelled ? "cancelled" : "skipped";
    try {
      entry.resolve(
        auto
          ? {
              run: this.recordSkipped(auto, text, entry.trigger, status, entry.requested),
              started: false,
            }
          : reason === WORKSPACE_DELETED
            ? notStartedRun(entry.key, text, status, entry.requested)
            : this.notStartedForKey(entry, text, status),
      );
    } catch (err) {
      entry.reject(err);
    }
  }

  /**
   * The not-started record of a queued run whose task is gone. Not
   * written to the run index (there is no task to hold it), but a
   * requested run's ticket is rewritten so its handle reads the outcome.
   */
  private notStartedForKey(
    entry: QueuedRun,
    reason: string,
    status: "skipped" | "cancelled" = "skipped",
  ): QueuedOutcome {
    const outcome = notStartedRun(entry.key, reason, status, entry.requested);
    if (entry.requested) {
      const [wsId, ownerId] = entry.key.split("/");
      if (wsId && ownerId) {
        this.writeTicket(wsId, ownerId, outcome.run.taskId, entry.requested, outcome.run);
      }
    }
    return outcome;
  }

  /**
   * Get the current definitions (for inspection/testing).
   */
  getDefinitions(): Map<string, Task> {
    return this.definitions;
  }

  /**
   * Get active run IDs (for inspection/testing).
   */
  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  /**
   * Cancel a task's run: abort it when in flight, or take it out of the
   * queue (recording it as cancelled) when waiting. Returns false when it has
   * neither.
   */
  cancelRun(wsId: string, ownerId: string, taskId: string): boolean {
    return this.cancelKey(Scheduler.keyOf({ id: taskId, ownerId, workspaceId: wsId }));
  }

  /**
   * Take a requested run out of the queue when this process carries it for that
   * owner in that workspace and it has not started: recorded skipped (its
   * batch paused), with no `trigger`. False when it is not queued.
   */
  withdrawQueuedRun(wsId: string, ownerId: string, runId: string): boolean {
    const open = this.openRuns.get(runId);
    if (!open?.key.startsWith(`${wsId}/${ownerId}/`)) return false;
    return this.admission.cancel(Scheduler.admissionOf(open.key).key, BATCH_PAUSED);
  }

  /** Abort the run held under `key` (a task's, or a batch run's own), or take it out of the queue. */
  private cancelKey(key: string): boolean {
    const controller = this.activeRuns.get(key);
    if (controller) {
      controller.abort();
      return true;
    }
    // Recorded as cancelled by `leftQueue`, before this returns.
    return this.admission.cancel(Scheduler.admissionOf(key).key);
  }

  /** This scheduler's runs waiting for a slot, in arrival order (for inspection/testing). */
  getQueuedRunIds(): string[] {
    return this.admission
      .queued()
      .filter((entry) => Scheduler.isOwnKey(entry.key))
      .map((entry) => entry.key!.slice(ADMISSION_KEY_PREFIX.length));
  }

  /**
   * One owner's runs in one workspace that hold a slot or wait for one, read
   * from this scheduler's own admission keys (the door knows nothing of tasks).
   * A key is `<ws>/<owner>/<taskId>`, or `<ws>/<owner>/<taskId>#<runId>` for a
   * batch run. `position` numbers the queued runs as `tasks__run` does: the
   * place among this scheduler's queued runs, 1 next.
   */
  queueView(wsId: string, ownerId: string): QueueViewEntry[] {
    const prefix = `${wsId}/${ownerId}/`;
    const parse = (key: string): { taskId: string; runId?: string } => {
      const rest = key.slice(prefix.length);
      const hash = rest.indexOf("#");
      return hash >= 0
        ? { taskId: rest.slice(0, hash), runId: rest.slice(hash + 1) }
        : { taskId: rest };
    };
    const runIdByKey = new Map<string, string>();
    for (const [runId, open] of this.openRuns) runIdByKey.set(open.key, runId);
    const out: QueueViewEntry[] = [];
    for (const [key, info] of this.activeInfo) {
      if (!key.startsWith(prefix)) continue;
      const { taskId } = parse(key);
      out.push({
        taskId,
        state: "running",
        startedAt: info.startedAt,
        trigger: info.trigger,
        runId: info.runId,
      });
    }
    this.getQueuedRunIds().forEach((key, index) => {
      if (!key.startsWith(prefix)) return;
      const { taskId, runId } = parse(key);
      const id = runId ?? runIdByKey.get(key);
      out.push({ taskId, state: "queued", position: index + 1, ...(id ? { runId: id } : {}) });
    });
    return out;
  }

  /**
   * Check if the scheduler is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  /**
   * Arm the timer to fire at the next due task or after MAX_TIMER_MS.
   */
  armTimer(): void {
    if (!this.running) return;
    this.clearTimer();

    // With no free run slot a due task is deferred, not skipped, so it
    // stays due: arming for it would tick at zero delay and defer it again, in a
    // loop. Wake on the heartbeat instead. A tick whose own runs free the slots
    // re-arms when they settle; the heartbeat covers slots held by Run now and
    // event runs, and by other sources' runs, which no tick waits on.
    if (!this.admission.hasFreeSlot()) {
      this.timer = runDetached(() => setTimeout(() => this.onTimer(), MAX_TIMER_MS));
      return;
    }

    const now = Date.now();
    let minDelay = MAX_TIMER_MS;

    for (const auto of this.definitions.values()) {
      if (!auto.enabled) continue;
      // Never arms a timer: an event schedule's absent `nextRunAt` is not a
      // pending first run, and reading it as one would spin the timer at zero
      // delay for as long as such a task exists.
      if (isEventSchedule(auto.schedule)) continue;
      if (!auto.nextRunAt) {
        if (!dueWithoutNextRunAt(auto)) continue;
        // Due immediately
        minDelay = 0;
        break;
      }
      const nextMs = new Date(auto.nextRunAt).getTime();
      const delay = Math.max(0, nextMs - now);
      if (delay < minDelay) {
        minDelay = delay;
      }
    }

    // Detached: `reload()` arms from inside the tool call that mutated a
    // task, and each fire re-arms from the previous one, so a timer that
    // kept its creator's context would run every later tick as that request.
    this.timer = runDetached(() => setTimeout(() => this.onTimer(), minDelay));
  }

  /**
   * Timer callback. Iterates enabled definitions, checks due + backoff +
   * concurrency, and dispatches runs. Awaits all dispatched runs before
   * re-arming to ensure nextRunAt is updated before the next tick.
   */
  async onTimer(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    const dispatched: Promise<TaskRun>[] = [];

    for (const auto of byNextRunAt(this.definitions.values())) {
      // One task cannot take the timer down with it. `armTimer()` below
      // is the only thing that re-arms, and the promise this runs inside is
      // discarded by the `setTimeout` that scheduled it — so a throw reaching
      // here would stop the scheduler for EVERY workspace, silently and until
      // the process restarts. `recordSkipped` writes to the store before it
      // reads, so a store that refuses a write (a workspace archived under a
      // run) is one way to throw. That refusal is permanent — the workspace is
      // gone — and it lands before `nextRunAt` advances, so the task is
      // dropped as `dropWorkspace` would have; kept, it stays due and the timer
      // re-arms at zero delay.
      try {
        const run = this.considerForDispatch(auto, now);
        if (run) dispatched.push(run);
      } catch (err) {
        if (err instanceof WorkspaceRootMissingError) {
          this.definitions.delete(Scheduler.keyOf(auto));
        }
        log.warn("[tasks] scheduler sweep skipped one task", {
          taskId: auto.id,
          workspaceId: auto.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Wait for all dispatched runs to complete so updateAfterRun sets
    // nextRunAt before we re-arm. Without this, the timer re-arms with
    // stale nextRunAt values and fires the same task repeatedly.
    if (dispatched.length > 0) {
      await Promise.allSettled(dispatched);
    }

    // Re-arm the timer
    this.armTimer();
  }

  /**
   * Whether `auto` runs on this tick, and the dispatched run when it does.
   *
   * Lifted out of {@link onTimer} so that method stays a loop plus the
   * per-task try/catch that keeps one failure from stopping the sweep;
   * the predicate chain itself is unchanged.
   */
  private considerForDispatch(auto: Task, now: number): Promise<TaskRun> | null {
    if (!auto.enabled) return null;
    if (!isDue(auto, now)) return null;
    if (isInBackoff(auto, now)) return null;

    // Per-task concurrency guard
    const key = Scheduler.keyOf(auto);
    if (this.duplicateOf(key) === "Already running") {
      this.recordSkipped(auto, "Previous run still active");
      return null;
    }

    // The runtime's run slots are shared by every unattended run. A due run
    // with no free slot is deferred: no run is recorded and `nextRunAt` stays
    // where it is, so it fires on the first tick with a free slot. The limit is
    // capacity, not a verdict on the run; skipping would advance a one-shot
    // cron past its only date and lose the run. `onTimer` walks due runs oldest
    // first, so deferral is FIFO.
    //
    // A deferred scheduled run does not join the run queue (admission is asked
    // without a waiter): its persisted `nextRunAt` already holds its place,
    // survives a restart (the in-memory queue does not, and a one-shot cron
    // would lose its only run), and admits one pending occurrence per
    // task by construction. Queued runs take a freed slot first, since
    // admission hands it to them as it frees and the timer ticks later; a free
    // slot with runs waiting is not offered here.
    const ticket = this.admission.request(Scheduler.admissionOf(key));
    if (ticket.state !== "admitted") return null;

    // The timer waits for its runs to be recorded, not judged.
    return this.dispatchRun(auto, "scheduled", undefined, ticket.lease, undefined, "recorded");
  }

  // -----------------------------------------------------------------------
  // Run dispatch
  // -----------------------------------------------------------------------

  /**
   * Run `auto` in the slot `lease` holds, free it when the run is recorded,
   * then assess the run. Settles with the recorded run (`recorded`) or with
   * the run once its assessment is recorded too (`assessed`, the default);
   * either way the assessment goes on, and it never changes the record's
   * execution.
   */
  private async dispatchRun(
    auto: Task,
    trigger: TaskRunTrigger,
    input: RunInput | undefined,
    lease: AdmissionLease,
    requested?: RequestedRun,
    settles: DispatchSettles = "assessed",
    batchRun?: { runKey: string; options: BatchRunOptions },
  ): Promise<TaskRun> {
    const key = batchRun?.runKey ?? Scheduler.keyOf(auto);
    const controller = new AbortController();
    this.activeRuns.set(key, controller);
    // Capture real dispatch time so synthesized failure records carry an
    // honest elapsed window. Without this, a 5-minute hang and a
    // 100-millisecond setup crash both render as startedAt == completedAt
    // to the millisecond — operators can't tell the failure modes apart
    // from the run record alone.
    const startedAt = new Date().toISOString();
    // Every run has its id from dispatch, so one in flight is found (and
    // cancelled) by it whatever started it; a requested run brings its own.
    const runId = requested?.runId ?? newRunId();
    this.activeInfo.set(key, { startedAt, trigger, runId });
    // The once occurrence this run is, if any: an `at` edited while it runs is
    // a new occurrence, which the run must not retire.
    const firedOnceAt =
      trigger === "scheduled" && isOnceSchedule(auto.schedule) ? auto.schedule?.at : undefined;

    let recorded: { run: TaskRun; result: TaskRunResult | null };
    try {
      recorded = await this.executeAndRecord(auto, controller, {
        runId,
        startedAt,
        trigger,
        input,
        lease,
        firedOnceAt,
        requested,
        batch: batchRun?.options,
      });
    } finally {
      // The slot is free whether the run's record landed or its write threw.
      // Releasing it admits the next queued run. `executeTask` releases it as
      // the run ends; this covers an executor that never reached it.
      this.activeRuns.delete(key);
      this.activeInfo.delete(key);
      lease.release();
    }
    // After the slot is free and the task is no longer running, so a retry
    // the assessment asks for is an ordinary run.
    const assessed = this.assessRecorded(auto, recorded.run, recorded.result);
    return settles === "recorded" ? recorded.run : assessed;
  }

  /**
   * Assess a recorded run that left a deliverable, record the assessment on
   * its record, and act on a poor result. Resolves with the run as it now
   * stands; never rejects, and resolves with the run unchanged when there is
   * nothing to assess or assessing fails.
   */
  private assessRecorded(auto: Task, run: TaskRun, result: TaskRunResult | null): Promise<TaskRun> {
    const assess = this.config.assess;
    if (!assess || !isAssessable(run) || !auto.workspaceId || !auto.ownerId) {
      return Promise.resolve(run);
    }
    const pending = (async () => {
      const assessment = await assess(auto, run, result);
      const updated = this.recordAssessment(auto, run.id, assessment) ?? { ...run, assessment };
      this.afterAssessed(auto, updated);
      return updated;
    })().catch((err) => {
      log.warn("[tasks] could not record a run's assessment", {
        taskId: auto.id,
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return run;
    });
    this.pendingAssessments.set(run.id, pending);
    pending.finally(() => this.pendingAssessments.delete(run.id));
    return pending;
  }

  /**
   * Write an assessment onto a run's record (index line and ticket), keeping a
   * person's verdict already there, and announce the change. Null when the run
   * has no record.
   */
  recordAssessment(task: Task, runId: string, assessment: RunAssessment): TaskRun | null {
    const { workspaceId: wsId, ownerId } = task;
    if (!wsId || !ownerId) return null;
    const updated = updateRun(this.config.workDir, wsId, ownerId, task.id, runId, (r) => ({
      ...r,
      assessment: { ...assessment, ...(r.assessment?.human ? { human: r.assessment.human } : {}) },
    }));
    if (updated) this.config.onRunRecorded?.(ownerId);
    return updated;
  }

  /**
   * Act on a `fail` assessment by the task's `onPoorResult`:
   *
   *   record      nothing more
   *   notify      the owner's notification (the default)
   *   retry_once  run the task again with the failed criteria as guidance,
   *               once per original run: a retry that fails too, or a retry
   *               that could not be started, notifies instead
   *
   * `uncertain` sets off nothing: judge doubt alone is a review, not a poor
   * result.
   */
  private afterAssessed(auto: Task, run: TaskRun): void {
    const assessment = run.assessment;
    if (assessment?.verdict !== "fail") return;
    // A batch item answers to its batch: the stop rule and `rerun_failed`
    // stand in for a notice and a retry per item (see `batch.ts`).
    if (run.batchId) return;
    const policy = auto.onPoorResult ?? DEFAULT_ON_POOR_RESULT;
    if (policy === "record") return;
    if (policy === "retry_once" && !run.retryOf && this.retry(auto, run, assessment)) return;
    this.config.notifyPoorResult?.(auto, run);
  }

  /** Ask for the one retry of a poor run; whether it was admitted (started or queued). */
  private retry(auto: Task, run: TaskRun, assessment: RunAssessment): boolean {
    const { workspaceId: wsId, ownerId } = auto;
    if (!wsId || !ownerId) return false;
    const requested: RequestedRun = {
      runId: newRunId(),
      requestedAt: new Date().toISOString(),
      ...(run.input !== undefined ? { input: run.input } : {}),
      retryOf: run.id,
      guidance: retryGuidance(auto, run.id, assessment),
    };
    const ticket = this.requestRunNow(wsId, ownerId, auto.id, requested);
    if (!ticket || ticket.state === "refused") return false;
    ticket.run.catch(() => {});
    return true;
  }

  /** Resolves once every assessment in flight has been recorded. */
  async assessmentsSettled(): Promise<void> {
    while (this.pendingAssessments.size > 0) {
      await Promise.allSettled([...this.pendingAssessments.values()]);
    }
  }

  /** Whether a recorded run is still being assessed, so its verdict is not yet on its record. */
  isAssessing(runId: string): boolean {
    return this.pendingAssessments.has(runId);
  }

  /** Run the executor and record the outcome; the slot is released by the caller. */
  private async executeAndRecord(
    auto: Task,
    controller: AbortController,
    dispatch: {
      runId: string;
      startedAt: string;
      trigger: TaskRunTrigger;
      input: RunInput | undefined;
      lease: AdmissionLease;
      firedOnceAt: string | undefined;
      requested: RequestedRun | undefined;
      batch?: BatchRunOptions;
    },
  ): Promise<{ run: TaskRun; result: TaskRunResult | null }> {
    const { runId, startedAt, trigger, input, lease, firedOnceAt, requested, batch } = dispatch;
    const ticket = (run: TaskRun) => {
      if (requested && auto.workspaceId && auto.ownerId) {
        this.writeTicket(auto.workspaceId, auto.ownerId, auto.id, requested, run);
      }
    };
    ticket({
      id: requested?.runId ?? "",
      taskId: auto.id,
      startedAt,
      status: "running",
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      iterations: 0,
      trigger,
    });
    try {
      batch?.onStarted?.();
      const executed = await this.executor(
        auto,
        controller.signal,
        trigger,
        input,
        lease,
        runId,
        batch?.accounts(),
      );
      const run = requested ? withRequest(executed.run, requested) : executed.run;
      const result =
        requested && executed.result ? { ...executed.result, runId: run.id } : executed.result;
      this.updateAfterRun(auto, run, trigger, firedOnceAt);
      // Persist the full deliverable sidecar alongside the run summary. Present
      // for both the scheduled and manual (runNow) paths; null only when the
      // executor had no clean data (it rejected instead — see the catch below).
      if (result) this.persistRunResult(auto, result);
      ticket(run);
      this.runRecorded(auto);
      return { run, result };
    } catch (err) {
      const { status, error, transient } = classifyRunFailure(err);
      const failed: TaskRun = {
        id: runId,
        taskId: auto.id,
        startedAt,
        completedAt: new Date().toISOString(),
        status,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        iterations: 0,
        error,
        transient,
        trigger,
      };
      const failedRun = requested ? withRequest(failed, requested) : failed;
      this.updateAfterRun(auto, failedRun, trigger, firedOnceAt);
      ticket(failedRun);
      this.runRecorded(auto);
      return { run: failedRun, result: null };
    }
  }

  /** Report a written run record to `onRunRecorded`, after every file for it has landed. */
  private runRecorded(auto: Task): void {
    if (!auto.workspaceId || !auto.ownerId) return;
    this.config.onRunRecorded?.(auto.ownerId);
  }

  // -----------------------------------------------------------------------
  // State management
  // -----------------------------------------------------------------------

  /**
   * Update task state after a run completes.
   *
   * Re-reads definitions from disk before merging run-state fields to avoid
   * overwriting concurrent changes (e.g., a user pausing via the UI while
   * a run is in flight).
   *
   * `firedOnceAt` is the `at` of the once occurrence this run was (captured at
   * dispatch; defaults to the dispatched task's). The once is retired
   * only while the stored schedule still names that `at`: one edited during
   * the run is a new occurrence and stays armed.
   */
  updateAfterRun(
    task: Task,
    run: TaskRun,
    trigger?: TaskRunTrigger,
    firedOnceAt: string | undefined = task.schedule?.at,
  ): void {
    const wsId = task.workspaceId;
    const ownerId = task.ownerId;
    if (!wsId || !ownerId) return; // defensive — every fired task carries both

    // Re-read THIS task's own file to pick up concurrent changes (pause,
    // config edits) without clobbering them. Per-task files mean a
    // concurrent edit to a sibling task can never be lost here.
    const auto = loadTask(this.config.workDir, wsId, ownerId, task.id);
    if (!auto) return;
    // Stamp the authoritative workspace + owner (the path IS the binding) — same
    // backfill `loadAll` does on read, so `keyOf(auto)` below matches the
    // composite key the timer loaded under and heals any record missing them.
    auto.workspaceId = wsId;
    auto.ownerId = ownerId;

    const now = Date.now();

    auto.lastRunAt = run.completedAt ?? run.startedAt;
    auto.lastRunStatus = resolveLastRunStatus(run.status);
    auto.runCount = (auto.runCount ?? 0) + 1;

    // Track cumulative tokens
    auto.cumulativeInputTokens = (auto.cumulativeInputTokens ?? 0) + run.inputTokens;
    auto.cumulativeOutputTokens = (auto.cumulativeOutputTokens ?? 0) + run.outputTokens;

    // A batch item answers to its batch: its failures are the batch's to count
    // (the stop rule, `rerun_failed`), never the task's own streak, which
    // would back off and then disable the task's schedule.
    if (!run.batchId) applyConsecutiveErrors(auto, run, now);
    if (!isOnceSchedule(auto.schedule)) {
      applyNextRunAt(auto, now, this.config.defaultTimezone);
    } else if ((trigger ?? run.trigger) === "scheduled" && auto.schedule?.at === firedOnceAt) {
      // The schedule's one occurrence ran, whatever its outcome (success,
      // failure, timeout, cancel): cleanup is the schedule's, not the prompt's.
      // A Run now or event run is not that occurrence and leaves it armed, and
      // so does an `at` changed during the run: the stored `nextRunAt` is the
      // new occurrence's.
      retireOnce(auto, "ran", run.startedAt, `${ONCE_RAN_REASON}${run.startedAt}`, now);
    }
    auto.updatedAt = new Date(now).toISOString();
    applyTokenBudget(auto, run, now, this.config.defaultTimezone);

    // Persist the run summary + the updated definition, then sync the single
    // in-memory entry so the timer sees the new nextRunAt without re-scanning.
    appendRun(this.config.workDir, wsId, ownerId, task.id, run);
    taskRunsTotal.inc({ status: run.status });
    saveTask(this.config.workDir, wsId, ownerId, auto);
    this.definitions.set(Scheduler.keyOf(auto), auto);
  }

  /**
   * Persist a run's full result sidecar under the task's provenance
   * workspace + owner. No-op when either is missing (defensive).
   */
  private persistRunResult(auto: Task, result: TaskRunResult): void {
    if (!auto.workspaceId || !auto.ownerId) return;
    saveRunResult(this.config.workDir, auto.workspaceId, auto.ownerId, auto.id, result);
  }

  /**
   * Record a run that did not start: skipped, or cancelled while queued.
   *
   * `trigger` is what asked for the run, and it is NOT written to the record:
   * `trigger` on a run record means the run started, which is what the event
   * fire ceiling counts (see {@link countsAsEventFire}). The reason names the
   * trigger where it matters. It decides one thing here: only a scheduled
   * occurrence (`trigger` absent or `scheduled`) advances `nextRunAt`, so the
   * timer does not find it due again. A refused Run now or event run is not an
   * occurrence of the schedule and leaves it alone.
   */
  private recordSkipped(
    auto: Task,
    reason: string,
    trigger?: TaskRunTrigger,
    status: "skipped" | "cancelled" = "skipped",
    requested?: RequestedRun,
  ): TaskRun {
    const now = Date.now();
    const run = this.writeNotStarted(auto, reason, status, now, requested);
    const wsId = auto.workspaceId;
    const ownerId = auto.ownerId;
    if (!wsId || !ownerId) return run; // defensive — can't locate the store

    if (trigger !== undefined && trigger !== "scheduled") {
      this.runRecorded(auto);
      return run;
    }

    // Advance nextRunAt so this task isn't immediately "due" again.
    // Re-read THIS task's file to avoid overwriting concurrent changes.
    const fresh = loadTask(this.config.workDir, wsId, ownerId, auto.id);
    if (fresh) {
      // Stamp the authoritative workspace + owner (see updateAfterRun) so the
      // composite key stays consistent with what `loadAll` keyed under.
      fresh.workspaceId = wsId;
      fresh.ownerId = ownerId;
      const nextRun = nextRunOrNone(fresh, now, this.config.defaultTimezone);
      if (nextRun !== null) {
        // Ensure nextRunAt is in the future — if the computed time is past
        // (e.g., interval based on old lastRunAt), advance by intervalMs from now
        const effectiveNext =
          nextRun > now ? nextRun : now + (fresh.schedule?.intervalMs ?? 60_000);
        setNextRunAt(fresh, effectiveNext);
      } else {
        setNextRunAt(fresh, null);
      }
      fresh.updatedAt = new Date(now).toISOString();
      saveTask(this.config.workDir, wsId, ownerId, fresh);
      this.definitions.set(Scheduler.keyOf(fresh), fresh);
    }

    this.runRecorded(auto);
    return run;
  }

  /**
   * Write the record of a run that did not start (no `trigger`, see
   * {@link countsAsEventFire}) to the task's history, and count it.
   * Returns the record; writes nothing when the task's store cannot be
   * located.
   */
  private writeNotStarted(
    auto: Task,
    reason: string,
    status: "skipped" | "cancelled",
    now: number,
    requested?: RequestedRun,
  ): TaskRun {
    const at = new Date(now).toISOString();
    const notStarted: TaskRun = {
      id: `run_${now}_${status === "cancelled" ? "cancel" : "skip"}`,
      taskId: auto.id,
      startedAt: at,
      completedAt: at,
      status,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      iterations: 0,
      error: reason,
    };
    const run = requested ? withRequest(notStarted, requested) : notStarted;
    if (!auto.workspaceId || !auto.ownerId) return run;
    appendRun(this.config.workDir, auto.workspaceId, auto.ownerId, auto.id, run);
    taskRunsTotal.inc({ status: run.status });
    if (requested) this.writeTicket(auto.workspaceId, auto.ownerId, auto.id, requested, run);
    return run;
  }

  /**
   * Record a once schedule's occurrence as skipped because it is too late to
   * fire (see {@link onceMissedWhileDown}), and leave the task inert.
   */
  private recordMissedOnce(auto: Task, now: number): void {
    const at = auto.schedule?.at ?? "";
    const reason =
      `${ONCE_MISSED_REASON}${at}: the runtime was not running then, and it started more ` +
      `than ${ONCE_GRACE_MS / 60_000} minutes later, so it did not run. Set a new time to run it.`;
    const wsId = auto.workspaceId;
    const ownerId = auto.ownerId;
    if (!wsId || !ownerId) return;
    this.writeNotStarted(auto, reason, "skipped", now);
    const fresh = loadTask(this.config.workDir, wsId, ownerId, auto.id) ?? auto;
    fresh.workspaceId = wsId;
    fresh.ownerId = ownerId;
    retireOnce(fresh, "missed", new Date(now).toISOString(), reason, now);
    fresh.updatedAt = new Date(now).toISOString();
    saveTask(this.config.workDir, wsId, ownerId, fresh);
    this.definitions.set(Scheduler.keyOf(fresh), fresh);
    this.runRecorded(auto);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
