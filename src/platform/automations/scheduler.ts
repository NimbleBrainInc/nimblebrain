/**
 * Scheduling engine for automations.
 *
 * Uses setTimeout-based timer armed to the next-due job (max 60s wake).
 * Evaluates cron expressions via Croner. Handles interval scheduling,
 * per-automation concurrency guards, and exponential backoff. How many runs
 * execute at once, and the queue beyond that, belong to the runtime's run
 * admission (`src/runtime/admission.ts`); the scheduler asks it for a slot and
 * renders its answers as run records.
 *
 * The scheduler does NOT execute runs directly — it delegates to an
 * executor function injected at construction time.
 */

import { Cron } from "croner";
import { automationRunsTotal } from "../../api/metrics.ts";
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
import {
  appendRun,
  loadAllAutomations,
  loadAutomation,
  saveAutomation,
  saveRunResult,
} from "./store.ts";
import {
  type Automation,
  type AutomationRun,
  type AutomationRunResult,
  isEventSchedule,
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
 * Prefix on the admission key of every automation run. Admission keys are
 * opaque to the runtime and shared by every source, so the scheduler's own
 * are namespaced: `stop()` and `dropWorkspace` withdraw only these.
 */
const ADMISSION_KEY_PREFIX = "automation:";

/** The withdrawal reason `dropWorkspace` gives the runs it takes out of the queue. */
const WORKSPACE_DELETED = "workspace_deleted";

/** What `runFromEvent` answers when the automation already has a run. */
const EVENT_DUPLICATE_ANSWER = {
  "Already running": "a previous run of this automation is still in flight",
  "Already queued": "a previous run of this automation is still queued",
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
 * automation's owner, in its workspace (see `resolveExecutorContext`).
 */
export type AutomationRunTrigger = "scheduled" | "manual" | "event";

/**
 * Per-run input, for a trigger that carries something the stored prompt does
 * not. An `event` run carries the batch of notifications that fired it; a
 * `scheduled` or `manual` run carries nothing and passes none.
 *
 * It is prepended to the prompt rather than merged into it, and it is never
 * persisted on the automation: inbox content is one run's input, not part of
 * the definition and not part of any cached prefix.
 */
export interface RunInput {
  /** Goes ahead of the automation's own prompt, separated by a blank line. */
  preamble: string;
}

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
  automation: Automation,
  signal: AbortSignal,
  trigger: AutomationRunTrigger,
  input?: RunInput,
  lease?: AdmissionLease,
) => Promise<{ run: AutomationRun; result: AutomationRunResult | null }>;

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
  | { state: "started"; run: Promise<AutomationRun> }
  | { state: "queued"; position: number; run: Promise<AutomationRun> }
  | { state: "refused"; run: AutomationRun };

/**
 * How a queued run left the queue: `started` when it took a slot and ran
 * (`run` is its record), not started when it was dropped, cancelled, or
 * refused on the way out (`run` is the not-started record saying why).
 */
interface QueuedOutcome {
  run: AutomationRun;
  started: boolean;
}

/** One run waiting for a slot. */
interface QueuedRun {
  key: string;
  trigger: "manual" | "event";
  input?: RunInput;
  resolve: (outcome: QueuedOutcome) => void;
  reject: (err: unknown) => void;
}

export interface SchedulerConfig {
  /**
   * The runtime work directory (`{workDir}`). The scheduler is multi-workspace:
   * it scans `{workDir}/workspaces/<wsId>/automations/<ownerId>/` across every
   * workspace and owner and fires each automation as its owner, focused on its
   * provenance workspace. Automations are workspace-owned (the path is the wall).
   */
  workDir: string;
  /**
   * The run admission every run is admitted through: the runtime's
   * (`Runtime.getRunAdmission`), so automation runs share its slots and queue
   * with every other unattended run. Default: a pool of its own with the
   * default limits, for a scheduler run without a runtime (tests).
   */
  admission?: RunAdmission;
  /** Default timezone for cron expressions. Default: system timezone. */
  defaultTimezone?: string;
  /**
   * Called once a run's record is written — completed, failed, cancelled or
   * skipped — with the automation's owner. The owner is known here and nowhere
   * upstream of a scheduled run, so this is where the automations source
   * announces the change to that owner's views.
   */
  onRunRecorded?: (ownerId: string) => void;
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
 * `ladder` defaults to an automation's own, which runs out to an hour because
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
 * Returns true if the automation is currently in backoff (should be skipped).
 */
export function isInBackoff(automation: Automation, now: number): boolean {
  if (automation.consecutiveErrors <= 0) return false;
  if (!automation.nextRunAt) return false;
  return now < new Date(automation.nextRunAt).getTime();
}

/**
 * Compute the next run time for an automation based on its schedule.
 */
export function computeNextRunAt(
  automation: Automation,
  now: number,
  defaultTimezone?: string,
): number | null {
  const { schedule } = automation;

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

  if (schedule.type === "interval" && schedule.intervalMs) {
    if (!automation.lastRunAt) {
      // First run fires immediately
      return now;
    }
    return new Date(automation.lastRunAt).getTime() + schedule.intervalMs;
  }

  return null;
}

/**
 * Store a computed next run on `automation`, clearing `nextRunAt` when there is
 * none. A cron schedule can have no next run: a date that never occurs
 * (`0 9 31 2 *`) or a year field that has passed. Keeping the old value there
 * would leave a past `nextRunAt` that never advances, so the automation stays
 * due and re-runs back to back.
 */
export function setNextRunAt(automation: Automation, nextRun: number | null): void {
  automation.nextRunAt = nextRun === null ? undefined : new Date(nextRun).toISOString();
}

/**
 * The next run of a stored automation, or null when its schedule cannot be
 * placed in time. Create and update refuse a schedule that throws here (an
 * unknown timezone), so a stored one reaches it only by a hand edit or a
 * default timezone that stopped resolving. Null clears `nextRunAt` like a
 * schedule with no next run: keeping a past value would leave it due, so it
 * would re-run on every tick. A later reconcile re-seeds it once the schedule
 * resolves again.
 */
function nextRunOrNone(auto: Automation, now: number, defaultTimezone?: string): number | null {
  try {
    return computeNextRunAt(auto, now, defaultTimezone);
  } catch (err) {
    log.warn("[automations] could not compute next run", {
      automationId: auto.id,
      workspaceId: auto.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Automations ordered by `nextRunAt`, earliest first, so the oldest due run
 * takes a free slot. One with no `nextRunAt` (an interval's first run, due
 * immediately) sorts first.
 */
function byNextRunAt(automations: Iterable<Automation>): Automation[] {
  const at = (a: Automation) => (a.nextRunAt ? new Date(a.nextRunAt).getTime() : 0);
  return [...automations].sort((a, b) => at(a) - at(b));
}

/**
 * Whether `nextRunAt` is a moment the automation's cron schedule actually
 * fires at. A cron that never occurs (`0 9 31 2 *`) cannot have produced one,
 * so a stored value there is stale; a real occurrence that has passed is a run
 * still owed.
 */
function isPendingOccurrence(auto: Automation, defaultTimezone?: string): boolean {
  const { schedule, nextRunAt } = auto;
  if (schedule.type !== "cron" || !schedule.expression || !nextRunAt) return false;
  try {
    const tz = schedule.timezone ?? defaultTimezone;
    return new Cron(schedule.expression, { timezone: tz }).match(new Date(nextRunAt));
  } catch {
    return false;
  }
}

/**
 * Whether an automation with no `nextRunAt` is due now. Only an interval
 * schedule that has not been given one yet is (its first run fires
 * immediately); a cron schedule without one has no next run, and an event
 * schedule never has one.
 */
function dueWithoutNextRunAt(automation: Automation): boolean {
  return automation.schedule.type === "interval";
}

/**
 * Check if an automation is due to run.
 */
export function isDue(automation: Automation, now: number): boolean {
  if (!automation.enabled) return false;
  // Never due from the timer. An event schedule has no `nextRunAt` by
  // construction, and the timer would otherwise fire it with the wrong
  // trigger, an empty batch, and none of the fire ceiling.
  if (isEventSchedule(automation.schedule)) return false;
  if (!automation.nextRunAt) return dueWithoutNextRunAt(automation);
  return now >= new Date(automation.nextRunAt).getTime();
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
 * outcome keeps `status`, the id `suffix`, the `error` text, and the `transient`
 * flag together so they can't drift apart.
 */
function classifyRunFailure(err: unknown): {
  status: AutomationRun["status"];
  suffix: string;
  error: string;
  transient: boolean;
} {
  if (err instanceof DOMException && err.name === "AbortError") {
    return { status: "cancelled", suffix: "cancel", error: "Cancelled by user", transient: false };
  }
  const errorMsg = err instanceof Error ? err.message : String(err);
  // Owner removed from the automation's provenance workspace: the runtime denied
  // the run (`executeTask` throws `WorkspaceMembershipRevokedError`). SKIPPED, not a
  // failure — it must not count toward consecutiveErrors or trip the auto-disable,
  // so the automation self-heals the moment the owner is re-added. Matched by the
  // error's stable `code`, which crosses the in-process runtime→app boundary.
  if ((err as { code?: string })?.code === "workspace_membership_revoked") {
    return { status: "skipped", suffix: "skip", error: errorMsg, transient: false };
  }
  if (errorMsg.includes("timed out")) {
    return {
      status: "timeout",
      suffix: "timeout",
      error: errorMsg,
      transient: isTransientError(errorMsg),
    };
  }
  return {
    status: "failure",
    suffix: "err",
    error: errorMsg,
    transient: isTransientError(errorMsg),
  };
}

// ---------------------------------------------------------------------------
// State-update helpers (mutate the passed automation in place)
// ---------------------------------------------------------------------------

/** Map a run's terminal status onto the persisted lastRunStatus field. */
function resolveLastRunStatus(
  status: AutomationRun["status"],
): NonNullable<Automation["lastRunStatus"]> {
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
function applyConsecutiveErrors(auto: Automation, run: AutomationRun, now: number): void {
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

/** Compute and set nextRunAt, pushing it out by backoff during an error streak. */
function applyNextRunAt(auto: Automation, now: number, defaultTimezone?: string): void {
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
 * Roll the budget-reset window: reset the counters when the period has
 * elapsed, and seed the boundary when a periodic budget has none.
 *
 * Seeding starts a fresh window, the same as a reset: the counters may hold
 * spend from before the boundary existed (a definition written before windows
 * were anchored at write time), and that spend belongs to no window.
 */
function rollBudgetWindow(
  auto: Automation,
  run: AutomationRun,
  now: number,
  defaultTimezone?: string,
): void {
  if (!auto.tokenBudget) return;

  const elapsed = auto.budgetResetAt && new Date(auto.budgetResetAt).getTime() <= now;
  const unseeded = !auto.budgetResetAt && auto.tokenBudget.period;
  if (elapsed || unseeded) {
    auto.cumulativeInputTokens = run.inputTokens;
    auto.cumulativeOutputTokens = run.outputTokens;
    auto.budgetResetAt = computeBudgetResetAt(auto.tokenBudget.period, now, defaultTimezone);
  }
}

/**
 * Why the automation's token budget is spent for the current window, or null
 * when it is not (or there is none).
 *
 * A window whose boundary has passed is not spent, though its counters still
 * hold the old window's total: the next recorded run resets them.
 */
export function tokenBudgetExceeded(auto: Automation, now: number): string | null {
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
 * Account a run against the token budget: roll the window, and disable an
 * enabled automation whose window is spent.
 *
 * Every run counts, whatever triggered it and whether or not the automation
 * is enabled. A disabled automation has nothing left to disable, so its budget
 * is enforced where its runs start: Run now refuses it until the window
 * resets (see `Scheduler.requestRunNow`).
 */
function applyTokenBudget(
  auto: Automation,
  run: AutomationRun,
  now: number,
  defaultTimezone?: string,
): void {
  if (!auto.tokenBudget) return;

  rollBudgetWindow(auto, run, now, defaultTimezone);

  const exceeded = tokenBudgetExceeded(auto, now);
  if (!exceeded || !auto.enabled) return;

  auto.enabled = false;
  auto.disabledAt = new Date(now).toISOString();
  auto.disabledReason = exceeded;
}

/**
 * Why Run now refuses `auto` on budget grounds, or null when it may run. Only
 * a disabled automation is refused here: an enabled one is disabled by the run
 * that spends its budget, so its next Run now finds it disabled.
 */
function runNowBudgetRefusal(auto: Automation, now: number): string | null {
  if (auto.enabled) return null;
  const exceeded = tokenBudgetExceeded(auto, now);
  if (!exceeded) return null;
  const until = auto.budgetResetAt
    ? `until the budget resets at ${auto.budgetResetAt}`
    : "until its token budget is raised (the budget has no reset period)";
  return `${exceeded}. Run now is refused ${until}.`;
}

/**
 * A not-started run record for a queued run whose automation is gone, so it
 * cannot be written to that automation's history. Returned to the waiter only.
 * It carries no `trigger`, like every record of a run that never started (see
 * {@link countsAsEventFire}).
 */
function notStartedRun(
  key: string,
  reason: string,
  status: "skipped" | "cancelled" = "skipped",
): QueuedOutcome {
  const now = new Date().toISOString();
  const run: AutomationRun = {
    id: `run_${Date.now()}_${status === "cancelled" ? "cancel" : "skip"}`,
    automationId: key.slice(key.lastIndexOf("/") + 1),
    startedAt: now,
    completedAt: now,
    status,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    iterations: 0,
    error: reason,
  };
  return { run, started: false };
}

/**
 * Whether a run record counts as one fire toward an event automation's hourly
 * ceiling (`maxFiresPerHour`): an event-triggered run that actually started.
 *
 * A run that never started carries no `trigger` — `recordSkipped` does not
 * stamp one — so a refused fire (already running or queued, the queue full,
 * disabled or cancelled while queued) is not counted. A `skipped` record with
 * the trigger is a dispatched run the runtime refused at the door (the owner's
 * membership re-check), which did no work either. A run that started and was
 * then cancelled still counts: it ran, and its work may have produced events.
 */
export function countsAsEventFire(run: AutomationRun): boolean {
  return run.trigger === "event" && run.status !== "skipped";
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  /**
   * Loaded automations across every workspace + owner, keyed by
   * `${wsId}/${ownerId}/${id}` — see `keyOf`. Composite-keyed (not bare id)
   * because automation ids are kebab-case and collide across workspaces/owners.
   * `activeRuns` uses the same key.
   */
  private definitions: Map<string, Automation> = new Map();
  /** In-flight runs' abort controllers, for cancel and stop. Slots are admission's. */
  private readonly activeRuns: Map<string, AbortController> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

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
  private static keyOf(automation: Pick<Automation, "id" | "ownerId" | "workspaceId">): string {
    return `${automation.workspaceId ?? ""}/${automation.ownerId ?? ""}/${automation.id}`;
  }

  /** The run admission request for the automation at `key`. */
  private static admissionOf(key: string): { workspaceId: string; key: string } {
    return { workspaceId: key.slice(0, key.indexOf("/")), key: ADMISSION_KEY_PREFIX + key };
  }

  /** Whether an admission key is one of this scheduler's. */
  private static isOwnKey(admissionKey: string | undefined): boolean {
    return admissionKey?.startsWith(ADMISSION_KEY_PREFIX) ?? false;
  }

  /**
   * Load every workspace + owner's automations into one composite-keyed map via
   * `store.loadAllAutomations` (which scans every workspace + owner dir and
   * backfills `workspaceId`/`ownerId` from the path — the directory is the
   * binding).
   */
  private loadAll(): Map<string, Automation> {
    const all = new Map<string, Automation>();
    for (const auto of loadAllAutomations(this.config.workDir)) {
      all.set(Scheduler.keyOf(auto), auto);
    }
    return all;
  }

  /**
   * Persist one automation to its own `<id>.json` under its provenance
   * workspace + owner. No-op if the automation lacks a workspace or owner
   * (defensive — every loaded automation carries both via the path backfill).
   */
  private persistAutomation(auto: Automation): void {
    if (!auto.workspaceId || !auto.ownerId) return;
    saveAutomation(this.config.workDir, auto.workspaceId, auto.ownerId, auto);
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
    this.seedNextRunAt();
    this.armTimer();
  }

  /**
   * Compute initial `nextRunAt` for any enabled automation missing one, clear
   * it on any whose schedule has no next run, and persist the automations that
   * changed. Shared by start + reload, so a stored automation whose `nextRunAt`
   * outlived its schedule is corrected before the timer reads it.
   */
  private seedNextRunAt(): void {
    const now = Date.now();
    const dirty: Automation[] = [];
    for (const auto of this.definitions.values()) {
      if (this.reconcileNextRunAt(auto, now)) dirty.push(auto);
    }
    for (const auto of dirty) this.persistAutomation(auto);
  }

  /**
   * Seed a missing `nextRunAt`, or clear one whose schedule has no next run.
   * One on a schedule that still has a next run is left alone, and so is an
   * occurrence of the schedule that has not run yet: a run deferred at the
   * concurrency limit holds its past `nextRunAt` until a slot frees, and for a
   * cron whose last date has passed that is the only run it has left. Returns
   * whether it changed.
   */
  private reconcileNextRunAt(auto: Automation, now: number): boolean {
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
    }
  }

  /**
   * Re-scan every workspace + owner's store and re-arm the timer. Called after
   * a tool mutates an automation (create/update/delete) so the timer reflects
   * the change. Multi-workspace: always re-reads every workspace + owner store.
   *
   * This is a full-tenant filesystem rescan on every mutation. Acceptable under
   * the one-process-per-tenant model (a tenant's automation count is small); if
   * a tenant ever accrues enough automations for the rescan to matter, switch to
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
   * Forget every automation belonging to `wsId`, and re-arm.
   *
   * The in-memory `definitions` map is the only thing that decides what the
   * timer fires, and nothing reloads it on a workspace delete —
   * `reload()` is called from the automations tool surface alone, so a deleted
   * workspace's automations stayed armed here until the process restarted.
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
   * Trigger an immediate run of a specific automation, bypassing schedule
   * and backoff checks, and answer at once with what became of it (see
   * {@link RunNowTicket}). Null when the automation is not loaded.
   *
   * Runs a disabled automation. `enabled` decides whether the automation fires
   * unattended — from its schedule or from events — and Run now is a person's
   * deliberate act, which is how a disabled automation is tested before it is
   * enabled (the create form's test run creates it disabled and runs it).
   * `handleRun` tells the caller the automation is disabled.
   *
   * Run now shares the runtime's run slots with every other unattended run.
   * At the limit it waits in the run queue rather than starting over the limit
   * or being dropped. It is refused, with a skipped record, when the
   * automation already has a run in flight or queued, when the queue is full,
   * when the automation is disabled and its token budget is spent for the
   * window, and when the scheduler is stopped (nothing would drain the queue).
   */
  requestRunNow(wsId: string, ownerId: string, automationId: string): RunNowTicket | null {
    const key = Scheduler.keyOf({ id: automationId, ownerId, workspaceId: wsId });
    const auto = this.definitions.get(key);
    if (!auto) {
      const keys = Array.from(this.definitions.keys());
      process.stderr.write(
        `[automations] runNow: "${key}" not found in ${keys.length} definitions: [${keys.join(", ")}]\n`,
      );
      return null;
    }

    const refuse = (reason: string): RunNowTicket => ({
      state: "refused",
      run: this.recordSkipped(auto, reason, "manual"),
    });

    if (!this.running) return refuse(STOPPED_REASON);
    const duplicate = this.duplicateOf(key);
    if (duplicate) return refuse(`${duplicate} (runNow)`);
    const budget = runNowBudgetRefusal(auto, Date.now());
    if (budget) return refuse(budget);

    const admitted = this.admit(key, "manual");
    if (admitted.state === "started") {
      return { state: "started", run: this.dispatchRun(auto, "manual", undefined, admitted.lease) };
    }
    if (admitted.state === "refused") return refuse(this.refusalReason(admitted.reason, "runNow"));
    return {
      state: "queued",
      position: admitted.position,
      run: admitted.outcome.then((outcome) => outcome.run),
    };
  }

  /**
   * Run now, awaited: the run's record once it ends (a queued run's once it
   * has waited for its slot and run), the skipped record when it is refused,
   * or null when the automation is not loaded.
   */
  async runNow(wsId: string, ownerId: string, automationId: string): Promise<AutomationRun | null> {
    const ticket = this.requestRunNow(wsId, ownerId, automationId);
    if (!ticket) return null;
    return ticket.run;
  }

  /**
   * Run one automation from a batch of notifications, bypassing schedule and
   * backoff the way {@link runNow} does, and carrying the batch as this run's
   * input.
   *
   * Separate from `runNow` for two reasons that are not cosmetic: the run must
   * carry `trigger: "event"` so its record says what woke it and the fire
   * ceiling can count it, and the caller needs to be told the run did not start
   * — a per-automation collision is a ledger row, not a silent no-op.
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
    automationId: string,
    input: RunInput,
  ): Promise<{ run: AutomationRun } | { skipped: string }> {
    const key = Scheduler.keyOf({ id: automationId, ownerId, workspaceId: wsId });
    const auto = this.definitions.get(key);
    if (!auto) return { skipped: "the automation is no longer in this workspace" };
    // Unattended, so `enabled` gates it; `runNow` is the attended trigger that does not.
    if (!auto.enabled) return { skipped: "the automation is disabled" };
    if (!this.running) return { skipped: STOPPED_REASON };
    const duplicate = this.duplicateOf(key);
    if (duplicate) {
      this.recordSkipped(auto, `${duplicate} (event)`, "event");
      return { skipped: EVENT_DUPLICATE_ANSWER[duplicate] };
    }
    const admitted = this.admit(key, "event", input);
    if (admitted.state === "started") {
      return { run: await this.dispatchRun(auto, "event", input, admitted.lease) };
    }
    if (admitted.state === "refused") {
      this.recordSkipped(auto, this.refusalReason(admitted.reason, "event"), "event");
      return { skipped: this.eventRefusalAnswer(admitted.reason) };
    }
    const outcome = await admitted.outcome;
    if (!outcome.started) return { skipped: outcome.run.error ?? "the queued run did not start" };
    return { run: outcome.run };
  }

  /** Whether the automation at `key` already has a run holding a slot or waiting for one. */
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
  ):
    | { state: "started"; lease: AdmissionLease }
    | { state: "queued"; position: number; outcome: Promise<QueuedOutcome> }
    | { state: "refused"; reason: AdmissionRefusal } {
    let entry!: QueuedRun;
    const outcome = new Promise<QueuedOutcome>((resolve, reject) => {
      entry = { key, trigger, ...(input ? { input } : {}), resolve, reject };
    });
    const ticket = this.admission.request(Scheduler.admissionOf(key), {
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
   * may have changed while it waited: the automation deleted, an event
   * automation disabled, a Run now whose budget another run spent. A run
   * refused here gives its slot straight back.
   */
  private startQueued(entry: QueuedRun, lease: AdmissionLease): void {
    const auto = this.definitions.get(entry.key);
    if (!auto) {
      lease.release();
      entry.resolve(notStartedRun(entry.key, "the automation was deleted while queued"));
      return;
    }
    const refuse = (reason: string) =>
      entry.resolve({ run: this.recordSkipped(auto, reason, entry.trigger), started: false });
    try {
      if (entry.trigger === "event" && !auto.enabled) {
        lease.release();
        refuse("Disabled while queued (event)");
        return;
      }
      const budget = entry.trigger === "manual" ? runNowBudgetRefusal(auto, Date.now()) : null;
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
    this.dispatchRun(auto, entry.trigger, entry.input, lease).then(
      (run) => entry.resolve({ run, started: true }),
      entry.reject,
    );
  }

  /**
   * A queued run left the queue without a slot: cancelled, the scheduler
   * stopped, or its workspace deleted. Recorded where its automation can still
   * hold the record; a deleted workspace's runs are answered without writing.
   */
  private leftQueue(entry: QueuedRun, reason: AdmissionWithdrawal): void {
    const auto = reason === WORKSPACE_DELETED ? undefined : this.definitions.get(entry.key);
    const cancelled = reason === "cancelled";
    const text = cancelled
      ? "Cancelled by user while queued"
      : reason === WORKSPACE_DELETED
        ? "the workspace was deleted"
        : "Queued run dropped: the runtime stopped before a run slot freed";
    const status = cancelled ? "cancelled" : "skipped";
    try {
      entry.resolve(
        auto
          ? { run: this.recordSkipped(auto, text, entry.trigger, status), started: false }
          : notStartedRun(entry.key, text, status),
      );
    } catch (err) {
      entry.reject(err);
    }
  }

  /**
   * Get the current definitions (for inspection/testing).
   */
  getDefinitions(): Map<string, Automation> {
    return this.definitions;
  }

  /**
   * Get active run IDs (for inspection/testing).
   */
  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  /**
   * Cancel an automation's run: abort it when in flight, or take it out of the
   * queue (recording it as cancelled) when waiting. Returns false when it has
   * neither.
   */
  cancelRun(wsId: string, ownerId: string, automationId: string): boolean {
    const key = Scheduler.keyOf({ id: automationId, ownerId, workspaceId: wsId });
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
   * Check if the scheduler is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  /**
   * Arm the timer to fire at the next due automation or after MAX_TIMER_MS.
   */
  armTimer(): void {
    if (!this.running) return;
    this.clearTimer();

    // With no free run slot a due automation is deferred, not skipped, so it
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
      // delay for as long as such an automation exists.
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

    // Detached: `reload()` arms from inside the tool call that mutated an
    // automation, and each fire re-arms from the previous one, so a timer that
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
    const dispatched: Promise<AutomationRun>[] = [];

    for (const auto of byNextRunAt(this.definitions.values())) {
      // One automation cannot take the timer down with it. `armTimer()` below
      // is the only thing that re-arms, and the promise this runs inside is
      // discarded by the `setTimeout` that scheduled it — so a throw reaching
      // here would stop the scheduler for EVERY workspace, silently and until
      // the process restarts. `recordSkipped` writes to the store before it
      // reads, so a store that refuses a write (a workspace archived under a
      // run) is one way to throw. That refusal is permanent — the workspace is
      // gone — and it lands before `nextRunAt` advances, so the automation is
      // dropped as `dropWorkspace` would have; kept, it stays due and the timer
      // re-arms at zero delay.
      try {
        const run = this.considerForDispatch(auto, now);
        if (run) dispatched.push(run);
      } catch (err) {
        if (err instanceof WorkspaceRootMissingError) {
          this.definitions.delete(Scheduler.keyOf(auto));
        }
        log.warn("[automations] scheduler sweep skipped one automation", {
          automationId: auto.id,
          workspaceId: auto.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Wait for all dispatched runs to complete so updateAfterRun sets
    // nextRunAt before we re-arm. Without this, the timer re-arms with
    // stale nextRunAt values and fires the same automation repeatedly.
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
   * per-automation try/catch that keeps one failure from stopping the sweep;
   * the predicate chain itself is unchanged.
   */
  private considerForDispatch(auto: Automation, now: number): Promise<AutomationRun> | null {
    if (!auto.enabled) return null;
    if (!isDue(auto, now)) return null;
    if (isInBackoff(auto, now)) return null;

    // Per-automation concurrency guard
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
    // automation by construction. Queued runs take a freed slot first, since
    // admission hands it to them as it frees and the timer ticks later; a free
    // slot with runs waiting is not offered here.
    const ticket = this.admission.request(Scheduler.admissionOf(key));
    if (ticket.state !== "admitted") return null;

    return this.dispatchRun(auto, "scheduled", undefined, ticket.lease);
  }

  // -----------------------------------------------------------------------
  // Run dispatch
  // -----------------------------------------------------------------------

  /** Run `auto` in the slot `lease` holds, and free it when the run is recorded. */
  private async dispatchRun(
    auto: Automation,
    trigger: AutomationRunTrigger,
    input: RunInput | undefined,
    lease: AdmissionLease,
  ): Promise<AutomationRun> {
    const key = Scheduler.keyOf(auto);
    const controller = new AbortController();
    this.activeRuns.set(key, controller);
    // Capture real dispatch time so synthesized failure records carry an
    // honest elapsed window. Without this, a 5-minute hang and a
    // 100-millisecond setup crash both render as startedAt == completedAt
    // to the millisecond — operators can't tell the failure modes apart
    // from the run record alone.
    const startedAt = new Date().toISOString();

    try {
      return await this.executeAndRecord(auto, controller, startedAt, trigger, input, lease);
    } finally {
      // The slot is free whether the run's record landed or its write threw.
      // Releasing it admits the next queued run. `executeTask` releases it as
      // the run ends; this covers an executor that never reached it.
      this.activeRuns.delete(key);
      lease.release();
    }
  }

  /** Run the executor and record the outcome; the slot is released by the caller. */
  private async executeAndRecord(
    auto: Automation,
    controller: AbortController,
    startedAt: string,
    trigger: AutomationRunTrigger,
    input: RunInput | undefined,
    lease: AdmissionLease,
  ): Promise<AutomationRun> {
    try {
      const { run, result } = await this.executor(auto, controller.signal, trigger, input, lease);
      this.updateAfterRun(auto, run);
      // Persist the full deliverable sidecar alongside the run summary. Present
      // for both the scheduled and manual (runNow) paths; null only when the
      // executor had no clean data (it rejected instead — see the catch below).
      if (result) this.persistRunResult(auto, result);
      this.runRecorded(auto);
      return run;
    } catch (err) {
      const { status, suffix, error, transient } = classifyRunFailure(err);
      const failedRun: AutomationRun = {
        id: `run_${Date.now()}_${suffix}`,
        automationId: auto.id,
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
      this.updateAfterRun(auto, failedRun);
      this.runRecorded(auto);
      return failedRun;
    }
  }

  /** Report a written run record to `onRunRecorded`, after every file for it has landed. */
  private runRecorded(auto: Automation): void {
    if (!auto.workspaceId || !auto.ownerId) return;
    this.config.onRunRecorded?.(auto.ownerId);
  }

  // -----------------------------------------------------------------------
  // State management
  // -----------------------------------------------------------------------

  /**
   * Update automation state after a run completes.
   *
   * Re-reads definitions from disk before merging run-state fields to avoid
   * overwriting concurrent changes (e.g., a user pausing via the UI while
   * a run is in flight).
   */
  updateAfterRun(automation: Automation, run: AutomationRun): void {
    const wsId = automation.workspaceId;
    const ownerId = automation.ownerId;
    if (!wsId || !ownerId) return; // defensive — every fired automation carries both

    // Re-read THIS automation's own file to pick up concurrent changes (pause,
    // config edits) without clobbering them. Per-automation files mean a
    // concurrent edit to a sibling automation can never be lost here.
    const auto = loadAutomation(this.config.workDir, wsId, ownerId, automation.id);
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

    applyConsecutiveErrors(auto, run, now);
    applyNextRunAt(auto, now, this.config.defaultTimezone);
    auto.updatedAt = new Date(now).toISOString();
    applyTokenBudget(auto, run, now, this.config.defaultTimezone);

    // Persist the run summary + the updated definition, then sync the single
    // in-memory entry so the timer sees the new nextRunAt without re-scanning.
    appendRun(this.config.workDir, wsId, ownerId, automation.id, run);
    automationRunsTotal.inc({ status: run.status });
    saveAutomation(this.config.workDir, wsId, ownerId, auto);
    this.definitions.set(Scheduler.keyOf(auto), auto);
  }

  /**
   * Persist a run's full result sidecar under the automation's provenance
   * workspace + owner. No-op when either is missing (defensive).
   */
  private persistRunResult(auto: Automation, result: AutomationRunResult): void {
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
    auto: Automation,
    reason: string,
    trigger?: AutomationRunTrigger,
    status: "skipped" | "cancelled" = "skipped",
  ): AutomationRun {
    const now = Date.now();
    const run: AutomationRun = {
      id: `run_${now}_${status === "cancelled" ? "cancel" : "skip"}`,
      automationId: auto.id,
      startedAt: new Date(now).toISOString(),
      completedAt: new Date(now).toISOString(),
      status,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      iterations: 0,
      error: reason,
    };
    const wsId = auto.workspaceId;
    const ownerId = auto.ownerId;
    if (!wsId || !ownerId) return run; // defensive — can't locate the store
    appendRun(this.config.workDir, wsId, ownerId, auto.id, run);
    automationRunsTotal.inc({ status: run.status });

    if (trigger !== undefined && trigger !== "scheduled") {
      this.runRecorded(auto);
      return run;
    }

    // Advance nextRunAt so this automation isn't immediately "due" again.
    // Re-read THIS automation's file to avoid overwriting concurrent changes.
    const fresh = loadAutomation(this.config.workDir, wsId, ownerId, auto.id);
    if (fresh) {
      // Stamp the authoritative workspace + owner (see updateAfterRun) so the
      // composite key stays consistent with what `loadAll` keyed under.
      fresh.workspaceId = wsId;
      fresh.ownerId = ownerId;
      const nextRun = nextRunOrNone(fresh, now, this.config.defaultTimezone);
      if (nextRun !== null) {
        // Ensure nextRunAt is in the future — if the computed time is past
        // (e.g., interval based on old lastRunAt), advance by intervalMs from now
        const effectiveNext = nextRun > now ? nextRun : now + (fresh.schedule.intervalMs ?? 60_000);
        setNextRunAt(fresh, effectiveNext);
      } else {
        setNextRunAt(fresh, null);
      }
      fresh.updatedAt = new Date(now).toISOString();
      saveAutomation(this.config.workDir, wsId, ownerId, fresh);
      this.definitions.set(Scheduler.keyOf(fresh), fresh);
    }

    this.runRecorded(auto);
    return run;
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
