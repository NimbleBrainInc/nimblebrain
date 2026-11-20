// ---------------------------------------------------------------------------
// ActionRows — the overview's next steps, as one list under the composer.
//
// Pure: it takes the ranked actions (`overviewActions`) and renders. Each row
// is an icon, what it is, and one muted line; the order is the ranking, so the
// list carries no section labels. The first `MAX_SHOWN` show and the rest fold
// behind "Show N more", so the most urgent row is always first.
//
// An alert (a facet, a connector, runs to review) can be hidden until it
// changes, a per-browser preference (`briefing-prefs.ts`). Setup and resume
// rows cannot: each goes away by itself once taken.
// ---------------------------------------------------------------------------

import {
  CircleAlert,
  CornerDownLeft,
  Info,
  type LucideIcon,
  OctagonAlert,
  Puzzle,
  Sparkles,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  type BriefingPrefs,
  isHidden,
  loadBriefingPrefs,
  saveBriefingPrefs,
} from "../../lib/briefing-prefs";
import { cn } from "../../lib/utils";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import type { ActionKind, ActionLevel, OverviewAction } from "./actions";

/** How many rows show before the rest fold behind "Show more". */
export const MAX_SHOWN = 5;

const LEVELS: Record<
  Exclude<ActionLevel, "none">,
  { icon: LucideIcon; tone: string; name: string }
> = {
  critical: { icon: OctagonAlert, tone: "text-destructive", name: "Critical" },
  warning: { icon: CircleAlert, tone: "text-warning", name: "Warning" },
  info: { icon: Info, tone: "text-muted-foreground", name: "Info" },
};

const KIND_ICONS: Partial<Record<ActionKind, LucideIcon>> = {
  plugin: Puzzle,
  ask: Sparkles,
  invite: UserPlus,
  resume: CornerDownLeft,
};

interface ActionRowsProps {
  /** Scopes the member's hidden rows. */
  workspaceId: string;
  /** Every action, most urgent first. */
  actions: readonly OverviewAction[];
  /** The briefing failed to load; its alerts are missing until a retry. */
  error: string | null;
  onRetry: () => void;
  onChoose: (action: OverviewAction) => void;
  /** A connector's icon, for rows that show one (conversation starters). */
  iconFor?: (serverName: string) => string | undefined;
}

function Row({
  action,
  onChoose,
  onHide,
  iconUrl,
}: {
  action: OverviewAction;
  onChoose: () => void;
  onHide?: () => void;
  iconUrl?: string;
}) {
  const level = action.level === "none" ? null : LEVELS[action.level];
  const Icon = level?.icon ?? KIND_ICONS[action.kind] ?? Sparkles;
  const tone = level?.tone ?? "text-primary";
  const actionable = action.target.type !== "none";
  return (
    <li
      className="group relative border-b border-border last:border-b-0"
      data-testid={action.testId}
      data-level={action.level}
    >
      <button
        type="button"
        onClick={onChoose}
        disabled={!actionable}
        className={cn(
          "flex w-full min-w-0 items-center gap-3.5 px-2.5 py-3 text-left text-sm",
          onHide && "pr-11",
          actionable
            ? "hover:bg-foreground/[0.04] transition-colors"
            : "cursor-default disabled:opacity-100",
        )}
      >
        {action.iconServer ? (
          <ConnectorIcon
            name={action.detail}
            iconUrl={iconUrl}
            className="size-[18px] shrink-0 rounded text-3xs"
          />
        ) : (
          <Icon className={cn("size-[18px] shrink-0", tone)} aria-hidden />
        )}
        {level && <span className="sr-only">{level.name}: </span>}
        {action.count !== null && (
          <span className={cn("shrink-0 font-bold tabular-nums", tone)}>{action.count}</span>
        )}
        <span
          className={cn(
            "shrink-0 font-semibold",
            action.muted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {action.title}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          <span className="sr-only"> · </span>
          {action.detail}
        </span>
      </button>
      {onHide && (
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide until it changes"
          title="Hide until it changes"
          data-testid="overview-action-hide"
          className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
        >
          <X className="size-4" />
        </button>
      )}
    </li>
  );
}

export function ActionRows({
  workspaceId,
  actions,
  error,
  onRetry,
  onChoose,
  iconFor,
}: ActionRowsProps) {
  const [prefs, setPrefs] = useState<BriefingPrefs>(() => loadBriefingPrefs(workspaceId));
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setPrefs(loadBriefingPrefs(workspaceId));
    setExpanded(false);
  }, [workspaceId]);
  const update = (next: BriefingPrefs) => {
    setPrefs(next);
    saveBriefingPrefs(workspaceId, next);
  };

  // Keep each hidden entry true to what the row says now. A row that went
  // away is forgotten, so its return shows. A hidden row whose count fell
  // records the lower count, so new work past it shows. A row that changed and
  // shows again is no longer hidden, so a later fall does not hide it again.
  const hideable = actions.filter((a) => a.signature !== null);
  useEffect(() => {
    const now = new Map(hideable.map((a) => [a.key, a.signature as string]));
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
    if (changed) update({ hidden });
  });

  const visible = actions.filter(
    (a) => a.signature === null || !isHidden(prefs, a.key, a.signature),
  );
  const hiddenCount = actions.length - visible.length;
  const shown = expanded ? visible : visible.slice(0, MAX_SHOWN);
  const folded = visible.length - shown.length;

  if (visible.length === 0 && hiddenCount === 0 && !error) return null;

  return (
    <section aria-label="Next steps" data-testid="overview-actions" className="mt-4">
      {shown.length > 0 && (
        <ul>
          {shown.map((action) => (
            <Row
              key={action.key}
              action={action}
              iconUrl={action.iconServer ? iconFor?.(action.iconServer) : undefined}
              onChoose={() => onChoose(action)}
              onHide={
                action.signature !== null
                  ? () =>
                      update({
                        hidden: { ...prefs.hidden, [action.key]: action.signature as string },
                      })
                  : undefined
              }
            />
          ))}
        </ul>
      )}

      {(folded > 0 || (expanded && visible.length > MAX_SHOWN) || hiddenCount > 0) && (
        <div className="mt-2 flex items-center gap-4 pl-[2.6rem] text-xs text-muted-foreground">
          {(folded > 0 || (expanded && visible.length > MAX_SHOWN)) && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="hover:text-foreground transition-colors"
              data-testid="overview-actions-more"
            >
              {expanded ? "Show fewer" : `Show ${folded} more`}
            </button>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => update({ hidden: {} })}
              className="hover:text-foreground transition-colors"
              data-testid="overview-actions-show-hidden"
            >
              {hiddenCount} hidden · Show
            </button>
          )}
        </div>
      )}

      {error && (
        <div
          className="mt-3 rounded-lg bg-destructive/5 px-4 py-3 text-sm text-destructive"
          data-testid="overview-actions-error"
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
