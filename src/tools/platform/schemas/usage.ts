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
  "model",
  "user",
  "origin",
  "provider",
] as const;

const UsageGroupBy = StringEnum(USAGE_GROUP_BYS, {
  description:
    "Group breakdown. Default: day. `user` buckets by the caller (org scope); " +
    "`origin` splits interactive chat from automation runs; `provider` buckets by " +
    "the model string's provider prefix.",
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
      description: "Time period. Default: month.",
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
});
export type UsageReportInput = Static<typeof UsageReportInput>;

export type UsageGroupBy = (typeof USAGE_GROUP_BYS)[number];

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
  conversations: number;
  /** Input-side cache-hit rate (0–1). See `computeCacheHitRate` in the aggregator. */
  cacheHitRate?: number;
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
    /** Distinct task runs — automations, which have no conversation to count. */
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
}
