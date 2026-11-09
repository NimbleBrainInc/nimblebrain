// ---------------------------------------------------------------------------
// GlobalHomePage — workspace-agnostic landing at `/`
//
// A user in exactly one workspace goes straight into it: there is nothing to
// choose between. A user who chose a default workspace on this browser goes
// into it when the app loads here, and only then: a link to `/` from inside the
// app (the logo, the palette's Home) shows the grid, which is where the default
// is changed. `/?home` is a load that shows the grid regardless, for links that
// reload the page to escape a failing workspace (ADR-0060). Anyone else sees
// their workspaces here, each with its unread dot. The shell never remembers a
// last workspace (ADR-0044).
//
// With chat, conversations, tasks, and files identity-bound, the root URL is
// the user's cross-workspace landing, not a workspace home. It is
// intentionally minimal: greeting + a tiled grid of the user's workspaces
// (each tile links to its overview at `/w/<slug>/`).
// ---------------------------------------------------------------------------

import { House, Pin, Plus } from "lucide-react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { UnreadDot } from "../components/shell/UnreadDot";
import { useSession } from "../context/SessionContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";
import { useWorkspaceUnread } from "../context/WorkspaceUnreadContext";
import { useDefaultWorkspace } from "../lib/default-workspace";
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
  const location = useLocation();
  const { pinned, toggle: togglePin } = usePinnedWorkspaces();
  const { defaultId, toggle: toggleDefault } = useDefaultWorkspace();
  const ordered = orderWorkspacesForSidebar(wsCtx.workspaces, pinned);
  const [only] = wsCtx.workspaces;

  if (wsCtx.workspaces.length === 1 && only) {
    return <Navigate to={`/w/${toSlug(only.id)}/`} replace />;
  }

  // React Router keys the location the page loaded at "default"; every
  // navigation inside the app gets a fresh key.
  const isPageLoad = location.key === "default";
  const skipDefault = new URLSearchParams(location.search).has("home");
  const chosen = wsCtx.workspaces.find((ws) => ws.id === defaultId);
  if (isPageLoad && !skipDefault && chosen) {
    return <Navigate to={`/w/${toSlug(chosen.id)}/`} replace />;
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="global-home-page">
      <div className="max-w-5xl mx-auto px-(--page-gutter) py-12">
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
          <div className="grid grid-cols-1 @2xl/main:grid-cols-2 @3xl/main:grid-cols-3 gap-3">
            {ordered.map((ws) => (
              <WorkspaceTile
                key={ws.id}
                workspace={ws}
                pinned={pinned.has(ws.id)}
                onTogglePin={() => togglePin(ws.id)}
                isDefault={ws.id === defaultId}
                onToggleDefault={() => toggleDefault(ws.id)}
              />
            ))}
            <NewWorkspaceTile />
          </div>
        </section>
      </div>
    </div>
  );
}

// The tile's toggles are siblings of its link, laid over its right edge (an
// interactive control cannot nest in a link). Pinning orders the grid; the
// default decides where the app opens. They are separate so sorting a
// workspace never changes where the viewer lands.
function WorkspaceTile({
  workspace,
  pinned,
  onTogglePin,
  isDefault,
  onToggleDefault,
}: {
  workspace: WorkspaceInfo;
  pinned: boolean;
  onTogglePin: () => void;
  isDefault: boolean;
  onToggleDefault: () => void;
}) {
  const avatar = getWorkspaceAvatar(workspace);
  return (
    <div className="group/tile relative">
      <WorkspaceTileLink workspace={workspace} avatar={avatar} />
      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        <TileToggle
          on={isDefault}
          onClick={onToggleDefault}
          label={
            isDefault
              ? `Stop opening ${workspace.name} by default`
              : `Open ${workspace.name} by default`
          }
          title={isDefault ? "Opens by default" : "Open by default"}
          testId="home-workspace-default"
          workspaceId={workspace.id}
        >
          <House className={cn("w-4 h-4", isDefault && "fill-current")} aria-hidden="true" />
        </TileToggle>
        <TileToggle
          on={pinned}
          onClick={onTogglePin}
          label={pinned ? `Unpin ${workspace.name}` : `Pin ${workspace.name} to the top`}
          title={pinned ? "Unpin" : "Pin to top"}
          testId="home-workspace-pin"
          workspaceId={workspace.id}
        >
          <Pin className={cn("w-4 h-4", pinned && "fill-current")} aria-hidden="true" />
        </TileToggle>
      </div>
    </div>
  );
}

// A toggle that is on stays visible at rest; one that is off shows on hover or
// focus, and always on a touch screen, which has no hover.
function TileToggle({
  on,
  onClick,
  label,
  title,
  testId,
  workspaceId,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  title: string;
  testId: string;
  workspaceId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      title={title}
      data-testid={testId}
      data-workspace-id={workspaceId}
      className={cn(
        "p-1.5 rounded-sm text-muted-foreground",
        "hover:bg-foreground/10 hover:text-foreground transition-opacity",
        "focus-visible:opacity-100 group-hover/tile:opacity-100 [@media(pointer:coarse)]:opacity-100",
        on ? "opacity-60" : "opacity-0",
      )}
    >
      {children}
    </button>
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
        // Right padding leaves room for the two toggles laid over the tile.
        "group flex items-center gap-3 p-4 pr-20 rounded-sm border border-border bg-card",
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
