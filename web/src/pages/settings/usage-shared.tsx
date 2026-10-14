// The org usage view's presentation pieces: date ranges, dimension labels, and
// the totals cards.
//
// Separate from OrgUsageTab because the pieces are about presenting a usage
// report rather than about that page, and because the cards carry judgments
// worth keeping in one place — what the cost figure omits, and that a
// task run is not a conversation.

import { useId, useState } from "react";
import type {
  UsageBreakdownEntry,
  UsageReportOutput,
  UsageTokenBreakdown,
} from "../../_generated/platform-schemas/usage";
import { Card } from "../../components/ui/card";
import { formatTokens, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";

// Wire shape comes from the generated platform-schema types — the single
// cross-package contract (§2.1). The handler's `UsageReportOutput` in
// src/platform/schemas/usage.ts is the source of truth; `bun run
// codegen` mirrors it here, and `check:codegen` fails the build on drift.
export type UsageReport = UsageReportOutput;

// ── Date ranges ─────────────────────────────────────────────────────
//
// Every range is whole UTC days, inclusive at both ends, because the ledger
// buckets a call by the UTC date of its timestamp. The page computes explicit
// `from`/`to` for each preset rather than sending a `period`, so what the
// select says is exactly the window the server reads.

export type RangePreset = "mtd" | "last7" | "last30" | "lastMonth" | "custom";

export const RANGE_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: "mtd", label: "Month to date" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "lastMonth", label: "Last month" },
  { value: "custom", label: "Custom range" },
];

export interface DateRange {
  from: string;
  to: string;
}

/** `YYYY-MM-DD` of a Date, read in UTC. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The UTC day `days` after (or before, if negative) `day`. */
function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDay(d);
}

/**
 * The window a preset names, as of `now`. An "N days" preset counts today as
 * one of the N, so `last7` is `today - 6 .. today`. `custom` has no window of
 * its own; it returns the last 30 days as the starting value for the inputs.
 */
export function resolveRangePreset(preset: RangePreset, now: Date = new Date()): DateRange {
  const today = utcDay(now);
  switch (preset) {
    case "mtd":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last7":
      return { from: shiftDay(today, -6), to: today };
    case "lastMonth": {
      const firstOfThisMonth = `${today.slice(0, 7)}-01`;
      const lastOfPrev = shiftDay(firstOfThisMonth, -1);
      return { from: `${lastOfPrev.slice(0, 7)}-01`, to: lastOfPrev };
    }
    default:
      return { from: shiftDay(today, -29), to: today };
  }
}

// ── Dimensions ─────────────────────────────────────────────────────

/** The dimensions the page can chart and tabulate by. */
export type UsageDimension = "model" | "workspace" | "user" | "origin";

export const DIMENSION_OPTIONS: { value: UsageDimension; label: string }[] = [
  { value: "model", label: "Model" },
  { value: "workspace", label: "Workspace" },
  { value: "user", label: "User" },
  { value: "origin", label: "Origin" },
];

/** Labels for the `origin` keys the ledger records. */
export const ORIGIN_LABELS: Record<string, string> = {
  chat: "Chat",
  task: "Task",
  system: "System",
};

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

function formatPercent(rate: number | undefined): string {
  return rate != null ? `${Math.round(rate * 100)}%` : "—";
}

// ── Cards ──────────────────────────────────────────────────────────

type DetailRow = [label: string, value: string];

/**
 * One headline number whose detail opens in place.
 *
 * The front face and the detail face share one grid cell, and the hidden one
 * is `invisible` rather than unmounted, so the card is always as large as the
 * larger face: opening it changes what it shows, never its size, and the row
 * of cards does not shift. `invisible` also takes the hidden face out of the
 * accessibility tree. The headline face is centered in that height, since it
 * is shorter than the detail list. The toggle is a real button stretched over the card, so
 * the whole card is the click target while the faces stay ordinary text in
 * reading order rather than becoming the button's name.
 */
