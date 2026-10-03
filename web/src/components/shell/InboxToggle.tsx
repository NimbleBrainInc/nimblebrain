// ---------------------------------------------------------------------------
// InboxToggle — the top bar's bell, the way to the focused workspace's inbox.
//
// The inbox is host chrome, not a placement: it belongs to the workspace
// rather than to any connector, so the host draws it and no connector may
// claim, reorder, or replace it. Connectors reach it by recording
// notifications, which is what lights the dot.
//
// A dot, not a count: the bell says there is something to read, and the
// number is in its accessible name and tooltip. It reads `NotificationsContext`
// — the same read the inbox page shows — so the two never disagree.
// ---------------------------------------------------------------------------

import { Bell } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useNotifications } from "../../context/NotificationsContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { cn } from "../../lib/utils";
import { toSlug } from "../../lib/workspace-slug";
import { Tooltip } from "../ui/tooltip";

export function InboxToggle() {
  const { activeWorkspace } = useWorkspaceContext();
  const { unread } = useNotifications();
  const { pathname } = useLocation();
  if (!activeWorkspace) return null;

  const to = `/w/${toSlug(activeWorkspace.id)}/notifications`;
  const current = pathname === to;
  const label = unread > 0 ? `Inbox, ${unread} unread` : "Inbox";

  return (
    <Tooltip label={label}>
      <Link
        to={to}
        aria-label={label}
        aria-current={current ? "page" : undefined}
        data-testid="top-bar-inbox"
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-foreground/10",
          current && "bg-foreground/10",
        )}
      >
        <Bell aria-hidden="true" className="size-[18px]" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            data-testid="top-bar-inbox-dot"
            className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </Link>
    </Tooltip>
  );
}
