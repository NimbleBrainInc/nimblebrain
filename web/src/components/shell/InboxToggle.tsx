// ---------------------------------------------------------------------------
// InboxToggle — the top bar's bell, and a look at what is unread without
// leaving the page.
//
// The inbox is host chrome, not a placement: it belongs to the workspace
// rather than to any connector, so the host draws it and no connector may
// claim, reorder, or replace it. Connectors reach it by recording
// notifications, which is what lights the dot.
//
// A dot, not a count: the bell says there is something to read, and the
// number is in its accessible name and tooltip. It reads `NotificationsContext`
// — the same read the inbox page shows — so the two never disagree.
//
// The bell opens a preview of the newest unread items. Opening it marks
// nothing read: a glance is not a read. Choosing an item opens it in the inbox
// (`?item=`), which is where it is marked read, the same as a link from Slack
// or mail. The preview holds no state of its own between opens; it reads the
// inbox when it opens and again whenever `revision` moves while it is open.
// ---------------------------------------------------------------------------

import { Popover } from "@base-ui/react/popover";
import { AlertTriangle, Bell, Info, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  listNotifications,
  type NotificationLevel,
  type NotificationView,
} from "../../api/notifications";
import { useNotifications } from "../../context/NotificationsContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { INBOX_READ_MAX, LEVEL_RANK } from "../../lib/notification-levels";
import { cn } from "../../lib/utils";
import { toSlug } from "../../lib/workspace-slug";
import { Tooltip } from "../ui/tooltip";

/** How many unread items the preview shows. The rest are a click away. */
export const INBOX_PREVIEW_SIZE = 5;

const LEVEL_ICON: Record<NotificationLevel, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: "text-muted-foreground" },
  attention: { icon: AlertTriangle, className: "text-warning" },
  urgent: { icon: Zap, className: "text-destructive" },
};

/**
 * "5 min ago", "3 h ago", "2 d ago". Relative here and absolute on the inbox
 * page, because the preview answers "what is new" and the page answers "when";
 * the exact instant is on hover.
 */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * The unread items, read when the preview opens and re-read while it stays
 * open and `revision` moves. As many as one read returns rather than just the
 * shown five, so "Mark all read" can mark what it says, plus a read of the
 * unread items at attention and above, so an urgent one older than that set
 * still leads the five. A response that lands after a newer read was issued,
 * or after the preview closed, is dropped.
 */
function useUnreadPreview(workspaceId: string | undefined, open: boolean, revision: number) {
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the re-read signal
  useEffect(() => {
    const mine = ++seq.current;
    if (!open || !workspaceId) {
      setItems(null);
      setError(false);
      return;
    }
    Promise.all([
      listNotifications({ unreadOnly: true, limit: INBOX_READ_MAX }, workspaceId),
      listNotifications(
        { unreadOnly: true, level: "attention", limit: INBOX_PREVIEW_SIZE },
        workspaceId,
      ),
    ])
      .then(([newest, pressing]) => {
        if (mine !== seq.current) return;
        // Urgency first, then newest, so an urgent item is never the one cut
        // from the five shown.
        const byId = new Map(
          [...newest.notifications, ...pressing.notifications].map((n) => [n.id, n]),
        );
        setItems(
          [...byId.values()].sort(
            (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.seq - a.seq,
          ),
        );
        setError(false);
      })
      .catch(() => {
        if (mine === seq.current) setError(true);
      });
  }, [workspaceId, open, revision]);

  return { items, error };
}

export function InboxToggle() {
  const { activeWorkspace } = useWorkspaceContext();
  const { unread, revision, markRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const { items, error } = useUnreadPreview(activeWorkspace?.id, open, revision);
  const { connectors } = useWorkspaceAppIcons();
  if (!activeWorkspace) return null;

  const inboxPath = `/w/${toSlug(activeWorkspace.id)}/notifications`;
  const label = unread > 0 ? `Inbox, ${unread} unread` : "Inbox";
  const appName = (source: string) =>
    connectors?.installed.find((c) => c.serverName === source)?.displayName ?? source;
  const close = () => setOpen(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={label}>
        <Popover.Trigger
          aria-label={label}
          data-testid="top-bar-inbox"
          className="relative flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-foreground/10 data-[popup-open]:bg-foreground/10"
        >
          <Bell aria-hidden="true" className="size-[18px]" />
          {unread > 0 && (
            <span
              aria-hidden="true"
              data-testid="top-bar-inbox-dot"
              className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
            />
          )}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          {/* Focus the panel, not its first tabbable: on open the items are
              still loading, which would leave the footer as the first. */}
          <Popover.Popup
            ref={popupRef}
            initialFocus={popupRef}
            data-testid="inbox-preview"
            className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-border/60 bg-popover text-popover-foreground shadow-lg outline-none"
          >
            <div className="flex items-center justify-between gap-4 border-b border-border/60 px-3 py-2.5">
              <Popover.Title className="text-sm font-semibold">Inbox</Popover.Title>
              {items && items.length > 0 ? (
                <button
                  type="button"
                  data-testid="inbox-preview-mark-all"
                  onClick={() => markRead(items.map((item) => item.id))}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {/* "All" only when the read holds every unread item. */}
                  {unread > items.length ? `Mark ${items.length} read` : "Mark all read"}
                </button>
              ) : null}
            </div>

            <PreviewBody
              items={items}
              error={error}
              inboxPath={inboxPath}
              appName={appName}
              onOpen={close}
            />

            <Link
              to={inboxPath}
              onClick={close}
              data-testid="inbox-preview-view-all"
              className="block border-t border-border/60 px-3 py-2.5 text-center text-sm font-medium text-primary transition-colors hover:bg-foreground/5"
            >
              {items && items.length > INBOX_PREVIEW_SIZE
                ? `View all ${unread} unread in the inbox`
                : "Open the inbox"}
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What sits between the header and the footer: a state line, or the items. */
function PreviewBody({
  items,
  error,
  inboxPath,
  appName,
  onOpen,
}: {
  items: NotificationView[] | null;
  error: boolean;
  inboxPath: string;
  appName: (source: string) => string;
  onOpen: () => void;
}) {
  const state = error
    ? "Could not read the inbox."
    : items === null
      ? "Loading…"
      : items.length === 0
        ? "You're all caught up."
        : null;
  if (state || !items) {
    return (
      <p
        data-testid={items?.length === 0 ? "inbox-preview-empty" : undefined}
        className="px-3 py-6 text-center text-sm text-muted-foreground"
      >
        {state}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border/60">
      {items.slice(0, INBOX_PREVIEW_SIZE).map((item) => {
        const level = LEVEL_ICON[item.level];
        return (
          <li key={item.id}>
            <Link
              to={`${inboxPath}?item=${encodeURIComponent(item.id)}`}
              onClick={onOpen}
              data-testid="inbox-preview-item"
              className="flex items-start gap-2.5 px-3 py-2.5 transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-none"
            >
              <level.icon
                aria-hidden="true"
                className={cn("mt-0.5 size-4 shrink-0", level.className)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {appName(item.source)}
                </span>
              </span>
              <time
                dateTime={item.timestamp}
                title={new Date(item.timestamp).toLocaleString()}
                className="shrink-0 text-xs text-muted-foreground"
              >
                {formatAgo(item.timestamp)}
              </time>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
