import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

/**
 * Canonical list of usage breakdown dimensions. Single source of truth —
 * the TypeBox enum, the `UsageGroupBy` type, and the aggregator's runtime
 * guard (`src/usage/aggregate.ts`) all derive from this array
 * so a new dimension is added in exactly one place.
 */
export const USAGE_GROUP_BYS = [
  "day",
  "conversation",
  "turn",
  "model",
  "user",
  "origin",
  "provider",
  "workspace",
] as const;

/**
 * The dimensions a `day` row can be split by (`stackBy`). Only the
 * low-cardinality ones: a day row carries one entry per key, so an id-keyed
 * dimension (`conversation`, `turn`) would multiply the row count by the
 * tenant's whole history.
 */
export const USAGE_STACK_BYS = ["model", "user", "origin", "provider", "workspace"] as const;

/** Who a call was for. Mirrors `LlmCallOrigin` in `src/usage/types.ts`. */
export const USAGE_ORIGINS = ["chat", "task", "system"] as const;

const UsageGroupBy = StringEnum(USAGE_GROUP_BYS, {
  description:
    "Group breakdown. Default: day. `user` buckets by the caller (org scope); " +
    "`origin` splits interactive chat from task runs; `turn` buckets by a single " +
    "assistant turn and is the finest grain here, so narrow the period before reaching for " +
    "it; `provider` buckets by " +
    "the model string's provider prefix; `workspace` buckets by the workspace the call was " +
    'bound to (`"none"` for a call bound to none).',
});

export const UsageReportInput = Type.Object({
  scope: Type.Optional(
    StringEnum(["user", "org"] as const, {
      description:
        "Aggregation scope. `user` (default) reports only the caller's own conversations. " +
        "`org` reports every user's conversations and requires org admin/owner — pair with " +
        '`groupBy: "user"` for a per-user breakdown.',
    }),
  ),
  period: Type.Optional(
    StringEnum(["day", "week", "month", "all"] as const, {
      description:
        "Time period, in UTC days ending today. `day` is today, `week` the last 7 days " +
        "including today, `month` the month to date. Default: month.",
    }),
  ),
  from: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD). Overrides period." })),
  to: Type.Optional(Type.String({ description: "End date (YYYY-MM-DD). Default: today." })),
  groupBy: Type.Optional(
    Type.Union([
      UsageGroupBy,
      Type.Array(UsageGroupBy, {
        minItems: 1,
        description:
          'Multiple breakdowns to compute in one aggregation scan, e.g. ["user", "day"].',
      }),
    ]),
  ),
  stackBy: Type.Optional(
    StringEnum(USAGE_STACK_BYS, {
      description:
        "With `day` in `groupBy`, also split each day row's cost by this dimension, " +
        "returned as `stack` on the row. For a stacked daily chart.",
    }),
  ),
  workspaceId: Type.Optional(
    Type.String({
      minLength: 1,
      description: 'Only calls bound to this workspace. `"none"` selects calls bound to none.',
    }),
  ),
  userId: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Only calls made by this user. Requires `scope: "org"` for anyone but the caller.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Only calls to this model: either the qualified string or the short name the " +
        "report's `models` rows use.",
    }),
  ),
  origin: Type.Optional(
    StringEnum(USAGE_ORIGINS, {
      description: "Only calls with this origin: `chat`, `task` (task runs), or `system`.",
    }),
  ),
});
export type UsageReportInput = Static<typeof UsageReportInput>;

export type UsageGroupBy = (typeof USAGE_GROUP_BYS)[number];
export type UsageStackBy = (typeof USAGE_STACK_BYS)[number];
export type UsageOrigin = (typeof USAGE_ORIGINS)[number];

// ── Output types (§2.1) ────────────────────────────────────────────────
//
// The handler's structuredContent IS the contract. These mirror the
// `UsageReport` shape produced by `src/usage/aggregate.ts`;
// keep them in lockstep with that module. Type-only (we don't wire-validate
// outputs) — the named export is what every consumer (web shell, CLI,
// tests) imports so a rename surfaces as a compile error rather than a
// silent UI break.

export interface UsageTokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageCostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageModelEntry {
  model: string;
  tokens: UsageTokenBreakdown;
  cost: UsageCostBreakdown;
  llmCalls: number;
  /** Input-side cache-hit rate (0–1). See `computeCacheHitRate` in the aggregator. */
  cacheHitRate?: number;
}

export interface UsageBreakdownEntry {
  key: string;
  tokens: UsageTokenBreakdown;
  cost: UsageCostBreakdown;
  llmCalls: number;
  /** Distinct chat conversations. Task runs are counted by `runs`, as in `totals`. */
  conversations: number;
  /** Distinct task runs in this bucket. Present only when non-zero. */
  runs?: number;
  /** Calls with no resolvable price. Present only when non-zero. See `totals`. */
  unpricedCalls?: number;
  /** Input-side cache-hit rate (0–1). See `computeCacheHitRate` in the aggregator. */
  cacheHitRate?: number;
  /**
   * Cost total (USD) per key of the requested `stackBy` dimension. On `day`
   * rows only, only when `stackBy` was set, and only keys with spend that day.
   */
  stack?: Record<string, number>;
}

export interface UsageReportOutput {
  /** Echoes the resolved scope so consumers know whether this is a self or org view. */
  scope: "user" | "org";
  period: { from: string; to: string };
  totals: {
    tokens: UsageTokenBreakdown;
    cost: UsageCostBreakdown;
    llmCalls: number;
    llmMs: number;
    /** Distinct chat conversations. Task runs are counted by `runs`. */
    conversations: number;
    /** Distinct task runs — tasks, which have no conversation to count. */
    runs?: number;
    /**
     * Calls no price could be found for. Present only when non-zero.
     *
     * Their tokens are in the totals and their cost is not, so this says the
     * dollar figure is incomplete — as distinct from a spend of zero, which a
     * bare `$0.00` beside a large token count would otherwise imply.
     */
    unpricedCalls?: number;
    /** Input-side cache-hit rate (0–1). See `computeCacheHitRate` in the aggregator. */
    cacheHitRate?: number;
  };
  models: UsageModelEntry[];
  breakdown: UsageBreakdownEntry[];
  breakdowns: Partial<Record<UsageGroupBy, UsageBreakdownEntry[]>>;
  /**
   * Dimensions whose breakdown was capped at the costliest rows, with how many
   * rows exist in full. Absent when every breakdown is complete — so its
   * presence is the signal that a row list is a top-N view and must not be
   * read as the whole set. `totals` is unaffected: it counts every record,
   * capped rows included, so no spend is missing from the report.
   */
  truncatedBreakdowns?: Partial<Record<UsageGroupBy, { returned: number; total: number }>>;
}
