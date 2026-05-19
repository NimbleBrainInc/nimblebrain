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
 * This module bridges the two sides at compile time. Each `_DriftCheck`
 * type alias below uses a constrained generic (`AssertAssignable<A
 * extends B, B>`) — the constraint fails to satisfy when A isn't
 * assignable to B, surfacing as a TS2344 error on the alias
 * declaration. `bun run check` validates this file as part of the
 * standard CI gate — any drift between the canonical types and the
 * schema types surfaces as a build failure here, not as a silent
 * disagreement at consumer call sites.
 *
 * When you change `Automation` or `AutomationRun` (or their nested
 * `ScheduleSpec` / `TokenBudget`) and this file fails to compile, the
 * matching schema type in `schemas/automations.ts` needs an update.
 * Treat it like a database migration — shape moves and consumers move
 * together, not separately.
 *
 * Zero runtime emission. Type aliases are fully erased; this file
 * compiles to an empty module.
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
 * Constrained-generic assertion. `A extends B` is checked at the
 * declaration site; if A isn't assignable to B, TypeScript emits a
 * TS2344 "Type X does not satisfy the constraint Y" error and the
 * alias fails to compile. `unknown` body — the alias's value type
 * doesn't matter, only that the constraint typechecks.
 */
type AssertAssignable<_A extends B, B> = unknown;

/**
 * Companion assertion: the constraint `_T extends never` succeeds only
 * when `_T` is `never`. Used with `Exclude<...>` to assert that a
 * schema mirror declares no fields beyond what's on the canonical
 * type plus an explicit overlay set. Failure surfaces as TS2344 with
 * the unexpected field name in the error message.
 */
type AssertNever<_T extends never> = unknown;

// Each `Drift*` alias below is a compile-time constraint check. They're
// `export`ed only to satisfy `noUnusedLocals` — the architectural value
// is the constraint being typechecked, not the alias value. A constraint
// failure surfaces as a TS2344 right here.
//
// TWO complementary checks per mirror that has overlay fields:
//
//   1. SHARED-FIELDS bidirectional assignability via `keyof A & keyof B`
//      catches type drift on fields present on both sides. Auto-derived:
//      any new shared field gets included on the next build.
//
//   2. UNEXPECTED-FIELDS via `Exclude<keyof schema, keyof canonical |
//      overlays>` catches schema fields that don't exist on canonical
//      and aren't in the explicit overlay list. This is the symmetric
//      catch: if a field is removed from canonical, the intersection
//      shrinks silently, but THIS check fails because the schema still
//      has it. Forces the maintainer to either delete from the schema
//      or add to overlays explicitly.
//
// Combined, these catch every divergence mode (new fields, removed
// fields, type drift) with one explicit maintenance artifact: the
// overlay list per type. Each entry in that list is a conscious
// decision (handler coerces / formats / computes the field).

// AutomationRunRecord ↔ AutomationRun — bidirectional structural mirror,
// no overlays.
export type DriftRunRecordA = AssertAssignable<AutomationRunRecord, AutomationRun>;
export type DriftRunRecordB = AssertAssignable<AutomationRun, AutomationRunRecord>;

// AutomationScheduleSpec ↔ ScheduleSpec — identical structural mirror.
export type DriftScheduleA = AssertAssignable<AutomationScheduleSpec, ScheduleSpec>;
export type DriftScheduleB = AssertAssignable<ScheduleSpec, AutomationScheduleSpec>;

// AutomationTokenBudget ↔ TokenBudget — identical structural mirror.
export type DriftTokenBudgetA = AssertAssignable<AutomationTokenBudget, TokenBudget>;
export type DriftTokenBudgetB = AssertAssignable<TokenBudget, AutomationTokenBudget>;

// AutomationStatusDetail — overlays are: handler-computed display
// strings, computed cost numbers, and `undefined` → `null` coercions
// on a few optional fields.
type StatusOverlay =
  | "scheduleHuman"
  | "lastRunAtHuman"
  | "nextRunAtHuman"
  | "actualCostUsd"
  | "estimatedCostPerRun"
  | "estimatedCostPerDay"
  | "estimatedCostPerMonth"
  | "tokenBudget" // canonical: `TokenBudget | undefined`, schema: `... | null`
  | "budgetResetAt"; // canonical: `string | undefined`, schema: `... | null`
type StatusShared = Exclude<keyof Automation & keyof AutomationStatusDetail, StatusOverlay>;
export type DriftStatusSharedA = AssertAssignable<
  Pick<AutomationStatusDetail, StatusShared>,
  Pick<Automation, StatusShared>
>;
export type DriftStatusSharedB = AssertAssignable<
  Pick<Automation, StatusShared>,
  Pick<AutomationStatusDetail, StatusShared>
>;
type StatusUnexpected = Exclude<keyof AutomationStatusDetail, keyof Automation | StatusOverlay>;
export type DriftStatusUnexpected = AssertNever<StatusUnexpected>;

// AutomationSummary — overlays are: derived fields (cost estimate),
// formatted fields (schedule rendered to string, timestamps to relative
// strings), and coerced optionals (`disabledAt`, `disabledReason`,
// `lastRunStatus` get the `?? null` treatment).
type SummaryOverlay =
  | "schedule"
  | "lastRunAt"
  | "nextRunAt"
  | "lastRunStatus"
  | "disabledAt"
  | "disabledReason"
  | "estimatedCostPerDay";
type SummaryShared = Exclude<keyof Automation & keyof AutomationSummary, SummaryOverlay>;
export type DriftSummarySharedA = AssertAssignable<
  Pick<AutomationSummary, SummaryShared>,
  Pick<Automation, SummaryShared>
>;
export type DriftSummarySharedB = AssertAssignable<
  Pick<Automation, SummaryShared>,
  Pick<AutomationSummary, SummaryShared>
>;
type SummaryUnexpected = Exclude<keyof AutomationSummary, keyof Automation | SummaryOverlay>;
export type DriftSummaryUnexpected = AssertNever<SummaryUnexpected>;
