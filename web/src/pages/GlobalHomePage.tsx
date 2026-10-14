// ---------------------------------------------------------------------------
// GlobalHomePage — workspace-agnostic landing at `/`
//
// A user in exactly one workspace goes straight into it: there is nothing to
// choose between. Anyone else sees their workspaces here, each with its unread
// dot. Which workspace to open is never remembered or defaulted (ADR-0044).
//
// With chat, conversations, tasks, and files identity-bound, the root URL is
// the user's cross-workspace landing, not a workspace home. It is
// intentionally minimal: greeting + a tiled grid of the user's workspaces
// (each tile links to its overview at `/w/<slug>/`).
// ---------------------------------------------------------------------------

import { Pin, Plus } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { UnreadDot } from "../components/shell/UnreadDot";
import { useSession } from "../context/SessionContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";
import { useWorkspaceUnread } from "../context/WorkspaceUnreadContext";
import { getGreeting } from "../lib/greeting";
import { usePinnedWorkspaces } from "../lib/pinned-workspaces";
import { cn } from "../lib/utils";
import { getWorkspaceAvatar } from "../lib/workspace-avatar";
import { orderWorkspacesForSidebar } from "../lib/workspace-order";
import { toSlug } from "../lib/workspace-slug";

export function GlobalHomePage() {
  const wsCtx = useWorkspaceContext();
  const session = useSession();
  const greeting = getGreeting();
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const name = session?.user?.displayName ?? session?.user?.email ?? "";
  const { pinned, toggle: togglePin } = usePinnedWorkspaces();
  const ordered = orderWorkspacesForSidebar(wsCtx.workspaces, pinned);
  const [only] = wsCtx.workspaces;

  if (wsCtx.workspaces.length === 1 && only) {
    return <Navigate to={`/w/${toSlug(only.id)}/`} replace />;
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="global-home-page">
      <div className="max-w-5xl mx-auto px-8 py-12">
        <header className="mb-10">
          <h1 className="text-4xl font-heading font-medium text-foreground">
            {greeting}
            {name && `, ${name}`}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{today}</p>
        </header>

        <section>
          <h2 className="text-2xs font-bold tracking-[0.08em] uppercase text-muted-foreground mb-3">
            Your workspaces
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {ordered.map((ws) => (
              <WorkspaceTile
                key={ws.id}
                workspace={ws}
                pinned={pinned.has(ws.id)}
                onTogglePin={() => togglePin(ws.id)}
              />
            ))}
            <NewWorkspaceTile />
          </div>
        </section>
      </div>
    </div>
  );
}

// The pin toggle is a sibling of the tile's link, laid over its right edge (an
// interactive control cannot nest in a link).
function WorkspaceTile({
  workspace,
  pinned,
  onTogglePin,
}: {
  workspace: WorkspaceInfo;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const avatar = getWorkspaceAvatar(workspace);
  return (
    <div className="group/tile relative">
      <WorkspaceTileLink workspace={workspace} avatar={avatar} />
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={pinned ? `Unpin ${workspace.name}` : `Pin ${workspace.name} to the top`}
        aria-pressed={pinned}
        title={pinned ? "Unpin" : "Pin to top"}
        data-testid="home-workspace-pin"
        data-workspace-id={workspace.id}
        className={cn(
          "absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-sm text-muted-foreground",
          "hover:bg-foreground/10 hover:text-foreground transition-opacity",
          "focus-visible:opacity-100 group-hover/tile:opacity-100 [@media(pointer:coarse)]:opacity-100",
          pinned ? "opacity-60" : "opacity-0",
        )}
      >
        <Pin className={cn("w-4 h-4", pinned && "fill-current")} aria-hidden="true" />
      </button>
    </div>
  );
}

function WorkspaceTileLink({
  workspace,
  avatar,
}: {
  workspace: WorkspaceInfo;
  avatar: ReturnType<typeof getWorkspaceAvatar>;
}) {
  const unread = useWorkspaceUnread().unreadFor(workspace.id) > 0;
  return (
    <Link
      to={`/w/${toSlug(workspace.id)}/`}
      data-testid="home-workspace-tile"
      data-workspace-id={workspace.id}
      className={cn(
        // Right padding leaves room for the pin toggle laid over the tile.
        "group flex items-center gap-3 p-4 pr-12 rounded-sm border border-border bg-card",
        "hover:border-foreground/20 hover:bg-foreground/[0.02] transition-colors",
      )}
    >
      <span
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center rounded-sm text-white text-sm font-semibold"
        style={{ width: 32, height: 32, backgroundColor: avatar.color }}
      >
        {avatar.letter}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{workspace.name}</span>
          {unread && (
            <>
              <UnreadDot />
              <span className="sr-only">Unread notifications</span>
            </>
          )}
        </div>
        {/* Only an exception is worth a line: most tiles are the viewer's own
            workspaces, where "admin" on every tile says nothing. */}
        {workspace.userRole && workspace.userRole !== "admin" && (
          <div className="truncate text-xs text-muted-foreground">{workspace.userRole}</div>
        )}
      </div>
    </Link>
  );
}

function NewWorkspaceTile() {
  return (
    <Link
      to="/org/workspaces"
      data-testid="home-new-workspace-tile"
      className={cn(
        "flex flex-col items-center justify-center gap-2 p-4 rounded-sm border border-dashed border-border",
        "text-muted-foreground hover:text-foreground hover:border-foreground/20 hover:bg-foreground/[0.02] transition-colors",
        "min-h-[100px]",
      )}
    >
      <Plus className="w-5 h-5" />
      <span className="text-sm">New workspace</span>
    </Link>
  );
}
