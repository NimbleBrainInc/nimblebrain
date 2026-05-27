import { useEffect } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { toWsId } from "../lib/workspace-slug";

const loadingWorkspace = (
  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
    Loading workspace...
  </div>
);

/**
 * Route guard for `/w/:slug/*`.
 *
 * The URL slug is the single source of truth for the active workspace.
 * The wire workspace (`X-Workspace-Id`, sent from the ambient
 * `activeWorkspaceId`) is a *projection* of that slug — never an
 * independent value. This guard enforces the projection with one
 * invariant: **a workspace-scoped subtree does not mount until the
 * ambient workspace equals the route.**
 *
 * Why the invariant and not just the sync effect below: React effects
 * run child → parent, so a descendant's data fetch (e.g. the connectors
 * list) would read the *previous* ambient workspace — the bootstrap
 * personal default, or the last route's workspace — before this guard's
 * effect could correct it. That surfaced one workspace's connectors
 * under another workspace's URL (and let `install` / `connect` target
 * the wrong workspace). Gating the `Outlet` makes that state
 * unrepresentable: descendants only exist once ambient === URL, so they
 * fetch and act against the right workspace by construction.
 */
export function WorkspaceRouteGuard() {
  const { slug } = useParams<{ slug: string }>();
  const { workspaces, activeWorkspace, setActiveWorkspace, loading } = useWorkspaceContext();

  const routeWsId = slug ? toWsId(slug) : null;

  // Reconcile the ambient workspace to the URL. This stays an effect
  // (React state can't be set during another component's render), but
  // the gate below means no descendant observes the pre-reconciliation
  // value — the effect only has to win against itself, not against child
  // effects.
  useEffect(() => {
    if (loading || !routeWsId || workspaces.length === 0) return;
    if (activeWorkspace?.id === routeWsId) return;
    const target = workspaces.find((ws) => ws.id === routeWsId);
    if (target) setActiveWorkspace(target);
  }, [routeWsId, workspaces, activeWorkspace?.id, setActiveWorkspace, loading]);

  if (loading) return loadingWorkspace;

  // Unknown / non-member slug → bounce to the default landing (only
  // decidable once the workspace list has loaded).
  if (routeWsId && workspaces.length > 0 && !workspaces.some((ws) => ws.id === routeWsId)) {
    return <Navigate to="/" replace />;
  }

  // The invariant (see the doc comment). Reaching here with a known
  // `routeWsId` means the effect above will reconcile to it; hold the
  // subtree until it has. The `workspaces.length > 0` guard lets the
  // no-memberships case fall through to the child's own empty-state
  // instead of spinning here forever.
  if (routeWsId && workspaces.length > 0 && activeWorkspace?.id !== routeWsId) {
    return loadingWorkspace;
  }

  return <Outlet />;
}
