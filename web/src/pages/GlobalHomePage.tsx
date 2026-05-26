// ---------------------------------------------------------------------------
// GlobalHomePage — workspace-agnostic landing at `/`
//
// Stage 2 follow-up: with chat, conversations, automations, and files now
// identity-bound, the root URL is no longer "workspace home" — it's the
// user's cross-workspace landing. v1 is intentionally minimal: greeting +
// a tiled grid of the user's workspaces (each tile links to its overview
// at `/w/<slug>/`). Recent conversations / files / automations layer in
// when their data sources are ready, without changing the page shape.
// ---------------------------------------------------------------------------

import { Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { useSession } from "../context/SessionContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";
import { getGreeting } from "../lib/greeting";
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
  const ordered = orderWorkspacesForSidebar(wsCtx.workspaces);

  return (
    <div className="h-full overflow-y-auto" data-testid="global-home-page">
      <div className="max-w-5xl mx-auto px-8 py-12">
        <header className="mb-10">
          <h1 className="text-4xl font-serif font-medium text-foreground">
            {greeting}
            {name && `, ${name}`}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{today}</p>
        </header>

        <section>
          <h2 className="text-[11px] font-bold tracking-[0.08em] uppercase text-muted-foreground mb-3">
            Your workspaces
          </h2>
          {wsCtx.loading ? (
            <div className="text-sm text-muted-foreground">Loading workspaces…</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {ordered.map((ws) => (
                <WorkspaceTile key={ws.id} workspace={ws} />
              ))}
              <NewWorkspaceTile />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function WorkspaceTile({ workspace }: { workspace: WorkspaceInfo }) {
  const avatar = getWorkspaceAvatar(workspace);
  // App count intentionally omitted from this tile: the underlying
  // `WorkspaceInfo.bundles[]` arrives empty for some workspaces post-
  // Stage-2 even when apps exist (data-path bug, separate fix), and
  // showing a stale "0 apps" line on a workspace that has apps is
  // worse than showing nothing. The workspace overview page reads
  // from the placement registry (single source of truth) and shows
  // the correct count, so the user sees accurate data one click in.
  return (
    <Link
      to={`/w/${toSlug(workspace.id)}/`}
      data-testid="home-workspace-tile"
      data-workspace-id={workspace.id}
      className={cn(
        "group flex items-center gap-3 p-4 rounded-lg border border-border bg-card",
        "hover:border-foreground/20 hover:bg-foreground/[0.02] transition-colors",
      )}
    >
      <span
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center rounded-md text-white text-sm font-semibold"
        style={{ width: 32, height: 32, backgroundColor: avatar.color }}
      >
        {avatar.letter}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{workspace.name}</div>
        {workspace.userRole && (
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
        "flex flex-col items-center justify-center gap-2 p-4 rounded-lg border border-dashed border-border",
        "text-muted-foreground hover:text-foreground hover:border-foreground/20 hover:bg-foreground/[0.02] transition-colors",
        "min-h-[100px]",
      )}
    >
      <Plus className="w-5 h-5" />
      <span className="text-sm">New workspace</span>
    </Link>
  );
}
