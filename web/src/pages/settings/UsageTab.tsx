import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { CostChart } from "../../components/charts/CostChart";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { RequireActiveWorkspace, Section, SettingsDashboardPage } from "./components";

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

interface ModelUsage {
  model: string;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
}

interface UsageReport {
  period: { start: string; end: string };
  totals: {
    tokens: TokenBreakdown;
    cost: CostBreakdown;
    llmCalls: number;
    llmMs: number;
    conversations: number;
  };
  models: ModelUsage[];
  breakdown: Array<{
    key: string;
    tokens: TokenBreakdown;
    cost: CostBreakdown;
    llmCalls: number;
    conversations: number;
  }>;
}

type Period = "day" | "week" | "month" | "all";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatUsd(n: number): string {
  if (n < 0.01 && n > 0) return `$${(n * 100).toFixed(2)}c`;
  return `$${n.toFixed(2)}`;
}

function formatUsdPrecise(n: number): string {
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function shortModel(m: string): string {
  return m.replace(/^(anthropic:|openai:|google:)/, "").replace(/-\d{8}$/, "");
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "day", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

// `usage.report` reads from the workspace-scoped data dir, so the tab
// requires an active workspace.
export function UsageTab() {
  return (
    <RequireActiveWorkspace>
      <UsageTabInner />
    </RequireActiveWorkspace>
  );
}

function UsageTabInner() {
  const [period, setPeriod] = useState<Period>("week");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const res = await callTool("usage", "report", {
        period: p,
        groupBy: "day",
      });
      const data = parseToolResult<UsageReport>(res);
      setReport(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load usage data.";
      if (
        msg.includes("tool_not_found") ||
        msg.includes("not found") ||
        msg.includes("not available") ||
        msg.includes("Unknown tool")
      ) {
        setError("Usage tracking is not available. The usage bundle may not be installed.");
      } else {
        setError(msg);
      }
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReport(period);
  }, [period, fetchReport]);

  const controls = (
    <div className="max-w-xs">
      <Select
        value={period}
        onChange={(e) => setPeriod(e.target.value as Period)}
        aria-label="Select time period"
      >
        {PERIOD_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <SettingsDashboardPage
      title="Usage"
      description="Token consumption and cost for this workspace."
      controls={controls}
      loading={loading}
      loadingMessage="Loading usage data..."
      loadError={error}
    >
      {report ? <UsageBody report={report} /> : null}
    </SettingsDashboardPage>
  );
}

function UsageBody({ report }: { report: UsageReport }) {
  const { tokens, cost } = report.totals;
  const totalTokens = tokens.input + tokens.output + tokens.cacheRead;
  const hasActivity = report.totals.llmCalls > 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatUsd(cost.total)}</p>
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <CostRow label="Input" value={formatUsdPrecise(cost.input)} />
              <CostRow label="Output" value={formatUsdPrecise(cost.output)} />
              <CostRow label="Cache read" value={formatUsdPrecise(cost.cacheRead)} />
              <CostRow label="Cache write" value={formatUsdPrecise(cost.cacheCreation)} />
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
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">LLM Calls</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatNumber(report.totals.llmCalls)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Conversations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatNumber(report.totals.conversations)}</p>
          </CardContent>
        </Card>
      </div>

      {hasActivity ? (
        <Section title="Daily Cost" flush>
          <CostChart data={report.breakdown} />
        </Section>
      ) : null}

      {report.models && report.models.length > 0 ? (
        <Section title="By Model">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Calls</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.models.map((m) => (
                <TableRow key={m.model}>
                  <TableCell className="font-mono text-xs">{shortModel(m.model)}</TableCell>
                  <TableCell className="text-right">
                    {formatTokens(m.tokens.input + m.tokens.output + m.tokens.cacheRead)}
                  </TableCell>
                  <TableCell className="text-right">{formatUsdPrecise(m.cost.total)}</TableCell>
                  <TableCell className="text-right">{formatNumber(m.llmCalls)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}

      <Section title="Daily Breakdown">
        {!hasActivity ? (
          <p className="text-sm text-muted-foreground">No usage data for this period.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cache</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Calls</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.breakdown.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{formatDate(row.key)}</TableCell>
                  <TableCell className="text-right">{formatTokens(row.tokens.input)}</TableCell>
                  <TableCell className="text-right">{formatTokens(row.tokens.output)}</TableCell>
                  <TableCell className="text-right">{formatTokens(row.tokens.cacheRead)}</TableCell>
                  <TableCell className="text-right">{formatUsdPrecise(row.cost.total)}</TableCell>
                  <TableCell className="text-right">{formatNumber(row.llmCalls)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}

function CostRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
