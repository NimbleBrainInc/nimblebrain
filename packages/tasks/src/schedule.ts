/**
 * Schedule maths, budget windows and the failure policy: pure functions of a
 * definition and an instant the caller passes. Nothing here reads a clock; the
 * instant is always the host's (CONTRACT.md §6).
 */

import { Cron } from "croner";
import type { Schedule, ScheduleType, TaskDef, TokenBudget, WindowUsage } from "./model.ts";

/** Backoff after a failed run, by streak length (1-based), capped at the last entry. */
export const BACKOFF_DELAYS_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
/** A task disables after this many non-transient failures in a streak. */
export const MAX_CONSECUTIVE_ERRORS = 10;
/** A task disables after this many failures in a streak, transient ones included. */
export const MAX_CONSECUTIVE_TRANSIENT_ERRORS = 100;
/** How late a once schedule may still fire after its `at`, judged on the host's `now`. */
export const ONCE_GRACE_MS = 3_600_000;
export const DEFAULT_EVENT_DEBOUNCE_MS = 30_000;
export const DEFAULT_EVENT_MAX_FIRES_PER_HOUR = 12;
/** The window the fire ceiling counts in. */
export const FIRE_WINDOW_MS = 3_600_000;
/** Events one occurrence carries; the next starts a new occurrence. */
export const MAX_EVENTS_PER_RUN = 50;

export function scheduleTypeOf(schedule: Schedule | undefined): ScheduleType {
  if (!schedule) return "none";
  if ("cron" in schedule) return "cron";
  if ("at" in schedule) return "once";
  if ("intervalMs" in schedule) return "interval";
  return "event";
}

/** Whether the schedule is a position in time (cron, interval, once). */
export function isTimed(schedule: Schedule | undefined): boolean {
  const type = scheduleTypeOf(schedule);
  return type === "cron" || type === "interval" || type === "once";
}

/** Why a written schedule cannot be stored, or null. The schema already checked its shape. */
export function scheduleProblem(schedule: Schedule): string | null {
  if ("cron" in schedule) {
    if (!isTimezone(schedule.timezone)) return `unknown timezone "${schedule.timezone}"`;
    try {
      // A fixed reference instant: "matches no date at all" (`0 9 31 2 *`) is decided
      // without the clock.
      const next = new Cron(schedule.cron, { timezone: schedule.timezone }).nextRun(new Date(0));
      if (next === null) return `cron "${schedule.cron}" matches no date`;
    } catch (err) {
      return `cron "${schedule.cron}" does not parse: ${err instanceof Error ? err.message : err}`;
    }
  }
  if ("at" in schedule && Number.isNaN(Date.parse(schedule.at))) {
    return `at "${schedule.at}" is not an instant`;
  }
  return null;
}

export function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The schedule's next occurrence after the definition's last run, judged at
 * `now`: a cron's next fire after `now`, an interval `intervalMs` after the
 * last run (at `now` when it has none), a once's `at`. Null for no schedule,
 * an event schedule, or a cron with no next fire.
 */
