import { useEffect, useEffectEvent, useRef } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { getActiveWorkspaceId, setActiveWorkspaceId } from "../api/client";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { rememberWorkspace } from "../lib/last-workspace";
import { toWsId } from "../lib/workspace-slug";
import { useNotice } from "./notices";

/**
 * Route guard for `/w/:slug/*`.
 *
 * The URL slug is the single source of truth for the focused workspace. The
 * wire workspace (the `/v1/workspaces/<wsId>/…` path REST helpers build from
 * the ambient `activeWorkspaceId`) is a *projection* of that slug — never an
 * independent value.
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
 * `activeWorkspace` reconciles a render later for display-oriented consumers).
 * `useCanWriteActiveWorkspace` reads that lagging state too, so the frame is
 * not purely cosmetic — though the server still refuses either way.
 */
export function WorkspaceRouteGuard() {
  const { slug } = useParams<{ slug: string }>();
  const { workspaces, activeWorkspace, setActiveWorkspace } = useWorkspaceContext();

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
    if (!routeWsId || workspaces.length === 0) return;
    if (activeWorkspace?.id === routeWsId) return;
    const target = workspaces.find((ws) => ws.id === routeWsId);
    if (target) setActiveWorkspace(target);
  }, [routeWsId, workspaces, activeWorkspace?.id, setActiveWorkspace]);

  // The workspace this browser is in, so `/` reopens it (ADR-0073). Only a
  // workspace the viewer belongs to is recorded.
  useEffect(() => {
    if (isMember && routeWsId) rememberWorkspace(routeWsId);
  }, [isMember, routeWsId]);

  // Unknown / non-member slug → bounce to `/`, which opens a workspace the
  // viewer can reach, and say why the address did not open.
  const bounce = routeWsId !== null && workspaces.length > 0 && !isMember;
  // Said once per address: an effect can run twice for one bounce (React's
  // strict mode does so in development).
  const notify = useNotice();
  const saidFor = useRef<string | null>(null);
  const sayNoAccess = useEffectEvent((wsId: string) => {
    if (saidFor.current === wsId) return;
    saidFor.current = wsId;
    notify({ level: "warning", title: "You don't have access to that workspace" });
  });
  useEffect(() => {
    if (bounce && routeWsId) sayNoAccess(routeWsId);
  }, [bounce, routeWsId]);
  if (bounce) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
