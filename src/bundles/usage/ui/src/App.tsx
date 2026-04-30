import { SynapseProvider, useCallTool } from "@nimblebrain/synapse/react";
import { useEffect, useState } from "react";

/* ---------- types (mirror the wire shape from src/conversation/usage-aggregator.ts) ---------- */

interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface UsageTotals {
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  llmMs: number;
  conversations: number;
}

interface ModelUsage {
  model: string;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
}

interface BreakdownEntry {
  key: string;
  tokens: TokenBreakdown;
  cost: CostBreakdown;
  llmCalls: number;
  conversations: number;
}

interface UsageReport {
  period: { from: string; to: string };
  totals: UsageTotals;
  models: ModelUsage[];
  breakdown: BreakdownEntry[];
}

type Period = "day" | "week" | "month" | "all";
type GroupBy = "day" | "model" | "conversation";

/* ---------- formatters ---------- */

function fmtCost(n: number): string {
  return n < 0.01 ? `${(n * 100).toFixed(2)}¢` : `$${n.toFixed(2)}`;
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function shortModel(m: string): string {
  return m.replace(/^(anthropic:|openai:|google:)/, "").replace(/-\d{8}$/, "");
}

/* ---------- components ---------- */

function Dashboard() {
  const [period, setPeriod] = useState<Period>("week");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { call, isPending } = useCallTool<UsageReport>("report");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `call` identity churns; period/groupBy drive the refetch
  useEffect(() => {
    let cancelled = false;
    setError(null);
    call({ period, groupBy })
      .then((result) => {
        if (cancelled) return;
        if (result.isError) {
          setError("Failed to load usage data");
          return;
        }
        setData(result.data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load usage data");
      });
    return () => {
      cancelled = true;
    };
  }, [period, groupBy]);

  if (error) {
    return (
      <div className="page">
        <div className="empty">Failed: {error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <div className="loading">Loading usage data…</div>
      </div>
    );
  }

  const t = data.totals;
  const tok = t.tokens;
  const cost = t.cost;
  const totalTok = (tok.input || 0) + (tok.output || 0) + (tok.cacheRead || 0);

  return (
    <div className="page">
      <div className="header">
        <h1>Usage</h1>
        <div className="controls">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            disabled={isPending}
          >
            <option value="day">Today</option>
            <option value="week">Last 7 days</option>
            <option value="month">This month</option>
            <option value="all">All time</option>
          </select>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            disabled={isPending}
          >
            <option value="day">By day</option>
            <option value="model">By model</option>
            <option value="conversation">By conversation</option>
          </select>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat">
          <div className="stat-value">{fmtCost(cost.total || 0)}</div>
          <div className="stat-label">Total Cost</div>
          <div className="stat-detail">
            <div className="row">
              <span>Input</span>
              <span>{fmtCost(cost.input || 0)}</span>
            </div>
            <div className="row">
              <span>Output</span>
              <span>{fmtCost(cost.output || 0)}</span>
            </div>
            <div className="row">
              <span>Cache read</span>
              <span>{fmtCost(cost.cacheRead || 0)}</span>
            </div>
            <div className="row">
              <span>Cache write</span>
              <span>{fmtCost(cost.cacheWrite || 0)}</span>
            </div>
          </div>
        </div>

        <div className="stat">
          <div className="stat-value">{fmtTok(totalTok)}</div>
          <div className="stat-label">Tokens</div>
          <div className="stat-detail">
            <div className="row">
              <span>Input</span>
              <span>{fmtTok(tok.input || 0)}</span>
            </div>
            <div className="row">
              <span>Output</span>
              <span>{fmtTok(tok.output || 0)}</span>
            </div>
            <div className="row">
              <span>Cache read</span>
              <span>{fmtTok(tok.cacheRead || 0)}</span>
            </div>
          </div>
        </div>

        <div className="stat">
          <div className="stat-value">{t.llmCalls || 0}</div>
          <div className="stat-label">LLM Calls</div>
        </div>

        <div className="stat">
          <div className="stat-value">{t.conversations || 0}</div>
          <div className="stat-label">Conversations</div>
        </div>
      </div>

      <div className="section">
        <h2>By Model</h2>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th className="right">Tokens</th>
              <th className="right">Cost</th>
              <th className="right">Calls</th>
            </tr>
          </thead>
          <tbody>
            {data.models.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty">
                  No data
                </td>
              </tr>
            ) : (
              data.models.map((m) => (
                <tr key={m.model}>
                  <td>{shortModel(m.model)}</td>
                  <td className="right">
                    {fmtTok(
                      (m.tokens.input || 0) + (m.tokens.output || 0) + (m.tokens.cacheRead || 0),
                    )}
                  </td>
                  <td className="right">{fmtCost(m.cost.total)}</td>
                  <td className="right">{m.llmCalls}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="section">
        <h2>Breakdown</h2>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th className="right">Input</th>
              <th className="right">Output</th>
              <th className="right">Cache</th>
              <th className="right">Cost</th>
              <th className="right">Calls</th>
            </tr>
          </thead>
          <tbody>
            {data.breakdown.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  No data for this period
                </td>
              </tr>
            ) : (
              data.breakdown.map((d) => (
                <tr key={d.key}>
                  <td>{d.key}</td>
                  <td className="right">{fmtTok(d.tokens.input)}</td>
                  <td className="right">{fmtTok(d.tokens.output)}</td>
                  <td className="right">{fmtTok(d.tokens.cacheRead)}</td>
                  <td className="right">{fmtCost(d.cost.total)}</td>
                  <td className="right">{d.llmCalls}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function App() {
  return (
    <SynapseProvider name="@nimblebraininc/usage" version="0.1.0">
      <Dashboard />
    </SynapseProvider>
  );
}
