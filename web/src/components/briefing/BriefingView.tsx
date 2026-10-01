// ---------------------------------------------------------------------------
// BriefingView — what needs a member in this workspace, as a list.
//
// Pure: it takes the `nb__briefing` result and the workspace's installed
// connectors and renders. No data fetching — the overview wires it to
// `useWorkspaceBriefing` and the connectors list it already holds.
//
// Two kinds of row:
//   - A facet item from the server: `<count> <label>` with the app's name,
//     opening the app. Label and count are untrusted server data and render as
//     text; an `unavailable` item renders muted and keeps its action.
//   - A connector that is not ready: the status the connector page shows,
//     opening that page. Its facets are never read, so it has no count.
// Every row has a level, shown by icon and colour, and the list is ordered by
// it: `critical` (something has stopped), then `warning` (someone should act),
// then `info` (worth knowing). A facet's level is its server's; a connector
// row's is the host's (`statusLevel`).
//
// The rows sit in one panel. A member can hide a row until it changes and
// collapse the panel; both are per-browser preferences (`briefing-prefs.ts`).
// With no row at all, and while loading, the panel is not rendered.
// ---------------------------------------------------------------------------

import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info,
  type LucideIcon,
  OctagonAlert,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type {
  BriefingItem,
  BriefingLevel,
  BriefingOutput,
} from "../../_generated/platform-schemas/home";
import type { InstalledConnector } from "../../api/client";
import {
  type BriefingPrefs,
  isHidden,
  loadBriefingPrefs,
  saveBriefingPrefs,
} from "../../lib/briefing-prefs";
import { cn } from "../../lib/utils";
import { statusLabel } from "../connectors/ConnectorHeader";

