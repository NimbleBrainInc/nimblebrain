// ---------------------------------------------------------------------------
// ActionCards — the overview's next steps, as a few cards.
//
// Pure: it takes the ranked actions (`overviewActions`) and renders. The first
// `MAX_SHOWN` show; the rest fold behind "Show N more", so the page stays short
// and the most urgent card is always first. Each card says what it is, where it
// comes from, and what choosing it does.
//
// An alert (a facet, a connector, runs to review) can be hidden until it
// changes, a per-browser preference (`briefing-prefs.ts`). Setup and resume
// cards cannot: each goes away by itself once taken.
// ---------------------------------------------------------------------------

import { CircleAlert, Info, type LucideIcon, OctagonAlert, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type BriefingPrefs,
  isHidden,
  loadBriefingPrefs,
  saveBriefingPrefs,
} from "../../lib/briefing-prefs";
import { cn } from "../../lib/utils";
import type { ActionLevel, OverviewAction } from "./actions";

/** How many cards show before the rest fold behind "Show more". */
export const MAX_SHOWN = 3;

const LEVELS: Record<ActionLevel, { icon: LucideIcon; badge: string; name: string }> = {
  critical: { icon: OctagonAlert, badge: "bg-destructive/10 text-destructive", name: "Critical" },
  warning: { icon: CircleAlert, badge: "bg-warning/10 text-warning", name: "Warning" },
  info: { icon: Info, badge: "bg-muted text-muted-foreground", name: "Info" },
  none: { icon: Sparkles, badge: "bg-primary/10 text-primary", name: "" },
};

interface ActionCardsProps {
  /** Scopes the member's hidden cards. */
  workspaceId: string;
  /** Every action, most urgent first. */
  actions: readonly OverviewAction[];
  /** The briefing failed to load; its alerts are missing until a retry. */
  error: string | null;
  onRetry: () => void;
  onChoose: (action: OverviewAction) => void;
}

function heading(first: OverviewAction | undefined): string | null {
  if (!first) return null;
  if (first.level !== "none") return "Needs you";
  return first.key.startsWith("setup:") ? "Get started" : "Continue";
}

function Card({
  action,
  onChoose,
  onHide,
}: {
  action: OverviewAction;
  onChoose: () => void;
  onHide?: () => void;
}) {
  const { icon: Icon, badge, name } = LEVELS[action.level];
  const actionable = action.target.type !== "none";
  return (
    <li
      className={cn(
        "group relative flex min-w-0 flex-col rounded-lg border border-border bg-card",
        actionable && "hover:border-foreground/20 hover:bg-foreground/5 transition-colors",
      )}
      data-testid={action.testId}
      data-level={action.level}
    >
      <button
        type="button"
        onClick={onChoose}
        disabled={!actionable}
        className="flex h-full min-w-0 flex-col gap-1 p-4 text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center gap-2.5 pr-6">
          <span
            className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", badge)}
            aria-hidden
          >
            <Icon className="size-4" />
          </span>
          {name && <span className="sr-only">{name}: </span>}
          {action.count !== null && (
            <span className="shrink-0 text-lg font-semibold tabular-nums text-foreground">
              {action.count}
            </span>
          )}
          <span
            className={cn(
              "min-w-0 truncate text-sm font-medium",
              action.muted ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {action.title}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          <span className="sr-only"> · </span>
          {action.detail}
        </span>
        {actionable && (
          <span className="mt-1 text-xs font-semibold text-primary" aria-hidden>
            {action.verb} →
          </span>
        )}
      </button>
      {onHide && (
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide until it changes"
          title="Hide until it changes"
          data-testid="overview-action-hide"
          className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
        >
          <X className="size-4" />
        </button>
      )}
    </li>
  );
}

export function ActionCards({ workspaceId, actions, error, onRetry, onChoose }: ActionCardsProps) {
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

  // Keep each hidden entry true to what the card says now. A card that went
  // away is forgotten, so its return shows. A hidden card whose count fell
  // records the lower count, so new work past it shows. A card that changed and
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
  const label = heading(visible[0]);

  if (visible.length === 0 && hiddenCount === 0 && !error) return null;

  return (
    <section aria-label={label ?? "Next steps"} data-testid="overview-actions">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div className="text-2xs font-bold uppercase tracking-[0.08em] text-muted-foreground">
          {label ?? "Next steps"}
        </div>
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => update({ hidden: {} })}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="overview-actions-show-hidden"
          >
            {hiddenCount} hidden · Show
          </button>
        )}
      </div>

      {shown.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-3">
          {shown.map((action) => (
            <Card
              key={action.key}
              action={action}
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

      {(folded > 0 || (expanded && visible.length > MAX_SHOWN)) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="overview-actions-more"
        >
          {expanded ? "Show fewer" : `Show ${folded} more`}
        </button>
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
