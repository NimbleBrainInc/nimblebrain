/**
 * Scheduling engine for automations.
 *
 * Uses setTimeout-based timer armed to the next-due job (max 60s wake).
 * Evaluates cron expressions via Croner. Handles interval scheduling,
 * concurrency guards, exponential backoff, and global concurrent run limits.
 *
 * The scheduler does NOT execute runs directly — it delegates to an
 * executor function injected at construction time.
 */

import { Cron } from "croner";
import {
  appendRun,
  loadAllAutomations,
  loadAutomation,
  saveAutomation,
  saveRunResult,
} from "./store.ts";
import type { Automation, AutomationRun, AutomationRunResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max wake interval — timer fires at least every 60s to catch drift. */
const MAX_TIMER_MS = 60_000;

/** Backoff delays indexed by (consecutiveErrors - 1). Capped at last entry. */
const BACKOFF_DELAYS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;

/** Auto-disable after this many consecutive failures. */
export const MAX_CONSECUTIVE_ERRORS = 10;

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
 * What initiated a run. A `scheduled` run fires from the timer with no user
 * present, so it must act as the automation's owner/provenance and must NOT
 * inherit any ambient request context (the timer can capture a stale one — see
 * `getExecutorContext`). A `manual` run is a user clicking "test", dispatched
 * synchronously inside that user's request context, which it legitimately uses.
 */
export type AutomationRunTrigger = "scheduled" | "manual";

/**
 * The executor function that the scheduler delegates to. Returns the run summary
 * AND the full run result (the deliverable). `result` is null only when the
 * executor had no clean data (the abort/timeout-as-throw path is handled via
 * rejection, not this shape).
 */
export type Executor = (
  automation: Automation,
  signal: AbortSignal,
  trigger: AutomationRunTrigger,
) => Promise<{ run: AutomationRun; result: AutomationRunResult | null }>;

export interface SchedulerConfig {
  /**
   * The runtime work directory (`{workDir}`). The scheduler is multi-workspace:
   * it scans `{workDir}/workspaces/<wsId>/automations/<ownerId>/` across every
   * workspace and owner and fires each automation as its owner, focused on its
   * provenance workspace. Automations are workspace-owned (the path is the wall).
   */
  workDir: string;
  /** Maximum concurrent automation runs. Default: 2. */
  maxConcurrentRuns?: number;
  /** Default timezone for cron expressions. Default: system timezone. */
  defaultTimezone?: string;
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
 */
export function backoffDelay(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return 0;
  const idx = Math.min(consecutiveErrors - 1, BACKOFF_DELAYS.length - 1);
  return BACKOFF_DELAYS[idx]!;
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
 * Check if an automation is due to run.
 */
export function isDue(automation: Automation, now: number): boolean {
  if (!automation.enabled) return false;
  if (!automation.nextRunAt) return true; // No nextRunAt → due immediately (interval first-run)
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
  // error's stable `code`, which crosses the in-process runtime→bundle boundary.
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
  private readonly activeRuns: Map<string, AbortController> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  private readonly executor: Executor;
  private config: SchedulerConfig;
  private readonly maxConcurrentRuns: number;

  constructor(executor: Executor, config: SchedulerConfig) {
    this.executor = executor;
    this.config = config;
    this.maxConcurrentRuns = config.maxConcurrentRuns ?? 2;
  }

  /** Composite key for the cross-workspace/owner definitions/activeRuns maps. */
  private static keyOf(automation: Pick<Automation, "id" | "ownerId" | "workspaceId">): string {
    return `${automation.workspaceId ?? ""}/${automation.ownerId ?? ""}/${automation.id}`;
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
   * Compute initial `nextRunAt` for any enabled automation missing one, and
   * persist the owners whose stores changed. Shared by start + reload.
   */
  private seedNextRunAt(): void {
    const now = Date.now();
    const dirty: Automation[] = [];
    for (const auto of this.definitions.values()) {
      if (auto.enabled && !auto.nextRunAt && auto.ownerId && auto.workspaceId) {
        const next = computeNextRunAt(auto, now, this.config.defaultTimezone);
        if (next !== null) {
          auto.nextRunAt = new Date(next).toISOString();
          dirty.push(auto);
        }
      }
    }
    for (const auto of dirty) this.persistAutomation(auto);
  }

  /**
   * Stop the scheduler. Clears the timer and aborts all active runs.
   */
  stop(): void {
    this.running = false;
    this.clearTimer();

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
   * Trigger an immediate run of a specific automation, bypassing schedule
   * and backoff checks. Respects concurrency guards.
   */
  async runNow(wsId: string, ownerId: string, automationId: string): Promise<AutomationRun | null> {
    const key = Scheduler.keyOf({ id: automationId, ownerId, workspaceId: wsId });
    const auto = this.definitions.get(key);
    if (!auto) {
      const keys = Array.from(this.definitions.keys());
      process.stderr.write(
        `[automations] runNow: "${key}" not found in ${keys.length} definitions: [${keys.join(", ")}]\n`,
      );
      return null;
    }

    // Still respect per-automation concurrency
    if (this.activeRuns.has(key)) {
      const skipped = this.recordSkipped(auto, "Already running (runNow)");
      return skipped;
    }

    return this.dispatchRun(auto, "manual");
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
   * Cancel an active automation run. Returns true if cancelled, false if not running.
   */
  cancelRun(wsId: string, ownerId: string, automationId: string): boolean {
    const controller = this.activeRuns.get(
      Scheduler.keyOf({ id: automationId, ownerId, workspaceId: wsId }),
    );
    if (!controller) return false;
    controller.abort();
    return true;
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

    const now = Date.now();
    let minDelay = MAX_TIMER_MS;

    for (const auto of this.definitions.values()) {
      if (!auto.enabled) continue;
      if (!auto.nextRunAt) {
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

    this.timer = setTimeout(() => this.onTimer(), minDelay);
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

    for (const auto of this.definitions.values()) {
      if (!auto.enabled) continue;
      if (!isDue(auto, now)) continue;
      if (isInBackoff(auto, now)) continue;

      // Per-automation concurrency guard
      if (this.activeRuns.has(Scheduler.keyOf(auto))) {
        this.recordSkipped(auto, "Previous run still active");
        continue;
      }

      // Global concurrency limit — shared across ALL owners (one in-process
      // scheduler per platform process, and the platform runs one process per
      // tenant). A busy owner can defer other owners' due runs to the next
      // tick; acceptable under the per-tenant-process model. Revisit with a
      // per-owner fair-share queue only if multi-tenant fairness becomes a need.
      if (this.activeRuns.size >= this.maxConcurrentRuns) {
        this.recordSkipped(auto, `Global concurrent run limit (${this.maxConcurrentRuns}) reached`);
        continue;
      }

      dispatched.push(this.dispatchRun(auto, "scheduled"));
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

  // -----------------------------------------------------------------------
  // Run dispatch
  // -----------------------------------------------------------------------

  private async dispatchRun(
    auto: Automation,
    trigger: AutomationRunTrigger,
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
      const { run, result } = await this.executor(auto, controller.signal, trigger);
      this.activeRuns.delete(key);
      this.updateAfterRun(auto, run);
      // Persist the full deliverable sidecar alongside the run summary. Present
      // for both the scheduled and manual (runNow) paths; null only when the
      // executor had no clean data (it rejected instead — see the catch below).
      if (result) this.persistRunResult(auto, result);
      return run;
    } catch (err) {
      this.activeRuns.delete(key);
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
      };
      this.updateAfterRun(auto, failedRun);
      return failedRun;
    }
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
    auto.lastRunStatus =
      run.status === "success"
        ? "success"
        : run.status === "timeout"
          ? "timeout"
          : run.status === "skipped"
            ? "skipped"
            : "failure";
    auto.runCount = (auto.runCount ?? 0) + 1;

    // Track cumulative tokens
    auto.cumulativeInputTokens = (auto.cumulativeInputTokens ?? 0) + run.inputTokens;
    auto.cumulativeOutputTokens = (auto.cumulativeOutputTokens ?? 0) + run.outputTokens;

    if (run.status === "success") {
      auto.consecutiveErrors = 0;
    } else if (run.status === "failure" || run.status === "timeout") {
      auto.consecutiveErrors = (auto.consecutiveErrors ?? 0) + 1;

      // Auto-disable after too many consecutive failures
      if (auto.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        auto.enabled = false;
        auto.disabledAt = new Date(now).toISOString();
        auto.disabledReason = `Auto-disabled after ${auto.consecutiveErrors} consecutive failures. Last error: ${(run.error ?? "unknown").slice(0, 200)}`;
      }
    }
    // skipped and cancelled don't affect consecutiveErrors

    // Compute next run time
    const nextRun = computeNextRunAt(auto, now, this.config.defaultTimezone);
    if (nextRun !== null) {
      // If in backoff, push nextRunAt forward by the backoff delay
      // but never schedule sooner than the natural interval
      if (auto.consecutiveErrors > 0) {
        const delay = backoffDelay(auto.consecutiveErrors);
        const naturalDelay = nextRun - now;
        const effectiveDelay = Math.max(delay, naturalDelay);
        auto.nextRunAt = new Date(now + effectiveDelay).toISOString();
      } else {
        auto.nextRunAt = new Date(nextRun).toISOString();
      }
    }

    auto.updatedAt = new Date(now).toISOString();

    // Check token budget
    if (auto.tokenBudget && auto.enabled) {
      // Reset counters if budget period has elapsed
      if (auto.budgetResetAt && new Date(auto.budgetResetAt).getTime() <= now) {
        auto.cumulativeInputTokens = run.inputTokens;
        auto.cumulativeOutputTokens = run.outputTokens;
        auto.budgetResetAt = computeBudgetResetAt(
          auto.tokenBudget.period,
          now,
          this.config.defaultTimezone,
        );
      }

      // Initialize budgetResetAt if not set
      if (!auto.budgetResetAt && auto.tokenBudget.period) {
        auto.budgetResetAt = computeBudgetResetAt(
          auto.tokenBudget.period,
          now,
          this.config.defaultTimezone,
        );
      }

      // Check limits
      const inputExceeded =
        auto.tokenBudget.maxInputTokens != null &&
        auto.cumulativeInputTokens > auto.tokenBudget.maxInputTokens;
      const outputExceeded =
        auto.tokenBudget.maxOutputTokens != null &&
        auto.cumulativeOutputTokens > auto.tokenBudget.maxOutputTokens;

      if (inputExceeded || outputExceeded) {
        auto.enabled = false;
        auto.disabledAt = new Date(now).toISOString();
        const which = inputExceeded ? "input" : "output";
        const used = inputExceeded ? auto.cumulativeInputTokens : auto.cumulativeOutputTokens;
        const limit = inputExceeded
          ? auto.tokenBudget.maxInputTokens
          : auto.tokenBudget.maxOutputTokens;
        auto.disabledReason = `Token budget exceeded: ${used.toLocaleString()} / ${limit!.toLocaleString()} ${which} tokens used`;
      }
    }

    // Persist the run summary + the updated definition, then sync the single
    // in-memory entry so the timer sees the new nextRunAt without re-scanning.
    appendRun(this.config.workDir, wsId, ownerId, automation.id, run);
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
   * Record a skipped run in the store.
   */
  private recordSkipped(auto: Automation, reason: string): AutomationRun {
    const now = Date.now();
    const run: AutomationRun = {
      id: `run_${now}_skip`,
      automationId: auto.id,
      startedAt: new Date(now).toISOString(),
      completedAt: new Date(now).toISOString(),
      status: "skipped",
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

    // Advance nextRunAt so this automation isn't immediately "due" again.
    // Re-read THIS automation's file to avoid overwriting concurrent changes.
    const fresh = loadAutomation(this.config.workDir, wsId, ownerId, auto.id);
    if (fresh) {
      // Stamp the authoritative workspace + owner (see updateAfterRun) so the
      // composite key stays consistent with what `loadAll` keyed under.
      fresh.workspaceId = wsId;
      fresh.ownerId = ownerId;
      const nextRun = computeNextRunAt(fresh, now, this.config.defaultTimezone);
      if (nextRun !== null) {
        // Ensure nextRunAt is in the future — if the computed time is past
        // (e.g., interval based on old lastRunAt), advance by intervalMs from now
        const effectiveNext = nextRun > now ? nextRun : now + (fresh.schedule.intervalMs ?? 60_000);
        fresh.nextRunAt = new Date(effectiveNext).toISOString();
      }
      fresh.updatedAt = new Date(now).toISOString();
      saveAutomation(this.config.workDir, wsId, ownerId, fresh);
      this.definitions.set(Scheduler.keyOf(fresh), fresh);
    }

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
