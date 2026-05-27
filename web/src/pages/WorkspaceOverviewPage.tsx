// ---------------------------------------------------------------------------
// WorkspaceOverviewPage — workspace landing at `/w/<slug>/`
//
// Stage 2 follow-up: the workspace's apps used to surface in a bottom
// `APPS` group in the sidebar. That section is gone; this page is where
// app discovery lives now. The sidebar still shows the active workspace's
// app names inline (quick-access), but the full grid + workspace metadata
// lives here.
//
// v1 scope (per Mat 2026-05-23): header + all-apps grid. Filter chips
// (All / Pinned / With UI / Tools only), pin/recent state, and "View all
// N apps" truncation land in follow-ups when the underlying per-user-
// per-workspace state exists.
//
// App data source: `forSlot("sidebar")` filtered to grouped sub-slots
// (everything under `sidebar.<group>`). The placement registry is
// already workspace-scoped server-side, so this is the right surface —
// the same data that used to feed the bottom `APPS` group.
// ---------------------------------------------------------------------------

import { Settings } from "lucide-react";
import { useCallback } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { BriefingAction } from "../_generated/platform-schemas/home";
import { BriefingView } from "../components/briefing/BriefingView";
import { useShellContext } from "../context/ShellContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";
import { useWorkspaceBriefing } from "../hooks/useWorkspaceBriefing";
import { resolveIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { toSlug } from "../lib/workspace-slug";
import type { PlacementEntry } from "../types";

export function WorkspaceOverviewPage() {
  const { slug } = useParams<{ slug: string }>();
  const wsCtx = useWorkspaceContext();
  const shell = useShellContext();
  const navigate = useNavigate();

  const workspace = slug ? wsCtx.workspaces.find((w) => toSlug(w.id) === slug) : undefined;

  // The briefing is workspace-scoped server-side via X-Workspace-Id (= the
  // active workspace). Key the fetch on the active workspace id so the header
  // and the fetch stay in lockstep (see useWorkspaceBriefing for the rationale).
  const {
    briefing,
    loading: briefingLoading,
    error: briefingError,
    refresh: refreshBriefing,
  } = useWorkspaceBriefing(wsCtx.activeWorkspace?.id);

  const handleBriefingAction = useCallback(
    (action: BriefingAction) => {
      if (action.type !== "navigate" || !action.route) return;
      // Facet navigate actions carry the app's route (e.g. "@scope/name").
      // Absolute paths pass through; bare routes open the app in this workspace.
      navigate(action.route.startsWith("/") ? action.route : `/w/${slug}/app/${action.route}`);
    },
    [navigate, slug],
  );

  if (wsCtx.loading) {
    return (
      <div className="p-8 text-sm text-muted-foreground" data-testid="workspace-overview-loading">
        Loading workspace…
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="p-8 text-sm text-muted-foreground" data-testid="workspace-overview-not-found">
        Workspace not found.
      </div>
    );
  }

  // Apps come from the placement registry's grouped sub-slots (anything under
  // `sidebar.<group>`). Bare `sidebar` items (Home, Conversations, …) are core
  // nav, not apps.
  //
  // Readiness — not just "is there a shell?". The shell holds ONE workspace's
  // placements at a time and lags a switch (old data stays visible while the
  // refetch is in flight, with no `loading` flag — see ShellContext). Compare
  // the shell's workspace to THIS page's workspace (`workspace.id`, derived
  // from the route slug — the stable truth; the active workspace converges to
  // it after the route guard's sync effect). Until they match, the shell is
  // still showing the previous workspace's apps, so the grid is "not ready"
  // and must render a skeleton, never the empty state. Placements are
  // registered eagerly server-side, so a matching shell resolves near-instantly
  // — apps don't wait on the (slower, async) briefing.
  const appsReady = shell != null && shell.shellWorkspaceId === workspace.id;
  const apps =
    appsReady && shell
      ? shell
          .forSlot("sidebar")
          .filter((p) => p.slot.startsWith("sidebar.") && !p.slot.startsWith("sidebar.bottom"))
      : [];

  return (
    <div className="h-full overflow-y-auto" data-testid="workspace-overview-page">
      <div className="max-w-6xl mx-auto px-8 py-10">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div
              className="text-[11px] font-bold tracking-[0.08em] uppercase text-muted-foreground"
              data-testid="workspace-overview-breadcrumb"
            >
              Workspace · {workspace.id}
            </div>
            <h1 className="mt-1 text-3xl font-serif font-medium text-foreground">
              {workspace.name}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground italic">
              {describeWorkspace(workspace, appsReady ? apps.length : null)}
            </p>
          </div>
          <Link
            to={`/w/${toSlug(workspace.id)}/settings/general`}
            data-testid="workspace-overview-settings"
            className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/[0.02] hover:border-foreground/20 transition-colors"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Settings</span>
          </Link>
        </header>

        {/* Briefing — LLM summary of recent workspace activity, generated from
            the installed apps' declared facets. Restored from the pre-reorg
            home surface. */}
        <div className="mb-10">
          <BriefingView
            briefing={briefing}
            loading={briefingLoading}
            error={briefingError}
            onRetry={refreshBriefing}
            onAction={handleBriefingAction}
          />
        </div>

        <div className="text-[11px] font-bold tracking-[0.08em] uppercase text-muted-foreground mb-3">
          Available apps
        </div>
        {!appsReady ? (
          <AppGridSkeleton />
        ) : apps.length === 0 ? (
          <div
            className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
            data-testid="workspace-overview-empty"
          >
            No apps installed in this workspace yet.
          </div>
        ) : (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
            data-testid="workspace-overview-app-grid"
          >
            {apps.map((p) => (
              <AppCard
                key={p.resourceUri}
                placement={p}
                onOpen={() => {
                  if (!p.route) return;
                  navigate(`/w/${toSlug(workspace.id)}/app/${p.route}`);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// `appCount === null` means the app list hasn't resolved for this workspace
// yet — show only the member count (known immediately from the workspace
// list) rather than flashing a wrong "0 apps installed".
function describeWorkspace(workspace: WorkspaceInfo, appCount: number | null): string {
  const members = `${workspace.memberCount} ${workspace.memberCount === 1 ? "member" : "members"}`;
  if (appCount === null) return `${members}.`;
  const apps = `${appCount} ${appCount === 1 ? "app installed" : "apps installed"}`;
  return `${apps}, ${members}.`;
}

// Loading placeholder for the app grid: shown while the shell hasn't caught up
// to this workspace (switch / deep-link window). Mirrors AppCard's shape so the
// grid doesn't jump when real cards replace it. A fixed three-card placeholder
// — the real count is unknown until the shell resolves.
function AppGridSkeleton() {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
      data-testid="workspace-overview-apps-skeleton"
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2 p-4 rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 shrink-0 rounded bg-muted-foreground/20 animate-pulse" />
            <div className="h-3.5 w-2/3 rounded bg-muted-foreground/20 animate-pulse" />
          </div>
          <div className="h-2.5 w-1/3 rounded bg-muted-foreground/20 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function AppCard({ placement, onOpen }: { placement: PlacementEntry; onOpen: () => void }) {
  const Icon = placement.icon ? resolveIcon(placement.icon) : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="workspace-overview-app-card"
      data-app-route={placement.route ?? ""}
      className={cn(
        "group flex flex-col gap-2 p-4 rounded-lg border border-border bg-card text-left",
        "hover:border-foreground/20 hover:bg-foreground/[0.02] transition-colors",
      )}
    >
      <div className="flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
        <div className="truncate text-sm font-medium text-foreground">
          {placement.label ?? placement.route ?? "App"}
        </div>
      </div>
      <div className="text-[10px] font-medium tracking-[0.04em] uppercase text-muted-foreground">
        {describePlacementType(placement)}
      </div>
    </button>
  );
}

/**
 * Best-effort type pill for v1. A placement with a `route` registers UI,
 * so we render it as "MCP App · UI". A placement without a route (rare
 * in `sidebar.<group>`) is treated as tool-only. When bundle manifests
 * expose richer type metadata via the placement, we can refine this.
 */
function describePlacementType(p: PlacementEntry): string {
  return p.route ? "MCP App · UI" : "Tool server";
}
