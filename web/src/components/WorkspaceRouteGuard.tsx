import { useEffect } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { getActiveWorkspaceId, setActiveWorkspaceId } from "../api/client";
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
 * The URL slug is the single source of truth for the focused workspace. The
 * wire workspace (`X-Workspace-Id`, sent from the ambient `activeWorkspaceId`)
 * is a *projection* of that slug — never an independent value.
 *
 * The projection is set **synchronously during render**, before the `Outlet`'s
 * descendants render. That ordering is the whole point: a descendant's data
 * fetch (e.g. the connectors list) reads the ambient workspace, and React
 * effects run child → parent, so an effect here would set it only *after* the
 * descendants had already fetched the previous workspace — surfacing one
 * workspace's connectors under another's URL, and letting `install` / `connect`
 * target the wrong workspace. Setting it inline makes the right workspace true
 * by the time anything below reads it, with no loading-screen gate — so a
 * switch never flashes "Loading workspace…" (the route and the ambient id
 * always agree on the frame the Outlet renders, even though the React-state
 * `activeWorkspace` reconciles a render later for display-only consumers).
 */
export function WorkspaceRouteGuard() {
  const { slug } = useParams<{ slug: string }>();
  const { workspaces, activeWorkspace, setActiveWorkspace, loading } = useWorkspaceContext();

  const routeWsId = slug ? toWsId(slug) : null;
  const isMember = !!routeWsId && workspaces.some((ws) => ws.id === routeWsId);

  // Project the route onto the ambient workspace id NOW (a plain module var, not
  // React state — safe and idempotent to set during render), so the Outlet's
  // descendants below fetch against this workspace on their first frame.
  if (isMember && routeWsId && getActiveWorkspaceId() !== routeWsId) {
    setActiveWorkspaceId(routeWsId);
  }

  // Keep the React-state `activeWorkspace` in lockstep for display-only
  // consumers (sidebar highlight, composer footer). State can't be set during
  // another component's render, so this stays an effect — but the inline
  // projection above already made descendants correct, so this effect only
  // has to win against itself, never against child effects.
  useEffect(() => {
    if (loading || !routeWsId || workspaces.length === 0) return;
    if (activeWorkspace?.id === routeWsId) return;
    const target = workspaces.find((ws) => ws.id === routeWsId);
    if (target) setActiveWorkspace(target);
  }, [routeWsId, workspaces, activeWorkspace?.id, setActiveWorkspace, loading]);

  // No workspaces yet (initial list still loading) — the only true loading gate.
  if (loading) return loadingWorkspace;

  // Unknown / non-member slug → bounce to the default landing (only decidable
  // once the workspace list has loaded).
  if (routeWsId && workspaces.length > 0 && !isMember) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
