/**
 * Automations domain API — internal CRUD operations on Automations.
 *
 * The LLM-facing tool handlers (`handleCreate` / `handleUpdate` /
 * `handleDelete` in `server.ts`) are thin schema-translators that
 * delegate here. Internal callers — the bundle lifecycle
 * (bundle-contributed schedules) — call this
 * module directly. No callers go through the LLM-facing schema except
 * the LLM itself.
 *
 * Why split this out:
 *
 *   - The LLM-facing schema must be minimal (no `source`, no `bundleName`,
 *     no `allowedTools`) — operator/runtime fields only.
 *   - But internal callers legitimately need to set those fields. The
 *     bundle install path must stamp `source: "bundle"` and `bundleName`,
 *     otherwise uninstall can't find what to clean up.
 *   - Without this split, internal callers either (a) pass the wrong
 *     shape and silently no-op, or (b) sneak operator fields back into
 *     the LLM-facing schema. Both happened in QA review of #127.
 *
 * The convention for the wider codebase: any time the same domain has
 * both LLM-facing and internal callers, factor a domain module that
 * accepts the full shape. The tool handler becomes a thin wrapper that
 * narrows the input.
 *
 * See `src/tools/platform/CLAUDE.md` § 1.4 for the cross-cutting rule.
 */

import { computeBudgetResetAt, computeNextRunAt } from "./scheduler.ts";
import type { Automation, AutomationSource, ScheduleSpec, TokenBudget } from "./types.ts";

// ---------------------------------------------------------------------------
// Domain context — the minimum each operation needs
// ---------------------------------------------------------------------------

/**
 * What the domain needs to read/write the automation store and trigger
 * scheduler reloads. Both the platform source's `ToolContext` and the
 * runtime's `getAutomationsApi()` helper satisfy this shape.
 */
export interface AutomationDomainContext {
  definitions: () => Map<string, Automation>;
  save: (defs: Map<string, Automation>) => void;
  reloadScheduler: () => void;
  defaultTimezone: string;
}

/**
 * The forward budget-reset boundary for an automation's current `tokenBudget`,
 * or `undefined` for a periodless (lifetime) budget. Anchored at write time so
 * the scheduler's window can roll from the first run rather than being seeded
 * lazily at end-of-run (which left pre-budget spend counting forever).
 */
function budgetResetBoundary(automation: Automation, defaultTimezone?: string): string | undefined {
  const period = automation.tokenBudget?.period;
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
  automation: Automation,
  prev: TokenBudget | undefined,
  next: TokenBudget | undefined,
  defaultTimezone?: string,
): void {
  if (next === undefined || tokenBudgetsEqual(prev, next)) return;
  automation.cumulativeInputTokens = 0;
  automation.cumulativeOutputTokens = 0;
  automation.budgetResetAt = budgetResetBoundary(automation, defaultTimezone);
}

// ---------------------------------------------------------------------------
// Input shapes — the full domain shape, including operator-only fields
// ---------------------------------------------------------------------------

/**
 * Full create input for the domain. Includes operator-only fields the
 * LLM-facing schema does NOT expose: `source`, `bundleName`,
 * `allowedTools`, `ownerId`, `workspaceId`. The tool handler hardcodes
 * `source: "agent"` and derives ownership from request context; the
 * lifecycle layer sets `source: "bundle"` plus `bundleName`.
 */
export interface DomainCreateInput {
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  description?: string;
  skill?: string;
  model?: string;
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  tokenBudget?: TokenBudget;
  enabled?: boolean;
  // Operator/runtime fields:
  source?: AutomationSource;
  bundleName?: string;
  allowedTools?: string[];
  ownerId?: string;
  workspaceId?: string;
}

