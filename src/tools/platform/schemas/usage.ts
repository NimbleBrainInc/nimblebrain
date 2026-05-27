import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

const UsageGroupBy = StringEnum(["day", "conversation", "model", "user"] as const, {
  description: "Group breakdown. Default: day. `user` buckets by conversation owner (org scope).",
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

export type UsageGroupBy = "day" | "conversation" | "model" | "user";

// ── Output types (§2.1) ────────────────────────────────────────────────
//
// The handler's structuredContent IS the contract. These mirror the
// `UsageReport` shape produced by `src/conversation/usage-aggregator.ts`;
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
}

export interface UsageBreakdownEntry {
  key: string;
  tokens: UsageTokenBreakdown;
  cost: UsageCostBreakdown;
  llmCalls: number;
  conversations: number;
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
    conversations: number;
  };
  models: UsageModelEntry[];
  breakdown: UsageBreakdownEntry[];
  breakdowns: Partial<Record<UsageGroupBy, UsageBreakdownEntry[]>>;
}
