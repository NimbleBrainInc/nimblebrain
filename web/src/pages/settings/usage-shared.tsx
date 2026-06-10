// Shared pieces for usage views. Usage is per-user post-Stage-1, surfaced
// org-wide on the org/audit settings page (per-user breakdown) and as a
// self-view on the profile. Both render the same totals cards + cost chart;
// only the breakdown dimension differs, so the rendering lives here.

import type {
  UsageReportOutput,
  UsageTokenBreakdown,
} from "../../_generated/platform-schemas/usage";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { formatTokens, formatUsd } from "../../lib/format";

// Wire shape comes from the generated platform-schema types — the single
// cross-package contract (§2.1). The handler's `UsageReportOutput` in
// src/tools/platform/schemas/usage.ts is the source of truth; `bun run
// codegen` mirrors it here, and `check:codegen` fails the build on drift.
export type UsageReport = UsageReportOutput;

export type Period = "day" | "week" | "month" | "all";

export const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "day", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function shortModel(m: string): string {
  return m.replace(/^(anthropic:|openai:|google:)/, "").replace(/-\d{8}$/, "");
}

/** Sum of all four token buckets — honest total including cache writes. */
export function totalTokenCount(t: UsageTokenBreakdown): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function CostRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The four headline cards: total cost, tokens, LLM calls, conversations. */
export function UsageTotalsCards({ totals }: { totals: UsageReport["totals"] }) {
  const { tokens, cost } = totals;
  const totalTokens = totalTokenCount(tokens);

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Total Cost</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatUsd(cost.total)}</p>
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <CostRow label="Input" value={formatUsd(cost.input)} />
            <CostRow label="Output" value={formatUsd(cost.output)} />
            <CostRow label="Cache read" value={formatUsd(cost.cacheRead)} />
            <CostRow label="Cache write" value={formatUsd(cost.cacheWrite)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatTokens(totalTokens)}</p>
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <CostRow label="Input" value={formatTokens(tokens.input)} />
            <CostRow label="Output" value={formatTokens(tokens.output)} />
            <CostRow label="Cache read" value={formatTokens(tokens.cacheRead)} />
            <CostRow label="Cache write" value={formatTokens(tokens.cacheWrite)} />
            <CostRow
              label="Cache hit"
              value={
                totals.cacheHitRate != null ? `${Math.round(totals.cacheHitRate * 100)}%` : "—"
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">LLM Calls</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatNumber(totals.llmCalls)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Conversations</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatNumber(totals.conversations)}</p>
        </CardContent>
      </Card>
    </div>
  );
}
