/**
 * Tasks domain API — internal CRUD operations on Tasks.
 *
 * The LLM-facing tool handlers (`handleCreate` / `handleUpdate` /
 * `handleDelete` in `server.ts`) are thin schema-translators that
 * delegate here. An internal caller that needs the operator fields calls
 * this module directly. No callers go through the LLM-facing schema except
 * the LLM itself.
 *
 * Why split this out:
 *
 *   - The LLM-facing schema must be minimal (no `source`) — operator/runtime
 *     fields stay off it.
 *   - But an internal caller legitimately needs to set those fields.
 *   - Without this split, internal callers either (a) pass the wrong
 *     shape and silently no-op, or (b) sneak operator fields back into
 *     the LLM-facing schema.
 *
 * The convention for the wider codebase: any time the same domain has
 * both LLM-facing and internal callers, factor a domain module that
 * accepts the full shape. The tool handler becomes a thin wrapper that
 * narrows the input.
 *
 * See `src/platform/AGENTS.md` § 1.4 for the cross-cutting rule.
 */

import { computeBudgetResetAt, computeNextRunAt, setNextRunAt } from "./scheduler.ts";
import {
  isEventSchedule,
  isOnceSchedule,
  onceRetirement,
  type ScheduleSpec,
  type Task,
  type TaskKind,
  type TaskSource,
  type TokenBudget,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Domain context — the minimum each operation needs
// ---------------------------------------------------------------------------

/**
 * What the domain needs to read/write the task store and trigger
 * scheduler reloads. Both the platform source's `ToolContext` and the
 * runtime's `getTasksApi()` helper satisfy this shape.
 */
export interface TaskDomainContext {
  definitions: () => Map<string, Task>;
  save: (defs: Map<string, Task>) => void;
  reloadScheduler: () => void;
  defaultTimezone: string;
}

/**
 * The forward budget-reset boundary for a task's current `tokenBudget`,
 * or `undefined` for a periodless (lifetime) budget. Anchored at write time so
 * the scheduler's window can roll from the first run rather than being seeded
 * lazily at end-of-run (which left pre-budget spend counting forever).
 */
function budgetResetBoundary(task: Task, defaultTimezone?: string): string | undefined {
  const period = task.tokenBudget?.period;
  return period ? computeBudgetResetAt(period, Date.now(), defaultTimezone) : undefined;
}

/** Whether two token budgets are materially the same (all caps + period). */
function tokenBudgetsEqual(a: TokenBudget | undefined, b: TokenBudget | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.maxInputTokens === b.maxInputTokens &&
    a.maxOutputTokens === b.maxOutputTokens &&
    a.period === b.period
  );
}

/**
 * Start a fresh budget window when the budget materially CHANGED: clear the
 * running totals and re-anchor the reset boundary. `budgetResetAt` +
 * `cumulative*` together define one window, so a changed budget starts a new
 * one — otherwise spend from the prior window counts against the new ceiling.
 *
 * Change-gated, not write-gated: re-sending an identical budget (e.g. alongside
 * an unrelated field edit) must not zero accumulated spend. Unlike the
 * idempotent `nextRunAt` recompute, this reset is destructive, so it fires only
 * on a real change. A no-op (`next` absent or equal) leaves the window intact.
 */
function resetBudgetWindowIfChanged(
  task: Task,
  prev: TokenBudget | undefined,
  next: TokenBudget | undefined,
  defaultTimezone?: string,
): void {
  if (next === undefined || tokenBudgetsEqual(prev, next)) return;
  task.cumulativeInputTokens = 0;
  task.cumulativeOutputTokens = 0;
  task.budgetResetAt = budgetResetBoundary(task, defaultTimezone);
}

// ---------------------------------------------------------------------------
// Input shapes — the full domain shape, including operator-only fields
// ---------------------------------------------------------------------------

/**
 * Full create input for the domain. Includes operator-only fields the
 * LLM-facing schema does NOT expose: `source`, `ownerId`, `workspaceId`.
 * The tool handler hardcodes `source: "agent"` and derives ownership from
 * request context.
 */
export interface DomainCreateInput {
  name: string;
  prompt: string;
  /** Absent: nothing fires it unattended; it runs only when someone runs it. */
  schedule?: ScheduleSpec;
  kind?: TaskKind;
  description?: string;
  skill?: string;
  model?: string;
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  tokenBudget?: TokenBudget;
  enabled?: boolean;
  allowedTools?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  // Operator/runtime fields:
  source?: TaskSource;
  ownerId?: string;
  workspaceId?: string;
}

