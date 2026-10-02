import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { UsageBreakdownEntry } from "../../_generated/platform-schemas/usage";
import { callTool } from "../../api/client";
import { parseToolResult } from "../../api/tool-result";
import {
  type ChartSeries,
  CostChart,
  type DayData,
  OVERFLOW_COLOR,
} from "../../components/charts/CostChart";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
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
  type DateRange,
  DIMENSION_OPTIONS,
  formatNumber,
  ORIGIN_LABELS,
  RANGE_OPTIONS,
  type RangePreset,
  resolveRangePreset,
  shortModel,
  totalTokenCount,
  type UsageDimension,
  type UsageReport,
  UsageTotalsCards,
} from "./usage-shared";

// ── Org usage / audit ────────────────────────────────────────────────
//
// Usage is per-call and tenant-wide: the ledger line carries the user and the
// workspace it was spent under, so the org surface can slice by either. One
// usage read per filter change asks the backend for the chosen dimension, the
// day series split by that dimension (for the stacked chart), and the origin
// split (for the chat / automation cards) in one scan.
//
// The report returns ids. The user and workspace rosters resolve them to
// names here, the same way for both, and an id neither roster knows (a
// deleted user or workspace) is shown raw so the row stays auditable.

interface UserRow {
  id: string;
  email: string;
  displayName: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
}

/** Everything the page needs to turn a breakdown key into a label. */
export interface UsageLabels {
  users: Map<string, UserRow>;
  workspaces: Map<string, WorkspaceRow>;
}

/** The filter bar's state. `"all"` means the filter is not applied. */
export interface UsageFilterState {
  workspaceId: string;
  userId: string;
  model: string;
  range: RangePreset;
  custom: DateRange;
  groupBy: UsageDimension;
}

const ALL = "all";

/** Series drawn in their own colour; the rest fold into "Other". Matches the chart palette. */
const MAX_SERIES = 5;

/** A breakdown key as a person reads it, with a secondary line when there is one. */
export function labelFor(
  dimension: UsageDimension,
  key: string,
  labels: UsageLabels,
): { name: string; detail: string | null } {
  switch (dimension) {
    case "user": {
      const u = labels.users.get(key);
      if (u) return { name: u.displayName, detail: u.email };
      // Unknown owner — deleted user, dev-mode id, or a call with no identity.
      return { name: key === "unknown" ? "Unknown" : key, detail: null };
    }
    case "workspace": {
      if (key === "none") return { name: "No workspace", detail: null };
      const w = labels.workspaces.get(key);
      return w ? { name: w.name, detail: null } : { name: key, detail: "Deleted workspace" };
    }
    case "origin":
      return { name: ORIGIN_LABELS[key] ?? key, detail: null };
    case "model":
      return { name: shortModel(key), detail: null };
  }
}

/** The effective window for the current filters, or null while a custom range is invalid. */
export function rangeFor(filters: UsageFilterState, now?: Date): DateRange | null {
  if (filters.range !== "custom") return resolveRangePreset(filters.range, now);
  const { from, to } = filters.custom;
  return from && to && from <= to ? { from, to } : null;
}

/** The `usage__report` arguments for a filter state and window. */
export function reportArgs(filters: UsageFilterState, range: DateRange) {
  return {
    scope: "org" as const,
    from: range.from,
    to: range.to,
    groupBy: [...new Set<UsageDimension | "day">([filters.groupBy, "day", "origin"])],
    stackBy: filters.groupBy,
    ...(filters.workspaceId !== ALL ? { workspaceId: filters.workspaceId } : {}),
    ...(filters.userId !== ALL ? { userId: filters.userId } : {}),
    ...(filters.model !== ALL ? { model: filters.model } : {}),
  };
}

