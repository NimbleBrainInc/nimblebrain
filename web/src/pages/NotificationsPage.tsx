import { AlertTriangle, Bell, ChevronRight, Info, Zap } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DeliveryRecord, NotificationLevel, NotificationView } from "../api/notifications";
import { Button } from "../components/ui/button";
import { useNotifications } from "../context/NotificationsContext";
import { useShellContext } from "../context/ShellContext";
import { LEVEL_RANK } from "../lib/notification-levels";
import { resolveNotificationLink } from "../lib/notification-link";
import { cn } from "../lib/utils";
import { EmptyState, InlineError, SettingsPageHeader } from "./settings/components";

/**
 * The inbox — what this workspace's connectors recorded without being asked.
 *
 * One scrolling column, each item expanding in place, because this renders in
 * the main-area slot beside the docked chat and that column is narrow (see
 * `web/DESIGN.md`). No master/detail.
 *
 * **Everything a connector wrote is text.** `title`, `subject` and `body` are
 * plain strings from a third-party server, rendered as plain strings: no
 * markdown, no HTML, and no clickable affordance built out of a URI the host
 * cannot resolve. That is not styling restraint, it is the boundary — an inbox
 * that rendered connector markup would be a third-party server drawing in the
 * operator's own chrome.
 *
 * `data` is the connector's structured payload. The runtime forwards it unread,
 * and this page shows it only behind a labelled disclosure, as raw JSON, so
 * nobody mistakes it for something the platform interpreted.
 */

const LEVEL_META: Record<
  NotificationLevel,
  { label: string; icon: typeof Info; className: string }
> = {
  info: { label: "Info", icon: Info, className: "text-muted-foreground" },
  attention: { label: "Attention", icon: AlertTriangle, className: "text-warning" },
  urgent: { label: "Urgent", icon: Zap, className: "text-destructive" },
};