/** Patch shape for update. Every field optional. */
export interface DomainUpdatePatch {
  description?: string;
  schedule?: ScheduleSpec;
  prompt?: string;
  skill?: string;
  model?: string;
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  tokenBudget?: TokenBudget;
  enabled?: boolean;
  // Operator-only:
  allowedTools?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toKebabCase(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function findByName(defs: Map<string, Automation>, name: string): Automation | undefined {
  // Match either the kebab-case id or the human-readable name (case-sensitive).
  const id = toKebabCase(name);
  return defs.get(id) ?? Array.from(defs.values()).find((a) => a.name === name);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateResult {
  automation: Automation;
  created: boolean;
  message: string;
}

export function createAutomation(
  input: DomainCreateInput,
  ctx: AutomationDomainContext,
): CreateResult {
  const id = toKebabCase(input.name);
  const defs = ctx.definitions();

  // Idempotent: return existing if same id.
  const existing = defs.get(id);
  if (existing) {
    return {
      automation: existing,
      created: false,
      message: `Automation "${input.name}" already exists (id: ${id}). Returning existing.`,
    };
  }

  const now = new Date().toISOString();
  const automation: Automation = {
    id,
    name: input.name,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    schedule: input.schedule,
    description: input.description,
    skill: input.skill,
    allowedTools: input.allowedTools,
    maxIterations: input.maxIterations,
    maxInputTokens: input.maxInputTokens,
    maxRunDurationMs: input.maxRunDurationMs,
    model: input.model,
    tokenBudget: input.tokenBudget,
    enabled: input.enabled ?? true,
    source: input.source ?? "agent",
    bundleName: input.bundleName,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
  };

  // Compute initial nextRunAt
  const nextRun = computeNextRunAt(automation, Date.now(), ctx.defaultTimezone);
  if (nextRun !== null) {
    automation.nextRunAt = new Date(nextRun).toISOString();
  }

  // Anchor the budget window at write time, exactly as nextRunAt is anchored
  // above. Without this the reset boundary is only ever seeded at the end of a
  // qualifying run, so tokens spent before that first run accumulate against
  // the budget forever (the window never rolls). Periodless budgets resolve to
  // undefined and stay lifetime-cumulative by design.
  automation.budgetResetAt = budgetResetBoundary(automation, ctx.defaultTimezone);

  defs.set(id, automation);
  ctx.save(defs);
  ctx.reloadScheduler();

  return {
    automation,
    created: true,
    message: `Automation "${input.name}" created (id: ${id}).`,
  };
}

export interface UpdateResult {
  automation: Automation;
  updated: boolean;
  message: string;
}

/**
 * Apply a partial patch to an existing automation. Field order matches
 * the `Automation` declaration order in `types.ts`; iteration over this
 * array tracks the type. Do not alphabetize.
 */
const UPDATABLE_FIELDS = [
  "description",
  "prompt",
  "schedule",
  "skill",
  "allowedTools",
  "maxIterations",
  "maxInputTokens",
  "maxRunDurationMs",
  "model",
  "enabled",
  "tokenBudget",
] as const satisfies readonly (keyof DomainUpdatePatch)[];

export function updateAutomation(
  name: string,
  patch: DomainUpdatePatch,
  ctx: AutomationDomainContext,
): UpdateResult {
  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  // Snapshot before the loop overwrites it — the window reset is gated on a real
  // budget change, not merely a write (see `tokenBudgetsEqual`).
  const prevTokenBudget = automation.tokenBudget;

  let changed = false;
  for (const field of UPDATABLE_FIELDS) {
    if (field in patch && patch[field] !== undefined) {
      (automation as unknown as Record<string, unknown>)[field] = patch[field];
      changed = true;
    }
  }

  // Clear disable state when re-enabling
  if (patch.enabled === true) {
    automation.consecutiveErrors = 0;
    automation.disabledAt = undefined;
    automation.disabledReason = undefined;
  }

  if (changed) {
    automation.updatedAt = new Date().toISOString();

    // Recompute nextRunAt if schedule changed
    if ("schedule" in patch) {
      const nextRun = computeNextRunAt(automation, Date.now(), ctx.defaultTimezone);
      if (nextRun !== null) {
        automation.nextRunAt = new Date(nextRun).toISOString();
      }
    }

    // A CHANGED budget starts a fresh accounting window (cf. the nextRunAt
    // recompute on a schedule change above): spend from the prior budget must
    // not count against the new ceiling.
    resetBudgetWindowIfChanged(automation, prevTokenBudget, patch.tokenBudget, ctx.defaultTimezone);

    defs.set(automation.id, automation);
    ctx.save(defs);
    ctx.reloadScheduler();
  }

  return {
    automation,
    updated: changed,
    message: changed ? `Automation "${name}" updated.` : `No changes applied to "${name}".`,
  };
}

export interface DeleteResult {
  deleted: boolean;
  id: string;
  message: string;
}

export function deleteAutomation(name: string, ctx: AutomationDomainContext): DeleteResult {
  const defs = ctx.definitions();
  const automation = findByName(defs, name);
  if (!automation) {
    throw new Error(`Automation not found: "${name}"`);
  }

  defs.delete(automation.id);
  ctx.save(defs);
  ctx.reloadScheduler();

  return {
    deleted: true,
    id: automation.id,
    message: `Automation "${name}" deleted. Run history preserved.`,
  };
}