export function OrgUsageTab() {
  const [filters, setFilters] = useState<UsageFilterState>(() => ({
    workspaceId: ALL,
    userId: ALL,
    model: ALL,
    range: "mtd",
    custom: resolveRangePreset("custom"),
    groupBy: "model",
  }));
  const [report, setReport] = useState<UsageReport | null>(null);
  // The dimension `report` was fetched for. The body renders by this, not by
  // the filter: a refetch keeps the last report on screen, and its breakdowns
  // and day stacks are keyed by the dimension it was asked for.
  const [reportGroupBy, setReportGroupBy] = useState<UsageDimension>("model");
  const [labels, setLabels] = useState<UsageLabels>({ users: new Map(), workspaces: new Map() });
  // The model list the filter offers. Taken from a report with no model
  // filter, so choosing a model does not shrink the list to that one model.
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const range = rangeFor(filters);

  // The rosters do not depend on the filters, so they load once.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      callTool("nb", "manage_users", { action: "list" }).catch(() => null),
      callTool("nb", "manage_workspaces", { action: "list" }).catch(() => null),
    ]).then(([usersRes, workspacesRes]) => {
      if (cancelled) return;
      const users = usersRes ? (parseToolResult<{ users: UserRow[] }>(usersRes).users ?? []) : [];
      const workspaces = workspacesRes
        ? (parseToolResult<{ workspaces: WorkspaceRow[] }>(workspacesRes).workspaces ?? [])
        : [];
      setLabels({
        users: new Map(users.map((u) => [u.id, u])),
        workspaces: new Map(workspaces.map((w) => [w.id, w])),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const argsKey = range ? JSON.stringify(reportArgs(filters, range)) : null;

  useEffect(() => {
    if (!argsKey) return;
    // Only the latest request may land: a slow response for an old filter
    // must not overwrite the report for the current one.
    const seq = ++requestSeq.current;
    const args = JSON.parse(argsKey) as ReturnType<typeof reportArgs>;
    setLoading(true);
    setError(null);
    callTool("usage", "report", args)
      .then((res) => {
        if (seq !== requestSeq.current) return;
        const next = parseToolResult<UsageReport>(res);
        setReport(next);
        setReportGroupBy(args.stackBy);
        if (args.model === undefined) setModels(next.models.map((m) => m.model));
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : "Failed to load usage data.");
        setReport(null);
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [argsKey]);

  return (
    <SettingsDashboardPage
      title="Usage"
      description="Token consumption and cost across the organization. All dates are UTC."
      controls={
        <UsageFilterBar filters={filters} onChange={setFilters} labels={labels} models={models} />
      }
      // Only the first load blanks the page; a refetch keeps the last report
      // on screen so changing a filter does not flash the whole body.
      loading={loading && !report}
      loadingMessage="Loading usage data..."
      loadError={error}
    >
      {report ? <OrgUsageBody report={report} labels={labels} groupBy={reportGroupBy} /> : null}
    </SettingsDashboardPage>
  );
}

/** Exported for the render test in web/src/__tests__/usage-totals-cards.test.tsx. */
export function UsageFilterBar({
  filters,
  onChange,
  labels,
  models,
}: {
  filters: UsageFilterState;
  onChange: (next: UsageFilterState) => void;
  labels: UsageLabels;
  models: string[];
}) {
  const set = <K extends keyof UsageFilterState>(key: K, value: UsageFilterState[K]) =>
    onChange({ ...filters, [key]: value });

  const workspaces = [...labels.workspaces.values()].sort((a, b) => a.name.localeCompare(b.name));
  const users = [...labels.users.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
  // The selected model stays offered even when the remembered list lacks it.
  const modelOptions =
    filters.model !== ALL && !models.includes(filters.model) ? [filters.model, ...models] : models;
  const customInvalid =
    filters.range === "custom" && rangeFor(filters) === null
      ? "The start date must be on or before the end date."
      : null;

  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-5">
        <FilterField label="Workspace" id="usage-filter-workspace">
          <Select
            id="usage-filter-workspace"
            value={filters.workspaceId}
            onChange={(e) => set("workspaceId", e.target.value)}
          >
            <option value={ALL}>All workspaces</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Range" id="usage-filter-range">
          <Select
            id="usage-filter-range"
            value={filters.range}
            onChange={(e) => set("range", e.target.value as RangePreset)}
          >
            {RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="User" id="usage-filter-user">
          <Select
            id="usage-filter-user"
            value={filters.userId}
            onChange={(e) => set("userId", e.target.value)}
          >
            <option value={ALL}>All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Model" id="usage-filter-model">
          <Select
            id="usage-filter-model"
            value={filters.model}
            onChange={(e) => set("model", e.target.value)}
          >
            <option value={ALL}>All models</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {shortModel(m)}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField label="Group by" id="usage-filter-group">
          <Select
            id="usage-filter-group"
            value={filters.groupBy}
            onChange={(e) => set("groupBy", e.target.value as UsageDimension)}
          >
            {DIMENSION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </FilterField>
      </div>
      {filters.range === "custom" ? (
        <div className="mt-3 grid grid-cols-2 gap-3 @3xl:grid-cols-5">
          <FilterField label="From (UTC)" id="usage-filter-from">
            <Input
              id="usage-filter-from"
              type="date"
              value={filters.custom.from}
              max={filters.custom.to || undefined}
              aria-invalid={customInvalid ? true : undefined}
              onChange={(e) => set("custom", { ...filters.custom, from: e.target.value })}
            />
          </FilterField>
          <FilterField label="To (UTC)" id="usage-filter-to">
            <Input
              id="usage-filter-to"
              type="date"
              value={filters.custom.to}
              min={filters.custom.from || undefined}
              aria-invalid={customInvalid ? true : undefined}
              onChange={(e) => set("custom", { ...filters.custom, to: e.target.value })}
            />
          </FilterField>
          {customInvalid ? (
            <p role="alert" className="col-span-2 self-end text-xs text-destructive">
              {customInvalid}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FilterField({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * The chart's series for a dimension: the costliest keys each get a colour.
 * Past {@link MAX_SERIES} keys, the top `MAX_SERIES - 1` keep theirs and the
 * rest fold into one muted "Other", so the legend stays readable and no spend
 * drops out of the bars. Exported for the test in
 * web/src/__tests__/usage-totals-cards.test.tsx.
 */
export function seriesFor(
  dimension: UsageDimension,
  rows: UsageBreakdownEntry[],
  labels: UsageLabels,
): ChartSeries[] {
  const ranked = rows.filter((r) => r.cost.total > 0).sort((a, b) => b.cost.total - a.cost.total);
  const named = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked;
  const namedKeys = new Set(named.map((r) => r.key));
  const series: ChartSeries[] = named.map((r) => ({
    key: r.key,
    label: labelFor(dimension, r.key, labels).name,
    value: (d: DayData) => d.stack?.[r.key] ?? 0,
  }));
  if (named.length < ranked.length) {
    series.push({
      key: "__other__",
      label: "Other",
      color: OVERFLOW_COLOR,
      value: (d: DayData) =>
        Object.entries(d.stack ?? {})
          .filter(([k]) => !namedKeys.has(k))
          .reduce((sum, [, v]) => sum + v, 0),
    });
  }
  return series;
}

/** Exported for the render test in web/src/__tests__/usage-totals-cards.test.tsx. */
export function OrgUsageBody({
  report,
  labels,
  groupBy,
}: {
  report: UsageReport;
  labels: UsageLabels;
  groupBy: UsageDimension;
}) {
  const hasActivity = report.totals.llmCalls > 0;
  const rows = report.breakdowns[groupBy] ?? [];
  const dayBreakdown = report.breakdowns.day ?? [];
  const dimensionLabel = DIMENSION_OPTIONS.find((o) => o.value === groupBy)?.label ?? groupBy;
  const series = useMemo(() => seriesFor(groupBy, rows, labels), [groupBy, rows, labels]);

  // Sorted by cost descending — the audit question is "where is the money going."
  const tableRows = [...rows].sort((a, b) => b.cost.total - a.cost.total);
  const truncated = report.truncatedBreakdowns?.[groupBy];

  return (
    <div className="space-y-6">
      <UsageTotalsCards totals={report.totals} byOrigin={report.breakdowns.origin} />

      {hasActivity ? (
        <Section title={`Daily cost by ${dimensionLabel.toLowerCase()}`} flush>
          <CostChart data={dayBreakdown} series={series} />
        </Section>
      ) : null}

      <Section title={`By ${dimensionLabel.toLowerCase()}`}>
        {!hasActivity ? (
          <p className="text-sm text-muted-foreground">No usage data for this period.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{dimensionLabel}</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">LLM Calls</TableHead>
                  <TableHead className="text-right">
                    {(report.totals.runs ?? 0) > 0 ? "Sessions" : "Conversations"}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableRows.map((row) => {
                  const { name, detail } = labelFor(groupBy, row.key, labels);
                  return (
                    <TableRow key={row.key}>
                      <TableCell>
                        <div className={groupBy === "model" ? "font-mono text-xs" : "font-medium"}>
                          {name}
                        </div>
                        {detail ? (
                          <div className="text-xs text-muted-foreground">{detail}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatTokens(totalTokenCount(row.tokens))}
                      </TableCell>
                      {/*
                        Marked, not silently zeroed: an all-unpriced row reads
                        $0.00 otherwise, which is the same "spend looks free"
                        failure the totals card exists to prevent, one row down.
                      */}
                      <TableCell className="text-right">
                        {formatUsd(row.cost.total)}
                        {(row.unpricedCalls ?? 0) > 0 ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            +{formatNumber(row.unpricedCalls ?? 0)} unpriced
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">{formatNumber(row.llmCalls)}</TableCell>
                      {/*
                        Chats plus automation runs. The aggregator keeps them
                        apart on the row for the same reason the totals do — a
                        run is not a conversation — and the column sums them so
                        it stops under-reporting a row whose spend is mostly
                        automations.
                      */}
                      <TableCell className="text-right">
                        {formatNumber(row.conversations + (row.runs ?? 0))}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the {formatNumber(truncated.returned)} costliest of{" "}
                {formatNumber(truncated.total)}.
              </p>
            ) : null}
          </>
        )}
      </Section>
    </div>
  );
}