export function nextOccurrence(task: TaskDef, now: number): number | null {
  const schedule = task.schedule;
  if (!schedule) return null;
  if ("cron" in schedule) {
    try {
      const next = new Cron(schedule.cron, { timezone: schedule.timezone }).nextRun(new Date(now));
      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }
  if ("at" in schedule) {
    const at = Date.parse(schedule.at);
    return Number.isNaN(at) ? null : at;
  }
  if ("intervalMs" in schedule) {
    return task.lastRunAt ? Date.parse(task.lastRunAt) + schedule.intervalMs : now;
  }
  return null;
}

export function backoffDelay(streak: number): number {
  if (streak <= 0) return 0;
  return BACKOFF_DELAYS_MS[Math.min(streak - 1, BACKOFF_DELAYS_MS.length - 1)] as number;
}

/**
 * The next occurrence after a run ended at `now`, pushed out by backoff during
 * an error streak but never sooner than the schedule's own next fire.
 */
export function nextAfterRun(task: TaskDef, now: number): number | null {
  const next = nextOccurrence(task, now);
  if (next === null || task.consecutiveErrors <= 0) return next;
  return Math.max(next, now + backoffDelay(task.consecutiveErrors));
}

export function setNextRunAt(task: TaskDef, at: number | null): void {
  if (at === null) delete task.nextRunAt;
  else task.nextRunAt = new Date(at).toISOString();
}

// ── Budget windows ───────────────────────────────────────────────────────

/** The window an instant falls in for a budget: a UTC day, a UTC month, or `lifetime`. */
export function windowOf(budget: TokenBudget | undefined, at: number): string {
  const iso = new Date(at).toISOString();
  if (budget?.period === "daily") return iso.slice(0, 10);
  if (budget?.period === "monthly") return iso.slice(0, 7);
  return "lifetime";
}

/** The instant the window ends (the next UTC day or month), or undefined for `lifetime`. */
export function windowEnd(window: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(window)) {
    const d = new Date(`${window}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  if (/^\d{4}-\d{2}$/.test(window)) {
    const d = new Date(`${window}-01T00:00:00.000Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString();
  }
  return undefined;
}

/** What the task's runs used in the window `at` falls in. */
export function usageAt(task: TaskDef, at: number): WindowUsage {
  const window = windowOf(task.tokenBudget, at);
  return task.usage.window === window ? task.usage : { window, input: 0, output: 0 };
}

/** Add a run's tokens to the window it started in; a run from an older window adds nothing. */
export function addUsage(task: TaskDef, at: number, input: number, output: number): void {
  const window = windowOf(task.tokenBudget, at);
  if (task.usage.window === window) {
    task.usage.input += input;
    task.usage.output += output;
  } else if (window > task.usage.window || task.usage.window === "lifetime") {
    task.usage = { window, input, output };
  }
}

/** Why the budget is spent in the window `at` falls in, or null. */
export function budgetSpent(task: TaskDef, at: number): string | null {
  const budget = task.tokenBudget;
  if (!budget) return null;
  const used = usageAt(task, at);
  if (budget.maxInputTokens !== undefined && used.input >= budget.maxInputTokens) {
    return `Token budget spent: ${used.input} of ${budget.maxInputTokens} input tokens in its window`;
  }
  if (budget.maxOutputTokens !== undefined && used.output >= budget.maxOutputTokens) {
    return `Token budget spent: ${used.output} of ${budget.maxOutputTokens} output tokens in its window`;
  }
  return null;
}

/** The prefix every task budget account id starts with. */
export const BUDGET_ACCOUNT_PREFIX = "task-budget:";

/** The budget's spend accounts for a run beginning at `at`: one per cap, holding what is left. */
export function budgetAccounts(
  task: TaskDef,
  at: number,
  sharedBy?: number,
): Array<{
  id: string;
  unit: "input_tokens" | "output_tokens";
  remaining: number;
  sharedBy?: number;
}> {
  const budget = task.tokenBudget;
  if (!budget) return [];
  const used = usageAt(task, at);
  const base = `${BUDGET_ACCOUNT_PREFIX}${task.uid}@${used.window}`;
  const share = sharedBy !== undefined && sharedBy > 1 ? { sharedBy } : {};
  const out: ReturnType<typeof budgetAccounts> = [];
  if (budget.maxInputTokens !== undefined) {
    const remaining = Math.max(0, budget.maxInputTokens - used.input);
    out.push({ id: `${base}:input_tokens`, unit: "input_tokens", remaining, ...share });
  }
  if (budget.maxOutputTokens !== undefined) {
    const remaining = Math.max(0, budget.maxOutputTokens - used.output);
    out.push({ id: `${base}:output_tokens`, unit: "output_tokens", remaining, ...share });
  }
  return out;
}

// ── The schedule in words ────────────────────────────────────────────────

/** The schedule as a person reads it. */
export function scheduleHuman(task: Pick<TaskDef, "schedule" | "onceDone">): string {
  const schedule = task.schedule;
  if (!schedule) return "Manual only";
  if ("at" in schedule) {
    const when = formatInstant(schedule.at);
    if (task.onceDone?.outcome === "ran") return `Ran once at ${when}`;
    if (task.onceDone?.outcome === "missed") return `Missed its time (${when})`;
    return `Once at ${when}`;
  }
  if ("intervalMs" in schedule) return formatInterval(schedule.intervalMs);
  if ("cron" in schedule) return formatCron(schedule.cron, schedule.timezone);
  const match = schedule.match;
  const parts: string[] = [];
  if (match.source) parts.push(`from ${match.source}`);
  if (match.name) parts.push(`matching ${match.name}`);
  if (match.level) parts.push(`at ${match.level} or above`);
  return parts.length > 0 ? `On notifications ${parts.join(", ")}` : "On any routed notification";
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${text} UTC`;
}

function formatInterval(intervalMs: number): string {
  const mins = Math.round(intervalMs / 60_000);
  if (mins < 60) return `Every ${mins} minute${mins === 1 ? "" : "s"}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Every ${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.round(hrs / 24);
  return `Every ${days} day${days === 1 ? "" : "s"}`;
}

function formatCron(expr: string, timezone: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = parts;
  if (month !== "*") return expr;
  const repeating = repeatingCron(minute, hour, dayOfMonth, dayOfWeek);
  if (repeating) return repeating;
  if (!isCronNumber(minute, 59) || !isCronNumber(hour, 23)) return expr;
  const at = `at ${formatTime(Number(hour), Number(minute))} ${timezoneAbbr(timezone)}`;
  if (dayOfMonth !== "*") {
    return dayOfWeek === "*" && isCronNumber(dayOfMonth, 31)
      ? `Monthly on the ${ordinal(Number(dayOfMonth))} ${at}`
      : expr;
  }
  const days = cronDaysInWords(dayOfWeek);
  return days ? `${days} ${at}` : expr;
}

function isCronNumber(field: string, max: number): boolean {
  return /^\d{1,2}$/.test(field) && Number(field) <= max;
}

function repeatingCron(minute: string, hour: string, dom: string, dow: string): string | null {
  if (dom !== "*" || dow !== "*") return null;
  return hour === "*" ? everyMinutes(minute) : everyHours(minute, hour);
}

function everyMinutes(minute: string): string | null {
  if (minute === "*") return "Every minute";
  if (/^\*\/\d+$/.test(minute)) {
    const n = Number(minute.slice(2));
    return `Every ${n} minute${n === 1 ? "" : "s"}`;
  }
  if (!isCronNumber(minute, 59)) return null;
  return Number(minute) === 0 ? "Every hour" : `Every hour at :${minute.padStart(2, "0")}`;
}

function everyHours(minute: string, hour: string): string | null {
  if (!/^\*\/\d+$/.test(hour) || !isCronNumber(minute, 59) || Number(minute) !== 0) return null;
  const n = Number(hour.slice(2));
  return n === 1 ? "Every hour" : `Every ${n} hours`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function cronDay(field: string): number | null {
  if (/^[0-7]$/.test(field)) return Number(field) % 7;
  const i = DAY_ABBR.indexOf(field.toUpperCase());
  return i >= 0 ? i : null;
}

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

function cronDaysInWords(field: string): string | null {
  if (field === "*") return "Every day";
  const days = cronDaySet(field);
  if (!days || days.length === 0) return null;
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (days.length === 7) return "Every day";
  const names = days.map((d) => `${DAY_NAMES[d]}s`);
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
  return `${hour % 12 || 12}:${minute.toString().padStart(2, "0")} ${period}`;
}

function timezoneAbbr(tz: string): string {
  const named: Record<string, string> = {
    "Pacific/Honolulu": "HST",
    "America/New_York": "EST",
    "America/Chicago": "CST",
    "America/Denver": "MST",
    "America/Los_Angeles": "PST",
    UTC: "UTC",
    "Etc/UTC": "UTC",
  };
  return named[tz] ?? tz;
}

// ── Event match ──────────────────────────────────────────────────────────

const LEVEL_RANK = { info: 0, attention: 1, urgent: 2 } as const;

/** Whether an event schedule's match admits a notification: source exact, name a glob, level a minimum. */
export function matchAdmits(
  match: { source?: string; name?: string; level?: keyof typeof LEVEL_RANK },
  event: { source: string; name: string; level: keyof typeof LEVEL_RANK },
): boolean {
  if (match.source !== undefined && match.source !== event.source) return false;
  if (!matchesNameGlob(event.name, match.name)) return false;
  return match.level === undefined || LEVEL_RANK[event.level] >= LEVEL_RANK[match.level];
}

interface GlobToken {
  literal: string;
  /** `true` for `**`, `false` for `*`, undefined for a literal. */
  crossesDot?: boolean;
}

/**
 * Whether a dotted event name matches a glob: `*` is any run within one
 * segment, `**` any run across segments, everything else literal. A sweep over
 * the reachable token positions, so it never backtracks.
 */
export function matchesNameGlob(name: string, pattern: string | undefined): boolean {
  if (pattern === undefined || pattern === "") return true;
  const tokens = tokenize(pattern);
  let reachable = new Array<boolean>(tokens.length + 1).fill(false);
  reachable[0] = true;
  skipEmptyWildcards(tokens, reachable);
  for (const char of name) {
    const next = new Array<boolean>(tokens.length + 1).fill(false);
    tokens.forEach((token, j) => {
      if (!reachable[j]) return;
      if (token.crossesDot === undefined) {
        if (token.literal === char) next[j + 1] = true;
      } else if (token.crossesDot || char !== ".") {
        next[j] = true;
      }
    });
    skipEmptyWildcards(tokens, next);
    reachable = next;
  }
  return reachable[tokens.length] === true;
}

function skipEmptyWildcards(tokens: readonly GlobToken[], reachable: boolean[]): void {
  for (let j = 0; j < tokens.length; j++) {
    if (reachable[j] && tokens[j]?.crossesDot !== undefined) reachable[j + 1] = true;
  }
}

function tokenize(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "*") {
      tokens.push({ literal: pattern[i] as string });
      continue;
    }
    let run = 0;
    while (pattern[i + run] === "*") run++;
    tokens.push({ literal: "", crossesDot: run >= 2 });
    i += run - 1;
  }
  return tokens;
}