interface BriefingViewProps {
  /** Scopes the member's hidden rows and collapsed state. */
  workspaceId: string;
  briefing: BriefingOutput | null;
  /** The workspace's installed connectors; each needing attention adds a row. */
  connectors: readonly InstalledConnector[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** Invoked with a facet item's app route. */
  onOpen: (route: string) => void;
  /** Invoked with the server name of a connector that needs attention. */
  onOpenConnector: (serverName: string) => void;
}

const LEVELS: Record<
  BriefingLevel,
  { rank: number; icon: LucideIcon; badge: string; name: string }
> = {
  critical: {
    rank: 0,
    icon: OctagonAlert,
    badge: "bg-destructive/10 text-destructive",
    name: "Critical",
  },
  warning: { rank: 1, icon: CircleAlert, badge: "bg-warning/10 text-warning", name: "Warning" },
  info: { rank: 2, icon: Info, badge: "bg-muted text-muted-foreground", name: "Info" },
};

/**
 * The host's level for a connector that is not ready. One it cannot work
 * without someone acting on is `critical`; one still coming up resolves on its
 * own and is `info`.
 */
export function statusLevel(status: InstalledConnector["status"]): BriefingLevel {
  return status === "connecting" || status === "starting" ? "info" : "critical";
}

/** A level the web does not know reads as `warning`, as the extension requires. */
function levelOf(level: string): BriefingLevel {
  return Object.hasOwn(LEVELS, level) ? (level as BriefingLevel) : "warning";
}

/** One row of the panel, whatever produced it. */
interface PanelRow {
  key: string;
  /** What the row says now; a hidden row returns when this changes. */
  signature: string;
  level: BriefingLevel;
  testId: string;
  muted: boolean;
  onOpen?: () => void;
  content: ReactNode;
  app: string;
}

function facetRow(item: BriefingItem, onOpen: (route: string) => void): PanelRow {
  const unavailable = item.state === "unavailable";
  const { route } = item;
  return {
    key: `facet:${item.app}/${item.facet}`,
    signature: unavailable ? "unavailable" : `ok:${item.count}`,
    level: levelOf(item.level),
    testId: unavailable ? "briefing-item-unavailable" : "briefing-item",
    muted: unavailable,
    onOpen: route ? () => onOpen(route) : undefined,
    content: unavailable ? (
      <>{item.label} — unavailable</>
    ) : (
      // The label is an app-authored noun phrase ("Tasks blocked") with no
      // singular form, so the count follows it rather than leading it:
      // "Tasks blocked 1" reads right at any count, "1 Tasks blocked" does not.
      <>
        {item.label} <span className="font-bold tabular-nums">{item.count}</span>
      </>
    ),
    app: item.app,
  };
}

function connectorRow(c: InstalledConnector, onOpen: (serverName: string) => void): PanelRow {
  const level = statusLevel(c.status);
  return {
    key: `connector:${c.serverName}`,
    signature: c.status,
    level,
    testId: "briefing-connector-status",
    muted: level === "info",
    onOpen: () => onOpen(c.serverName),
    content: statusLabel(c.status),
    app: c.displayName,
  };
}

function Row({ row, onHide }: { row: PanelRow; onHide: () => void }) {
  const { icon: Icon, badge, name } = LEVELS[row.level];
  const inner = (
    <>
      <span
        className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md", badge)}
        aria-hidden
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="sr-only">{name}: </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          row.muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {row.content}
      </span>
      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
        <span className="sr-only"> · </span>
        {row.app}
      </span>
    </>
  );
  const base = "flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left text-sm";
  return (
    <li
      className="group flex items-center pr-2 hover:bg-foreground/5 transition-colors"
      data-testid={row.testId}
      data-level={row.level}
    >
      {row.onOpen ? (
        <button type="button" onClick={row.onOpen} className={base}>
          {inner}
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ) : (
        <div className={base}>
          {inner}
          {/* The chevron's slot, kept so every row's app pill lines up. */}
          <span className="h-4 w-4 shrink-0" aria-hidden />
        </div>
      )}
      <button
        type="button"
        onClick={onHide}
        aria-label="Hide until it changes"
        title="Hide until it changes"
        data-testid="briefing-hide"
        className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </li>
  );
}

export function BriefingView({
  workspaceId,
  briefing,
  connectors,
  loading,
  error,
  onRetry,
  onOpen,
  onOpenConnector,
}: BriefingViewProps) {
  const [prefs, setPrefs] = useState<BriefingPrefs>(() => loadBriefingPrefs(workspaceId));
  useEffect(() => setPrefs(loadBriefingPrefs(workspaceId)), [workspaceId]);
  const update = (next: BriefingPrefs) => {
    setPrefs(next);
    saveBriefingPrefs(workspaceId, next);
  };

  // Every status but `ready` and `not_connected`: a connector never connected,
  // or disconnected on purpose, is at rest and asks nothing of anyone. One still
  // `connecting` stays in, because an OAuth abandoned mid-flow stays there and
  // its page is where it is cancelled.
  const all: PanelRow[] = [
    ...connectors
      .filter((c) => c.status !== "ready" && c.status !== "not_connected")
      .map((c) => connectorRow(c, onOpenConnector)),
    ...(briefing?.items ?? []).map((item) => facetRow(item, onOpen)),
  ];
  // Most urgent first; within a level, connector rows lead and facet items keep
  // the server's order (sort is stable).
  all.sort((a, b) => LEVELS[a.level].rank - LEVELS[b.level].rank);

  // Keep each hidden entry true to what the row says now. A row that went away
  // is forgotten, so its return shows. A hidden row whose count fell records
  // the lower count, so new work past it shows. A row that changed and shows
  // again is no longer hidden, so a later fall does not hide it again.
  const settled = !loading && !error && briefing !== null;
  useEffect(() => {
    if (!settled) return;
    const now = new Map(all.map((r) => [r.key, r.signature]));
    const hidden: Record<string, string> = {};
    let changed = false;
    for (const [k, was] of Object.entries(prefs.hidden)) {
      const sig = now.get(k);
      if (sig === was) hidden[k] = was;
      else {
        changed = true;
        if (sig !== undefined && isHidden(prefs, k, sig)) hidden[k] = sig;
      }
    }
    if (changed) update({ ...prefs, hidden });
  });

  if (loading || (all.length === 0 && !error)) return null;

  const visible = all.filter((r) => !isHidden(prefs, r.key, r.signature));
  const hiddenCount = all.length - visible.length;
  const criticalCount = visible.filter((r) => r.level === "critical").length;
  const open = !prefs.collapsed;
  const hide = (row: PanelRow) =>
    update({ ...prefs, hidden: { ...prefs.hidden, [row.key]: row.signature } });

  return (
    <section
      className="mb-10 overflow-hidden rounded-lg border border-border"
      aria-label="Needs attention"
      data-testid="workspace-briefing"
    >
      <div
        className={cn(
          "flex items-center gap-2 bg-muted/50 py-1.5 pl-4 pr-2",
          ((open && visible.length > 0) || error) && "border-b border-border",
        )}
      >
        <span className="text-2xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          Needs attention
        </span>
        {criticalCount > 0 && (
          <span
            className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive"
            data-testid="briefing-critical-count"
          >
            {criticalCount} critical
          </span>
        )}
        <span className="flex-1" />
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => update({ ...prefs, hidden: {} })}
            className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            data-testid="briefing-show-hidden"
          >
            {hiddenCount} hidden · Show
          </button>
        )}
        <button
          type="button"
          onClick={() => update({ ...prefs, collapsed: open })}
          aria-expanded={open}
          aria-label={open ? "Collapse" : "Expand"}
          className="flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          data-testid="briefing-toggle"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>

      {open && visible.length > 0 && (
        <ul className="divide-y divide-border">
          {visible.map((row) => (
            <Row key={row.key} row={row} onHide={() => hide(row)} />
          ))}
        </ul>
      )}

      {error && (
        <div
          className="bg-destructive/5 px-4 py-3 text-sm text-destructive"
          data-testid="workspace-briefing-error"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-xs font-medium text-destructive hover:underline"
          >
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
