import { useCallback, useEffect, useState } from "react";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import { CostChart } from "../../components/charts/CostChart";
import { Select } from "../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { formatTokens, formatUsd } from "../../lib/format";
import { Section, SettingsDashboardPage } from "./components";
import {
  formatNumber,
  PERIOD_OPTIONS,
  type Period,
  shortModel,
  totalTokenCount,
  type UsageReport,
  UsageTotalsCards,
} from "./usage-shared";

// ── Org usage / audit ────────────────────────────────────────────────
//
// Usage is inherently per-USER post-Stage-1: identity-bound sessions span
// workspaces and a conversation's `workspaceId` breadcrumb is the user's
// personal workspace, not a focused one. So usage moved off workspace
// settings to the org/audit surface, aggregated BY USER.
//
// One usage read per period asks the backend to bucket the same scan by user
// and by day. The roster resolves ownerId → name/email for the table.

interface UserRow {
  id: string;
  email: string;
  displayName: string;
}

function resolveUser(
  ownerId: string,
  users: Map<string, UserRow>,
): { name: string; email: string | null } {
  const u = users.get(ownerId);
  if (u) return { name: u.displayName, email: u.email };
  // Unknown owner — deleted user, dev-mode id, or a conversation whose
  // ownerId didn't resolve. Show the raw id so the row is still auditable.
  return { name: ownerId === "unknown" ? "Unknown" : ownerId, email: null };
}

export function OrgUsageTab() {
  const [period, setPeriod] = useState<Period>("month");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [users, setUsers] = useState<Map<string, UserRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const [usageRes, usersRes] = await Promise.all([
        callTool("usage", "report", { scope: "org", period: p, groupBy: ["user", "day"] }),
        callTool("nb", "manage_users", { action: "list" }).catch(() => null),
      ]);

      setReport(parseToolResult<UsageReport>(usageRes));

      if (usersRes) {
        const data = parseToolResult<{ users: UserRow[] }>(usersRes);
        setUsers(new Map((data.users ?? []).map((u) => [u.id, u])));
      } else {
        setUsers(new Map());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load usage data.";
      setError(msg);
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
      description="Token consumption and cost across the organization, by user."
      controls={controls}
      loading={loading}
      loadingMessage="Loading usage data..."
      loadError={error}
    >
      {report ? <OrgUsageBody report={report} users={users} /> : null}
    </SettingsDashboardPage>
  );
}

function OrgUsageBody({ report, users }: { report: UsageReport; users: Map<string, UserRow> }) {
  const hasActivity = report.totals.llmCalls > 0;
  const userBreakdown = report.breakdowns.user ?? [];
  const dayBreakdown = report.breakdowns.day ?? [];

  // Per-user rows sorted by cost descending — the audit question is
  // "who is spending the most."
  const userRows = [...userBreakdown].sort((a, b) => b.cost.total - a.cost.total);

  return (
    <div className="space-y-6">
      <UsageTotalsCards totals={report.totals} />

      {hasActivity ? (
        <Section title="Daily Cost" flush>
          <CostChart data={dayBreakdown} />
        </Section>
      ) : null}

      <Section title="By User">
        {!hasActivity ? (
          <p className="text-sm text-muted-foreground">No usage data for this period.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">LLM Calls</TableHead>
                <TableHead className="text-right">Conversations</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userRows.map((row) => {
                const { name, email } = resolveUser(row.key, users);
                return (
                  <TableRow key={row.key}>
                    <TableCell>
                      <div className="font-medium">{name}</div>
                      {email ? <div className="text-xs text-muted-foreground">{email}</div> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatTokens(totalTokenCount(row.tokens))}
                    </TableCell>
                    <TableCell className="text-right">{formatUsd(row.cost.total)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.llmCalls)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.conversations)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

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
                    {formatTokens(totalTokenCount(m.tokens))}
                  </TableCell>
                  <TableCell className="text-right">{formatUsd(m.cost.total)}</TableCell>
                  <TableCell className="text-right">{formatNumber(m.llmCalls)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}
    </div>
  );
}
