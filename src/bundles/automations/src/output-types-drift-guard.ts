/**
 * Compile-time drift guard for automation output types.
 *
 * The output types in `src/tools/platform/schemas/automations.ts`
 * (`AutomationSummary`, `AutomationStatusDetail`, `AutomationRunRecord`,
 * etc.) are STRUCTURAL MIRRORS of the canonical `Automation` /
 * `AutomationRun` / `ScheduleSpec` / `TokenBudget` types in `./types.ts`.
 * They're duplicated because the schemas tree is self-contained for the
 * web codegen (`scripts/codegen-web-platform-schemas.ts` pins `rootDir`
 * to `schemas/`; cross-tree imports break the boundary).
 *
 * This module bridges the two sides at compile time. Each `assignable<A,
 * B>()` declaration is a constraint that fails to type-check if A isn't
 * assignable to B. `bun run check` (via `tsconfig.json`) validates this
 * file as part of the standard CI gate — any drift between the canonical
 * types and the schema types surfaces as a build failure here, not as a
 * silent disagreement at consumer call sites.
 *
 * When you change `Automation` or `AutomationRun` (or their nested
 * `ScheduleSpec` / `TokenBudget`) and this file fails to compile, the
 * matching schema type in `schemas/automations.ts` needs an update.
 * Treat it like a database migration — shape moves and consumers move
 * together, not separately.
 *
 * This file has no runtime exports. The `void` calls below are the
 * only emitted runtime work and exist solely to anchor the type-level
 * constraints to a declaration TypeScript checks.
 */

import type {
  AutomationRunRecord,
  AutomationScheduleSpec,
  AutomationStatusDetail,
  AutomationSummary,
  AutomationTokenBudget,
} from "../../../tools/platform/schemas/automations.ts";
import type { Automation, AutomationRun, ScheduleSpec, TokenBudget } from "./types.ts";

/**
 * Pure type-level constraint helper. The signature requires `A extends B`,
 * so calling `assignable<A, B>()` succeeds only when A is assignable to
 * B; it fails to compile otherwise. The function body is a no-op — we
 * only care about the type signature triggering the check.
 */
function assignable<_A extends B, B>(): void {
  /* type-level constraint only */
}

// AutomationRunRecord ↔ AutomationRun — every field on the schema mirror
// must exist on the canonical type with a compatible shape, and vice
// versa for the fields the canonical type actually exposes.
assignable<AutomationRunRecord, AutomationRun>();
assignable<AutomationRun, AutomationRunRecord>();

// AutomationScheduleSpec ↔ ScheduleSpec — identical structural mirror.
assignable<AutomationScheduleSpec, ScheduleSpec>();
assignable<ScheduleSpec, AutomationScheduleSpec>();

// AutomationTokenBudget ↔ TokenBudget — identical structural mirror.
assignable<AutomationTokenBudget, TokenBudget>();
assignable<TokenBudget, AutomationTokenBudget>();

// AutomationStatusDetail core — the fields it shares with Automation
// must match in both directions. Overlay fields (humanized strings,
// null-coerced optionals, cost numbers) are intentionally asymmetric
// and excluded from the check; the canonical Automation fields are
// strict.
type AutomationCoreFields = Pick<
  Automation,
  | "id"
  | "name"
  | "description"
  | "prompt"
  | "enabled"
  | "source"
  | "bundleName"
  | "ownerId"
  | "workspaceId"
  | "model"
  | "skill"
  | "allowedTools"
  | "maxIterations"
  | "maxInputTokens"
  | "maxRunDurationMs"
  | "runCount"
  | "consecutiveErrors"
  | "cumulativeInputTokens"
  | "cumulativeOutputTokens"
  | "lastRunAt"
  | "lastRunStatus"
  | "nextRunAt"
  | "disabledAt"
  | "disabledReason"
  | "createdAt"
  | "updatedAt"
>;
type DetailCoreFields = Pick<AutomationStatusDetail, keyof AutomationCoreFields>;
assignable<DetailCoreFields, AutomationCoreFields>();
assignable<AutomationCoreFields, DetailCoreFields>();

// AutomationSummary — must exist on Automation as a subset (the list
// view derives every field except humanized strings and the cost
// estimate from the stored Automation).
type SummaryDerivable = Pick<Automation, "id" | "name" | "description" | "enabled" | "runCount">;
type SummarySubset = Pick<AutomationSummary, keyof SummaryDerivable>;
assignable<SummarySubset, SummaryDerivable>();
assignable<SummaryDerivable, SummarySubset>();
