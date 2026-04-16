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
import { appendRun, loadDefinitions, saveDefinitions } from "./store.ts";
import type { Automation, AutomationRun } from "./types.ts";

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

/** The executor function that the scheduler delegates to. */
export type Executor = (automation: Automation, signal: AbortSignal) => Promise<AutomationRun>;

export interface SchedulerConfig {
  /** Directory override for the automations store. */
  storeDir?: string;
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

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private definitions: Map<string, Automation> = new Map();
  private readonly activeRuns: Map<string, AbortController> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  private readonly executor: Executor;
  private config: SchedulerConfig;
  private readonly maxConcurrentRuns: number;

  constructor(executor: Executor, config: SchedulerConfig = {}) {
    this.executor = executor;
    this.config = config;
    this.maxConcurrentRuns = config.maxConcurrentRuns ?? 2;
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
    this.definitions = loadDefinitions(this.config.storeDir);

    // Compute initial nextRunAt for automations that don't have one
    const now = Date.now();
    for (const auto of this.definitions.values()) {
      if (auto.enabled && !auto.nextRunAt) {
        const next = computeNextRunAt(auto, now, this.config.defaultTimezone);
        if (next !== null) {
          auto.nextRunAt = new Date(next).toISOString();
        }
      }
    }
    saveDefinitions(this.definitions, this.config.storeDir);

    this.armTimer();
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
   * Reload definitions from the store and re-arm the timer.
   * Optionally accepts a storeDir override for workspace-scoped reloads.
   */
  reload(storeDir?: string): void {
    if (storeDir) {
      this.config = { ...this.config, storeDir };
    }
    this.definitions = loadDefinitions(this.config.storeDir);

    // Compute nextRunAt for new automations
    const now = Date.now();
    let changed = false;
    for (const auto of this.definitions.values()) {
      if (auto.enabled && !auto.nextRunAt) {
        const next = computeNextRunAt(auto, now, this.config.defaultTimezone);
        if (next !== null) {
          auto.nextRunAt = new Date(next).toISOString();
          changed = true;
        }
      }
    }
    if (changed) {
      saveDefinitions(this.definitions, this.config.storeDir);
    }

    this.clearTimer();
    if (this.running) {
      this.armTimer();
    }
  }

  /**
   * Trigger an immediate run of a specific automation, bypassing schedule
   * and backoff checks. Respects concurrency guards.
   */
  async runNow(automationId: string): Promise<AutomationRun | null> {
    const auto = this.definitions.get(automationId);
    if (!auto) {
      const ids = Array.from(this.definitions.keys());
      process.stderr.write(
        `[automations] runNow: "${automationId}" not found in ${ids.length} definitions: [${ids.join(", ")}]. storeDir=${this.config.storeDir ?? "default"}\n`,
      );
      return null;
    }

    // Still respect per-automation concurrency
    if (this.activeRuns.has(automationId)) {
      const skipped = this.recordSkipped(auto, "Already running (runNow)");
      return skipped;
    }

    return this.dispatchRun(auto);
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
  cancelRun(automationId: string): boolean {
    const controller = this.activeRuns.get(automationId);
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
      if (this.activeRuns.has(auto.id)) {
        this.recordSkipped(auto, "Previous run still active");
        continue;
      }

      // Global concurrency limit
      if (this.activeRuns.size >= this.maxConcurrentRuns) {
        this.recordSkipped(auto, `Global concurrent run limit (${this.maxConcurrentRuns}) reached`);
        continue;
      }

      dispatched.push(this.dispatchRun(auto));
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

  private async dispatchRun(auto: Automation): Promise<AutomationRun> {
    const controller = new AbortController();
    this.activeRuns.set(auto.id, controller);

    try {
      const run = await this.executor(auto, controller.signal);
      this.activeRuns.delete(auto.id);
      this.updateAfterRun(auto, run);
      return run;
    } catch (err) {
      this.activeRuns.delete(auto.id);
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = !isAbort && errorMsg.includes("timed out");
      const failedRun: AutomationRun = {
        id: `run_${Date.now()}_${isAbort ? "cancel" : isTimeout ? "timeout" : "err"}`,
        automationId: auto.id,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: isAbort ? "cancelled" : isTimeout ? "timeout" : "failure",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        iterations: 0,
        error: isAbort ? "Cancelled by user" : errorMsg,
        transient: isAbort ? false : isTransientError(errorMsg),
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
    // Re-read from disk to pick up any concurrent changes (pause, config edits)
    this.definitions = loadDefinitions(this.config.storeDir);

    const auto = this.definitions.get(automation.id);
    if (!auto) return;

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

    // Persist
    appendRun(automation.id, run, this.config.storeDir);
    saveDefinitions(this.definitions, this.config.storeDir);
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
    appendRun(auto.id, run, this.config.storeDir);

    // Advance nextRunAt so this automation isn't immediately "due" again.
    // Re-read from disk to avoid overwriting concurrent changes.
    this.definitions = loadDefinitions(this.config.storeDir);
    const fresh = this.definitions.get(auto.id);
    if (fresh) {
      const nextRun = computeNextRunAt(fresh, now, this.config.defaultTimezone);
      if (nextRun !== null) {
        // Ensure nextRunAt is in the future — if the computed time is past
        // (e.g., interval based on old lastRunAt), advance by intervalMs from now
        const effectiveNext = nextRun > now ? nextRun : now + (fresh.schedule.intervalMs ?? 60_000);
        fresh.nextRunAt = new Date(effectiveNext).toISOString();
      }
      fresh.updatedAt = new Date(now).toISOString();
      saveDefinitions(this.definitions, this.config.storeDir);
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