export function StatCard({
  title,
  value,
  summary,
  details,
}: {
  title: string;
  value: string;
  /** One line under the headline. Anything the headline must not be read without goes here. */
  summary?: string;
  details: DetailRow[];
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();

  return (
    <Card
      size="sm"
      data-expanded={open}
      className="relative gap-0 py-0 transition-colors has-[>button:hover]:bg-foreground/5"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`${title} details`}
        onClick={() => setOpen((o) => !o)}
        className="absolute inset-0 z-10 cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      />
      <div className="grid flex-1 p-3 [grid-template-areas:'face']">
        <div
          className={cn(
            "flex flex-col justify-center [grid-area:face] motion-safe:transition-opacity",
            open && "invisible opacity-0",
          )}
        >
          <span className="text-sm font-medium text-muted-foreground">{title}</span>
          <span className="mt-1 text-2xl font-semibold tabular-nums">{value}</span>
          {summary ? <span className="mt-1 text-xs text-muted-foreground">{summary}</span> : null}
        </div>
        <div
          id={detailId}
          className={cn(
            "flex flex-col [grid-area:face] motion-safe:transition-opacity",
            !open && "invisible opacity-0",
          )}
        >
          <span className="text-xs font-medium text-muted-foreground">{title}</span>
          <dl className="mt-1 space-y-0.5 text-xs">
            {details.map(([label, v]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Card>
  );
}

/**
 * The four headline cards: total cost, chat cost, task cost, and tokens.
 *
 * Chat and task are split because folding them is how task spend
 * stayed invisible in the first place: a task run is not someone
 * chatting. The total card qualifies itself on its front face when calls are
 * excluded for want of a price, since a large token count beside a small
 * dollar figure otherwise reads as cheap rather than as partly unknown.
 *
 * `byOrigin` is the report's `origin` breakdown. `system` calls (detached
 * background work) are in the total and in neither split card, so the total
 * card's detail names them when they exist.
 */
export function UsageTotalsCards({
  totals,
  byOrigin = [],
}: {
  totals: UsageReport["totals"];
  byOrigin?: UsageBreakdownEntry[];
}) {
  const { tokens, cost } = totals;
  const unpricedCalls = totals.unpricedCalls ?? 0;
  const origin = (key: string) => byOrigin.find((r) => r.key === key);
  const chat = origin("chat");
  const task = origin("task");
  const system = origin("system");

  const costDetails: DetailRow[] = [
    ["Input", formatUsd(cost.input)],
    ["Output", formatUsd(cost.output)],
    ["Cache read", formatUsd(cost.cacheRead)],
    ["Cache write", formatUsd(cost.cacheWrite)],
  ];
  if (system && system.cost.total > 0) costDetails.push(["System", formatUsd(system.cost.total)]);

  const originDetails = (row: UsageBreakdownEntry | undefined, countLabel: string, count: number) =>
    [
      [countLabel, formatNumber(count)],
      ["LLM calls", formatNumber(row?.llmCalls ?? 0)],
      ["Tokens", formatTokens(row ? totalTokenCount(row.tokens) : 0)],
      ["Output cost", formatUsd(row?.cost.output ?? 0)],
      ["Cache hit", formatPercent(row?.cacheHitRate)],
    ] satisfies DetailRow[];

  const runs = task?.runs ?? 0;
  const conversations = chat?.conversations ?? 0;

  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4 @3xl:gap-4">
        <StatCard
          title="Total cost"
          value={formatUsd(cost.total)}
          summary={
            unpricedCalls > 0
              ? `Excludes ${formatNumber(unpricedCalls)} ${unpricedCalls === 1 ? "call" : "calls"} with no known price.`
              : `${formatNumber(totals.llmCalls)} LLM ${totals.llmCalls === 1 ? "call" : "calls"}`
          }
          details={costDetails}
        />
        <StatCard
          title="Chat cost"
          value={formatUsd(chat?.cost.total ?? 0)}
          summary={`${formatNumber(conversations)} ${conversations === 1 ? "conversation" : "conversations"}`}
          details={originDetails(chat, "Conversations", conversations)}
        />
        <StatCard
          title="Task cost"
          value={formatUsd(task?.cost.total ?? 0)}
          summary={`${formatNumber(runs)} task ${runs === 1 ? "run" : "runs"}`}
          details={originDetails(task, "Task runs", runs)}
        />
        <StatCard
          title="Tokens"
          value={formatTokens(totalTokenCount(tokens))}
          summary={`${formatPercent(totals.cacheHitRate)} cache hit`}
          details={[
            ["Input", formatTokens(tokens.input)],
            ["Output", formatTokens(tokens.output)],
            ["Cache read", formatTokens(tokens.cacheRead)],
            ["Cache write", formatTokens(tokens.cacheWrite)],
            ["LLM calls", formatNumber(totals.llmCalls)],
          ]}
        />
      </div>
    </div>
  );
}
