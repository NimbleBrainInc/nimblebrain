// The org usage view's totals cards.
//
// Separate from OrgUsageTab because the pieces are about presenting a usage
// report rather than about that page, and because two of the cards carry
// judgments worth keeping in one place — what the cost figure omits, and that
// an automation run is not a conversation.

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
  return m.replace(/^[a-z0-9-]+:/, "").replace(/-\d{8}$/, "");
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

/**
 * The four headline cards: cost, tokens, LLM calls, and sessions.
 *
 * Two of them qualify themselves rather than presenting a bare number: the cost
 * card says when calls are excluded for want of a price, and the session card
 * splits chats from automation runs once any exist. Both were numbers that read
 * as complete while omitting exactly the spend this reporting was rebuilt to
 * surface.
 */
export function UsageTotalsCards({ totals }: { totals: UsageReport["totals"] }) {
  const { tokens, cost } = totals;
  const totalTokens = totalTokenCount(tokens);
  const unpricedCalls = totals.unpricedCalls ?? 0;
  const runs = totals.runs ?? 0;

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
          {/*
            Says the figure above is incomplete, not that the spend was zero.
            Some calls carry tokens with no resolvable price — a model the
            catalog never knew, or history replayed from automation runs that
            recorded no model — so their tokens are in the count beside this and
            their cost is in nothing. Without this line the difference is
            invisible, and a large token count next to a small dollar figure
            reads as cheap rather than as partly unknown.
          */}
          {unpricedCalls > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Excludes {formatNumber(unpricedCalls)} {unpricedCalls === 1 ? "call" : "calls"} with
              no known price.
            </p>
          )}
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
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {runs > 0 ? "Sessions" : "Conversations"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">{formatNumber(totals.conversations + runs)}</p>
          {/*
            Split rather than summed silently: an automation run is not someone
            chatting, and folding the two is how automation spend stayed
            invisible in the first place. The rows appear only once runs exist,
            so a tenant with no automations sees the card it always saw.
          */}
          {runs > 0 && (
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <CostRow label="Chats" value={formatNumber(totals.conversations)} />
              <CostRow label="Automation runs" value={formatNumber(runs)} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
