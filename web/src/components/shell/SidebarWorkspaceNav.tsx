// ---------------------------------------------------------------------------
// SidebarWorkspaceNav — Stage 2 / T013 (Q1, locked 2026-05-22)
//
// The WORKSPACES section that replaces the deleted header switcher.
// Lists every workspace the identity belongs to (read from
// `WorkspaceContext`), ordered personal-first then shared
// alphabetically (per task spec acceptance criterion). Each row
// expands to reveal its installed apps; selecting an app navigates
// into it and pushes `setActiveWorkspaceId` for the per-request
// `X-Workspace-Id` header.
//
// The `+` affordance on the heading routes to the existing
// "Create workspace" page (`/settings/org/workspaces`) — the task
// spec is explicit that this MUST reuse the existing flow, not
// invent new UX.
//
// Expansion state is tracked locally (Set<string>) and seeded with
// the active workspace so the user always sees the active workspace's
// apps without an extra click. The set is intentionally not
// persisted across reloads — the active workspace + last-viewed app
// (persisted by WorkspaceAppList) are the durable state; transient
// expansion of other workspaces is a per-session affordance.
// ---------------------------------------------------------------------------

import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { orderWorkspacesForSidebar } from "../../lib/workspace-order";
import { readLastViewedApp } from "./WorkspaceAppList";
import { WorkspaceRow } from "./WorkspaceRow";

export function SidebarWorkspaceNav() {
  const wsCtx = useWorkspaceContext();
  const navigate = useNavigate();
  const ordered = useMemo(() => orderWorkspacesForSidebar(wsCtx.workspaces), [wsCtx.workspaces]);

  // Seed expansion: active workspace open by default. Re-keyed on the
  // workspace id list so a freshly added workspace doesn't force every
  // other row closed.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    if (wsCtx.activeWorkspace) initial.add(wsCtx.activeWorkspace.id);
    return initial;
  });

  // Auto-expand the active workspace as it changes (sidebar selection
  // or external route push). Only adds; never collapses other rows.
  useEffect(() => {
    if (!wsCtx.activeWorkspace) return;
    const id = wsCtx.activeWorkspace.id;
    setExpandedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, [wsCtx.activeWorkspace]);

  // Restore last-viewed selection on mount: if the persisted
  // workspace is in the current list and isn't already active, switch
  // to it. App-level route restore is handled by the existing
  // WorkspaceRedirect flow; this restores the workspace context so
  // the route resolves cleanly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot restore on mount; later changes don't re-trigger
  useEffect(() => {
    if (wsCtx.workspaces.length === 0) return;
    const last = readLastViewedApp();
    if (!last) return;
    if (wsCtx.activeWorkspace?.id === last.workspaceId) return;
    const target = wsCtx.workspaces.find((w) => w.id === last.workspaceId);
    if (!target) return;
    wsCtx.setActiveWorkspace(target);
    // Persistence note: WorkspaceContext also writes `nb_active_workspace`
    // on every switch, so the active id is preserved across reloads
    // independently. The last-viewed app key adds the in-workspace
    // app coordinate.
  }, []);

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectedAppRoute = useSelectedAppRoute();

  const handleAddWorkspace = useCallback(() => {
    // Reuse the existing org-workspaces page — the task spec is
    // explicit that the `+` affordance must NOT introduce new UX.
    navigate("/settings/org/workspaces");
  }, [navigate]);

  if (wsCtx.loading) {
    return (
      <div
        className="px-4 py-2 text-xs text-sidebar-foreground/50"
        data-testid="sidebar-workspace-nav-loading"
      >
        Loading workspaces…
      </div>
    );
  }

  return (
    <div
      className="flex flex-col"
      data-testid="sidebar-workspace-nav"
      data-workspace-count={ordered.length}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="text-[11px] font-bold tracking-[0.08em] text-sidebar-foreground/70 uppercase">
          Workspaces
        </div>
        <button
          type="button"
          onClick={handleAddWorkspace}
          aria-label="Add workspace"
          title="Add workspace"
          data-testid="sidebar-workspace-add"
          className="p-1 rounded-md text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-foreground/10 transition-colors"
        >
          <Plus style={{ width: 14, height: 14 }} />
        </button>
      </div>
      {ordered.length === 0 ? (
        <div
          className="px-4 py-2 text-xs text-sidebar-foreground/50 italic"
          data-testid="sidebar-workspace-nav-empty"
        >
          No workspaces
        </div>
      ) : (
        ordered.map((ws) => (
          <WorkspaceRow
            key={ws.id}
            workspace={ws}
            expanded={expandedIds.has(ws.id)}
            onToggle={() => toggle(ws.id)}
            selectedAppRoute={selectedAppRoute}
          />
        ))
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// URL → selected app route projection
//
// Apps render at `/w/<slug>/app/<route>`. The sidebar marks the matching
// app row as selected so the user can read "I am here" without
// remembering which workspace they're in.
// ─────────────────────────────────────────────────────────────────────────────

function useSelectedAppRoute(): string | null {
  const match = useMatch({ path: "/w/:slug/app/:route/*", end: false });
  return match?.params.route ?? null;
}

export { useSelectedAppRoute as __testOnly_useSelectedAppRoute };

// Re-export for tests so they can render an isolated tree.
export type { WorkspaceInfo };