/** Absolute, not relative: "2 hours ago" hides the one thing an operator is checking. */
function formatInstant(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

export function NotificationsPage() {
  const { slug } = useParams<{ slug: string }>();
  const shell = useShellContext();
  const { items, unread, loading, error, atPageLimit, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const placements = useMemo(
    () => (shell ? [...shell.forSlot("sidebar"), ...shell.forSlot("main")] : []),
    [shell],
  );

  // Urgency first, then newest. An inbox read top-down should not make somebody
  // scroll past a week of routine items to find the one thing on fire; within a
  // level the order is the arrival order the store assigned.
  const ordered = useMemo(
    () => [...items].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.seq - a.seq),
    [items],
  );

  const toggle = useCallback(
    (item: NotificationView) => {
      setOpen((current) => {
        const next = new Set(current);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
      // Opening an item is reading it. Closing one is not un-reading it.
      if (!open.has(item.id) && !item.readAt) void markRead([item.id]);
    },
    [open, markRead],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <SettingsPageHeader
          title="Inbox"
          description="Facts this workspace's connectors recorded without being asked — a domain went active, a reply landed. Everything here is content a connector wrote, not something the platform concluded."
          action={
            unread > 0 ? (
              <Button variant="outline" size="sm" onClick={() => void markAllRead()}>
                Mark all read
              </Button>
            ) : null
          }
        />

        {error ? <InlineError message={error} /> : null}

        {loading && ordered.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : null}

        {!loading && ordered.length === 0 && !error ? (
          <EmptyState
            message={
              <>
                Nothing yet. This fills when a connector that declares an outbox has something to
                report — the runtime polls it and files what it finds here.{" "}
                {slug ? (
                  <Link className="underline" to={`/w/${slug}/settings/notifications`}>
                    Notification settings
                  </Link>
                ) : (
                  "Notification settings"
                )}{" "}
                lists the connectors in this workspace that do.
              </>
            }
          />
        ) : null}

        <ul className="space-y-px">
          {ordered.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              expanded={open.has(item.id)}
              onToggle={() => toggle(item)}
              href={
                item.link ? resolveNotificationLink(item.link.resource, placements, slug) : null
              }
            />
          ))}
        </ul>

        {atPageLimit ? (
          <p className="text-xs text-muted-foreground">
            Showing the most recent {ordered.length}. Older items stay in the inbox for 90 days and
            are reachable by asking the agent for them.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NotificationRow({
  item,
  expanded,
  onToggle,
  href,
}: {
  item: NotificationView;
  expanded: boolean;
  onToggle: () => void;
  href: string | null;
}) {
  const level = LEVEL_META[item.level];
  const LevelIcon = level.icon;
  const unread = !item.readAt;

  return (
    <li className="rounded-sm border border-border/60 bg-card">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="notification-row"
        data-level={item.level}
        data-unread={unread ? "true" : "false"}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left rounded-sm hover:bg-muted/50 transition-colors"
      >
        <LevelIcon aria-hidden="true" className={cn("size-4 shrink-0 mt-0.5", level.className)} />
        <span className="min-w-0 flex-1">
          <span className={cn("block text-sm truncate", unread && "font-semibold")}>
            {item.title}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{item.source}</span>
            <span aria-hidden="true">·</span>
            <span>{formatInstant(item.timestamp)}</span>
            {item.subject ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{item.subject}</span>
              </>
            ) : null}
            <span className="sr-only">{`${level.label}${unread ? ", unread" : ""}`}</span>
          </span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className={cn("size-4 shrink-0 mt-0.5 transition-transform", expanded && "rotate-90")}
        />
      </button>

      {expanded ? (
        <div className="px-3 pb-3 pt-0 space-y-3 border-t border-border/60">
          {item.body ? (
            // `whitespace-pre-wrap` on a plain string. The server's newlines
            // survive; nothing else it wrote is interpreted.
            <p className="text-sm whitespace-pre-wrap break-words pt-3">{item.body}</p>
          ) : null}

          {item.link ? <NotificationLink uri={item.link.resource} href={href} /> : null}

          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <dt>Event</dt>
            <dd className="font-mono text-foreground/80">{item.name}</dd>
            <dt>Received</dt>
            <dd>{formatInstant(item.receivedAt)}</dd>
          </dl>

          {item.deliveries && item.deliveries.length > 0 ? (
            <DeliveryLedger rows={item.deliveries} />
          ) : null}

          <RawDetails data={item.data} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The link, as a link only where the shell can open it.
 *
 * See `resolveNotificationLink` for the rule. A URI the shell cannot resolve is
 * still shown — an operator can read it, and it is often the only way to tell
 * which record upstream the item is about — but it is text, and a URI that
 * looks like a link and does nothing is worse than one that never claimed to be.
 */
function NotificationLink({ uri, href }: { uri: string; href: string | null }) {
  if (href) {
    return (
      <Link to={href} className="inline-flex items-center gap-1.5 text-sm text-primary underline">
        <Bell aria-hidden="true" className="size-3.5" />
        Open
      </Link>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Linked resource: <code className="font-mono break-all">{uri}</code>
    </p>
  );
}

/** One row per route target that has been tried. */
function DeliveryLedger({ rows }: { rows: DeliveryRecord[] }) {
  return (
    <div className="space-y-1.5" data-testid="delivery-ledger">
      <p className="text-xs font-semibold">Delivery</p>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={`${row.routeId}:${row.target}`} className="text-xs text-muted-foreground">
            <span className="font-mono text-foreground/80">{row.target}</span>{" "}
            <span
              className={cn(
                row.outcome === "failed" && "text-destructive",
                row.outcome === "delivered" && "text-success",
              )}
            >
              {row.outcome}
            </span>
            {row.attempts > 1 ? ` after ${row.attempts} attempts` : null}
            {row.lastError ? <span className="block break-words">{row.lastError}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The connector's own payload, collapsed and labelled as raw.
 *
 * The runtime never reads a field of it, so neither does this page: it is
 * printed as JSON. Labelling it is the point — an operator opening this should
 * know they are looking at what a third-party server sent, not at anything the
 * platform verified or acted on.
 */
function RawDetails({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? "Hide" : "Show"} details — raw data from the connector
      </button>
      {open ? (
        <pre className="mt-1.5 max-h-64 overflow-auto rounded-sm bg-muted/50 p-2 text-2xs font-mono whitespace-pre-wrap break-words">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
