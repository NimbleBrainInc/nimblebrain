import { type Static, type TOptional, type TSchema, Type } from "@sinclair/typebox";
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
        "`org` reports every user's conversations and requires org admin — pair with " +
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

// ── Output schemas (§2.1) ──────────────────────────────────────────────
//
// What `usage__report` returns: the `UsageReport` the aggregator
// (`src/usage/aggregate.ts`) produces, with the resolved `scope`. The SDK
// client checks each success against `UsageReportOutput`, so the two stay in
// lockstep or the call fails. Every field is derived by the aggregator rather
// than copied from a ledger line, from the fields every line carries (`ts`,
// `origin`, `model`, the two token totals, `llmMs`; see `UsageLedgerEntry`),
// so the shape does not vary with the age of the lines it reads. A breakdown
// `key` is a free string: a day, a model, an id, or `"none"` / `"unknown"` for
// an absent one.

const Count = (description?: string) =>
  Type.Integer({ minimum: 0, ...(description ? { description } : {}) });

const CacheHitRate = Type.Number({
  description: "Input-side cache-hit rate (0–1). See `computeCacheHitRate` in the aggregator.",
});

export const UsageTokenBreakdown = Type.Object({
  /** Non-cached input tokens. */
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
});
export type UsageTokenBreakdown = Static<typeof UsageTokenBreakdown>;

/** Cost in USD per token bucket, and their sum. */
export const UsageCostBreakdown = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  total: Type.Number(),
});
export type UsageCostBreakdown = Static<typeof UsageCostBreakdown>;

export const UsageModelEntry = Type.Object({
  /** The model string with its provider prefix and date suffix stripped. */
  model: Type.String(),
  tokens: UsageTokenBreakdown,
  cost: UsageCostBreakdown,
  llmCalls: Count(),
  cacheHitRate: Type.Optional(CacheHitRate),
});
export type UsageModelEntry = Static<typeof UsageModelEntry>;

export const UsageBreakdownEntry = Type.Object({
  key: Type.String(),
  tokens: UsageTokenBreakdown,
  cost: UsageCostBreakdown,
  llmCalls: Count(),
  conversations: Count(
    "Distinct chat conversations. Task runs are counted by `runs`, as in `totals`.",
  ),
  runs: Type.Optional(Count("Distinct task runs in this bucket. Present only when non-zero.")),
  unpricedCalls: Type.Optional(
    Count("Calls with no resolvable price. Present only when non-zero. See `totals`."),
  ),
  cacheHitRate: Type.Optional(CacheHitRate),
  stack: Type.Optional(
    Type.Record(Type.String(), Type.Number(), {
      description:
        "Cost total (USD) per key of the requested `stackBy` dimension. On `day` rows only, " +
        "only when `stackBy` was set, and only keys with spend that day.",
    }),
  ),
});
export type UsageBreakdownEntry = Static<typeof UsageBreakdownEntry>;

/** How many rows a capped breakdown returned, of how many exist. */
const UsageBreakdownTruncation = Type.Object({
  returned: Count(),
  total: Count(),
});

// One optional property per dimension. A `Type.Record` keyed by a `StringEnum`
// compiles to `{ not: {} }`, so the keys are spelled out instead.
function ByGroupBy<T extends TSchema>(value: T, options: { description?: string } = {}) {
  return Type.Object(
    Object.fromEntries(
      USAGE_GROUP_BYS.map((k) => [k, Type.Optional(value) as TOptional<T>]),
    ) as Record<UsageGroupBy, TOptional<T>>,
    options,
  );
}

export const UsageReportOutput = Type.Object({
  scope: StringEnum(["user", "org"] as const, {
    description: "Echoes the resolved scope, so a consumer knows a self view from an org view.",
  }),
  period: Type.Object({ from: Type.String(), to: Type.String() }),
  totals: Type.Object({
    tokens: UsageTokenBreakdown,
    cost: UsageCostBreakdown,
    llmCalls: Count(),
    llmMs: Type.Number(),
    conversations: Count("Distinct chat conversations. Task runs are counted by `runs`."),
    runs: Type.Optional(Count("Distinct task runs, which have no conversation to count.")),
    unpricedCalls: Type.Optional(
      Count(
        "Calls no price could be found for. Present only when non-zero. Their tokens are in " +
          "the totals and their cost is not, so this says the dollar figure is incomplete " +
          "rather than the spend being zero.",
      ),
    ),
    cacheHitRate: Type.Optional(CacheHitRate),
  }),
  models: Type.Array(UsageModelEntry),
  breakdown: Type.Array(UsageBreakdownEntry, {
    description: "The rows of the first requested `groupBy` dimension.",
  }),
  breakdowns: ByGroupBy(Type.Array(UsageBreakdownEntry), {
    description: "The rows of every requested `groupBy` dimension, by dimension.",
  }),
  truncatedBreakdowns: Type.Optional(
    ByGroupBy(UsageBreakdownTruncation, {
      description:
        "Dimensions whose breakdown was capped at the costliest rows, with how many rows " +
        "exist in full. Absent when every breakdown is complete, so its presence says a row " +
        "list is a top-N view. `totals` counts every record, capped rows included.",
    }),
  ),
});
export type UsageReportOutput = Static<typeof UsageReportOutput>;
