/**
 * Compile-time drift guard for task output types.
 *
 * The output types in `src/platform/schemas/tasks.ts`
 * (`TaskRecord`, `TaskSummary`, `TaskStatusDetail`,
 * `TaskRunRecord`, etc.) are STRUCTURAL MIRRORS of the canonical `Task` /
 * `TaskRun` / `ScheduleSpec` / `TokenBudget` types in `./types.ts`.
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
 * When you change `Task` or `TaskRun` (or their nested
 * `ScheduleSpec` / `TokenBudget`) and this file fails to compile, the
 * matching schema type in `schemas/tasks.ts` needs an update.
 * Treat it like a database migration — shape moves and consumers move
 * together, not separately.
 *
 * Zero runtime emission. Type aliases are fully erased; this file
 * compiles to an empty module.
 */

import type {
  TaskBatchRecord,
  TaskRecord,
  TaskRunRecord,
  TaskScheduleSpec,
  TaskStatusDetail,
  TaskSummary,
  TaskTokenBudget,
} from "../schemas/tasks.ts";
import type { Batch, ScheduleSpec, Task, TaskRun, TokenBudget } from "./types.ts";

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

// TaskRunRecord ↔ TaskRun — bidirectional structural mirror,
// no overlays.
export type DriftRunRecordA = AssertAssignable<TaskRunRecord, TaskRun>;
export type DriftRunRecordB = AssertAssignable<TaskRun, TaskRunRecord>;

// TaskBatchRecord ↔ Batch — bidirectional structural mirror, no overlays.
export type DriftBatchA = AssertAssignable<TaskBatchRecord, Batch>;
export type DriftBatchB = AssertAssignable<Batch, TaskBatchRecord>;
type BatchUnexpected = Exclude<keyof TaskBatchRecord, keyof Batch>;
export type DriftBatchUnexpected = AssertNever<BatchUnexpected>;
type BatchMissing = Exclude<keyof Batch, keyof TaskBatchRecord>;
export type DriftBatchMissing = AssertNever<BatchMissing>;

// TaskRecord ↔ Task — bidirectional structural mirror, no
// overlays: create and update return the stored task as-is.
export type DriftRecordA = AssertAssignable<TaskRecord, Task>;
export type DriftRecordB = AssertAssignable<Task, TaskRecord>;

// TaskScheduleSpec ↔ ScheduleSpec — identical structural mirror.
export type DriftScheduleA = AssertAssignable<TaskScheduleSpec, ScheduleSpec>;
export type DriftScheduleB = AssertAssignable<ScheduleSpec, TaskScheduleSpec>;

// TaskTokenBudget ↔ TokenBudget — identical structural mirror.
export type DriftTokenBudgetA = AssertAssignable<TaskTokenBudget, TokenBudget>;
export type DriftTokenBudgetB = AssertAssignable<TokenBudget, TaskTokenBudget>;

// TaskStatusDetail — overlays are: handler-computed display
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
type StatusShared = Exclude<keyof Task & keyof TaskStatusDetail, StatusOverlay>;
export type DriftStatusSharedA = AssertAssignable<
  Pick<TaskStatusDetail, StatusShared>,
  Pick<Task, StatusShared>
>;
export type DriftStatusSharedB = AssertAssignable<
  Pick<Task, StatusShared>,
  Pick<TaskStatusDetail, StatusShared>
>;
type StatusUnexpected = Exclude<keyof TaskStatusDetail, keyof Task | StatusOverlay>;
export type DriftStatusUnexpected = AssertNever<StatusUnexpected>;

// TaskSummary — overlays are: derived fields (cost estimate, the
// schedule's type), formatted fields (schedule rendered to string, timestamps
// to relative strings), and coerced optionals (`disabledAt`, `disabledReason`,
// `lastRunStatus` get the `?? null` treatment; an absent `kind` reads `saved`).
type SummaryOverlay =
  | "schedule"
  | "scheduleType"
  | "kind"
  | "lastRunAt"
  | "nextRunAt"
  | "lastRunStatus"
  | "disabledAt"
  | "disabledReason"
  | "estimatedCostPerDay";
type SummaryShared = Exclude<keyof Task & keyof TaskSummary, SummaryOverlay>;
export type DriftSummarySharedA = AssertAssignable<
  Pick<TaskSummary, SummaryShared>,
  Pick<Task, SummaryShared>
>;
export type DriftSummarySharedB = AssertAssignable<
  Pick<Task, SummaryShared>,
  Pick<TaskSummary, SummaryShared>
>;
type SummaryUnexpected = Exclude<keyof TaskSummary, keyof Task | SummaryOverlay>;
export type DriftSummaryUnexpected = AssertNever<SummaryUnexpected>;
