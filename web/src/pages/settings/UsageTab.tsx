import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { CostChart } from "../../components/charts/CostChart";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";

// ── Types ───────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────

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

function parseToolResponse<T>(res: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): T {
  if (res.isError) throw new Error(res.content?.[0]?.text ?? "Operation failed");
  if (res.structuredContent) return res.structuredContent as T;
  if (res.content?.[0]?.text) {
    try {
      return JSON.parse(res.content[0].text) as T;
    } catch {
      throw new Error(res.content[0].text);
    }
  }
  throw new Error("Empty response");
}

// ── Styles ──────────────────────────────────────────────────────

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "day", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

// ── Component ───────────────────────────────────────────────────

export function UsageTab() {
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
      const data = parseToolResponse<UsageReport>(res);
      setReport(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load usage data.";
      // Detect tool_not_found / bundle not available
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

  const handlePeriodChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPeriod(e.target.value as Period);
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading usage data...</div>;
  }

  if (error) {
    return (
      <div className="max-w-2xl">
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!report) return null;

  const { tokens, cost } = report.totals;
  const totalTokens = tokens.input + tokens.output + tokens.cacheRead;
  const hasActivity = report.totals.llmCalls > 0;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Period selector */}
      <div className="max-w-xs">
        <select
          value={period}
          onChange={handlePeriodChange}
          className={selectClass}
          aria-label="Select time period"
        >
          {PERIOD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatUsd(cost.total)}</p>
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>Input</span>
                <span>{formatUsdPrecise(cost.input)}</span>
              </div>
              <div className="flex justify-between">
                <span>Output</span>
                <span>{formatUsdPrecise(cost.output)}</span>
              </div>
              <div className="flex justify-between">
                <span>Cache read</span>
                <span>{formatUsdPrecise(cost.cacheRead)}</span>
              </div>
              <div className="flex justify-between">
                <span>Cache write</span>
                <span>{formatUsdPrecise(cost.cacheCreation)}</span>
              </div>
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
              <div className="flex justify-between">
                <span>Input</span>
                <span>{formatTokens(tokens.input)}</span>
              </div>
              <div className="flex justify-between">
                <span>Output</span>
                <span>{formatTokens(tokens.output)}</span>
              </div>
              <div className="flex justify-between">
                <span>Cache read</span>
                <span>{formatTokens(tokens.cacheRead)}</span>
              </div>
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

      {/* Daily cost chart */}
      {hasActivity && (
        <Card className="overflow-visible">
          <CardHeader>
            <CardTitle>Daily Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <CostChart data={report.breakdown} />
          </CardContent>
        </Card>
      )}

      {/* Model breakdown */}
      {report.models && report.models.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>By Model</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      )}

      {/* Daily breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
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
                    <TableCell className="text-right">
                      {formatTokens(row.tokens.cacheRead)}
                    </TableCell>
                    <TableCell className="text-right">{formatUsdPrecise(row.cost.total)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.llmCalls)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