/** Patch shape for update. Every field optional. */
export interface DomainUpdatePatch {
  description?: string;
  /** `null` removes the schedule: nothing fires the task unattended. */
  schedule?: ScheduleSpec | null;
  prompt?: string;
  skill?: string;
  model?: string;
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  tokenBudget?: TokenBudget;
  enabled?: boolean;
  allowedTools?: string[];
  /** `null` removes it: runs take any input. */
  inputSchema?: Record<string, unknown> | null;
  /** `null` removes it: the deliverable is not checked. */
  outputSchema?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Who may own a task that wakes on events.
 *
 * A person, or the agent acting on a person's instruction. Not a bundle: a
 * connector that could give itself a task subscribed to its own outbox
 * would have written a self-wake loop with no operator anywhere in it, and the
 * whole reason this path is safe is that an operator authored both ends of it.
 *
 * Stated as the set that MAY rather than the one that may not, so a third
 * provenance added later is refused until somebody decides otherwise — a list
 * of exclusions silently admits whatever it has not heard of.
 */
const EVENT_SCHEDULE_SOURCES: readonly TaskSource[] = ["user", "agent"];

/**
 * Refuse an event schedule on a task whose provenance may not have one.
 *
 * Enforced here rather than in the tool schema because the tool schema does not
 * carry `source` at all — it is an operator/runtime field, so the only caller
 * that can set it is an internal one coming through this module.
 */
export function assertEventScheduleAllowed(
  schedule: ScheduleSpec | undefined,
  source: TaskSource | undefined,
  name: string,
): void {
  if (!isEventSchedule(schedule)) return;
  if (source !== undefined && !EVENT_SCHEDULE_SOURCES.includes(source)) {
    throw new Error(
      `Task "${name}" has source "${source}" and cannot run on events. ` +
        "An event schedule is reachable only through a delivery route a workspace admin " +
        "wrote, and only a user or the agent acting for one may own the task it names.",
    );
  }
}

export function toKebabCase(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findByName(defs: Map<string, Task>, name: string): Task | undefined {
  // Match either the kebab-case id or the human-readable name (case-sensitive).
  const id = toKebabCase(name);
  return defs.get(id) ?? Array.from(defs.values()).find((a) => a.name === name);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateResult {
  task: Task;
  created: boolean;
  message: string;
}

export function createTask(input: DomainCreateInput, ctx: TaskDomainContext): CreateResult {
  const id = toKebabCase(input.name);
  const defs = ctx.definitions();

  // Idempotent: return existing if same id.
  const existing = defs.get(id);
  if (existing) {
    return {
      task: existing,
      created: false,
      message: `Task "${input.name}" already exists (id: ${id}). Returning existing.`,
    };
  }

  assertEventScheduleAllowed(input.schedule, input.source ?? "agent", input.name);

  const now = new Date().toISOString();
  const task: Task = {
    id,
    name: input.name,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    description: input.description,
    skill: input.skill,
    allowedTools: input.allowedTools,
    ...(input.inputSchema ? { inputSchema: input.inputSchema } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    maxIterations: input.maxIterations,
    maxInputTokens: input.maxInputTokens,
    maxRunDurationMs: input.maxRunDurationMs,
    model: input.model,
    tokenBudget: input.tokenBudget,
    enabled: input.enabled ?? true,
    source: input.source ?? "agent",
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
  };

  // Compute initial nextRunAt
  const nextRun = computeNextRunAt(task, Date.now(), ctx.defaultTimezone);
  if (nextRun !== null) {
    task.nextRunAt = new Date(nextRun).toISOString();
  }

  // Anchor the budget window at write time, exactly as nextRunAt is anchored
  // above. Without this the reset boundary is only ever seeded at the end of a
  // qualifying run, so tokens spent before that first run accumulate against
  // the budget forever (the window never rolls). Periodless budgets resolve to
  // undefined and stay lifetime-cumulative by design.
  task.budgetResetAt = budgetResetBoundary(task, ctx.defaultTimezone);

  defs.set(id, task);
  ctx.save(defs);
  ctx.reloadScheduler();

  return {
    task,
    created: true,
    message: `Task "${input.name}" created (id: ${id}).`,
  };
}

export interface UpdateResult {
  task: Task;
  updated: boolean;
  message: string;
}

/**
 * Apply a partial patch to an existing task. Field order matches
 * the `Task` declaration order in `types.ts`; iteration over this
 * array tracks the type. Do not alphabetize.
 */
const UPDATABLE_FIELDS = [
  "description",
  "prompt",
  "schedule",
  "skill",
  "allowedTools",
  "inputSchema",
  "outputSchema",
  "maxIterations",
  "maxInputTokens",
  "maxRunDurationMs",
  "model",
  "enabled",
  "tokenBudget",
] as const satisfies readonly (keyof DomainUpdatePatch)[];

/**
 * Move `nextRunAt` onto the schedule the task now has.
 *
 * A schedule with no next run (an event schedule, or a cron with no future
 * date) clears one left over from the schedule it replaced: kept, a past value
 * would stay due forever, and a moment nothing will ever act on is worse than
 * none.
 */
function reanchorNextRunAt(task: Task, defaultTimezone?: string): void {
  setNextRunAt(task, computeNextRunAt(task, Date.now(), defaultTimezone));
}

/** Patch fields where `null` deletes the key rather than storing a null. */
const CLEARABLE_FIELDS = ["schedule", "inputSchema", "outputSchema"] as const satisfies readonly (
  | keyof DomainUpdatePatch
  | keyof Task
)[];

/**
 * Copy the patch's fields onto `task`. `null` on a clearable field
 * (`schedule`, `inputSchema`, `outputSchema`) deletes the key, so a schedule
 * cleared reads as manual-only. Returns whether anything was written.
 */
function applyPatchFields(task: Task, patch: DomainUpdatePatch): boolean {
  let changed = false;
  const record = task as unknown as Record<string, unknown>;
  for (const field of UPDATABLE_FIELDS) {
    if (!(field in patch) || patch[field] === undefined) continue;
    if (patch[field] === null && (CLEARABLE_FIELDS as readonly string[]).includes(field)) {
      delete record[field];
    } else {
      record[field] = patch[field];
    }
    changed = true;
  }
  return changed;
}

/**
 * A new once time re-arms a once that already ran or missed its time: the edit
 * is the request to run it again. A paused one stays paused, and an explicit
 * `enabled: false` wins.
 */
function applyOnceRearm(task: Task, patch: DomainUpdatePatch, wasRetiredOnce: boolean): void {
  // Any new schedule (or none) ends the old occurrence's record.
  if (patch.schedule !== undefined) delete task.onceDone;
  if (!wasRetiredOnce || !isOnceSchedule(patch.schedule ?? undefined)) return;
  if (patch.enabled === false) return;
  task.enabled = true;
  task.consecutiveErrors = 0;
  task.disabledAt = undefined;
  task.disabledReason = undefined;
}

/**
 * Refuse to arm a once whose time has passed. Enabling one would fire a stale
 * action at once (or, within the grace window, fire it a second time); it
 * needs a new time.
 */
function assertOnceArmable(task: Task, patch: DomainUpdatePatch, wasEnabled: boolean): void {
  if (!task.enabled || !isOnceSchedule(task.schedule)) return;
  if (wasEnabled && patch.schedule === undefined) return;
  const at = new Date(task.schedule?.at ?? "").getTime();
  if (at > Date.now()) return;
  throw new Error(
    `Task "${task.name}" runs once at ${task.schedule?.at}, which has ` +
      "passed. Set a new time in its schedule to run it again, or use tasks__run to run it now.",
  );
}

export function updateTask(
  name: string,
  patch: DomainUpdatePatch,
  ctx: TaskDomainContext,
): UpdateResult {
  const defs = ctx.definitions();
  const task = findByName(defs, name);
  if (!task) {
    throw new Error(`Task not found: "${name}"`);
  }

  assertEventScheduleAllowed(patch.schedule ?? undefined, task.source, task.name);

  // Snapshot before the loop overwrites it — the window reset is gated on a real
  // budget change, not merely a write (see `tokenBudgetsEqual`).
  const prevTokenBudget = task.tokenBudget;
  const wasEnabled = task.enabled;
  const wasRetiredOnce = onceRetirement(task) !== null;

  const changed = applyPatchFields(task, patch);
  applyOnceRearm(task, patch, wasRetiredOnce);
  assertOnceArmable(task, patch, wasEnabled);

  // Clear disable state when re-enabling
  if (patch.enabled === true) {
    task.consecutiveErrors = 0;
    task.disabledAt = undefined;
    task.disabledReason = undefined;
    // A past `nextRunAt` the schedule really fires at reads as a run still owed
    // (the scheduler keeps one deferred at its concurrency limit). One kept
    // through a pause is not owed: a one-off paused before its date and resumed
    // after it would fire the stale action at once. A recurring schedule keeps
    // its past value and catches up once, as it always has.
    if (!wasEnabled && computeNextRunAt(task, Date.now(), ctx.defaultTimezone) === null) {
      setNextRunAt(task, null);
    }
  }

  if (changed) {
    task.updatedAt = new Date().toISOString();

    if ("schedule" in patch) reanchorNextRunAt(task, ctx.defaultTimezone);

    // A CHANGED budget starts a fresh accounting window (cf. the nextRunAt
    // recompute on a schedule change above): spend from the prior budget must
    // not count against the new ceiling.
    resetBudgetWindowIfChanged(task, prevTokenBudget, patch.tokenBudget, ctx.defaultTimezone);

    defs.set(task.id, task);
    ctx.save(defs);
    ctx.reloadScheduler();
  }

  return {
    task,
    updated: changed,
    message: changed ? `Task "${name}" updated.` : `No changes applied to "${name}".`,
  };
}

export interface DeleteResult {
  deleted: boolean;
  id: string;
  message: string;
}

export function deleteTask(name: string, ctx: TaskDomainContext): DeleteResult {
  const defs = ctx.definitions();
  const task = findByName(defs, name);
  if (!task) {
    throw new Error(`Task not found: "${name}"`);
  }

  defs.delete(task.id);
  ctx.save(defs);
  ctx.reloadScheduler();

  return {
    deleted: true,
    id: task.id,
    message: `Task "${name}" deleted. Run history preserved.`,
  };
}
