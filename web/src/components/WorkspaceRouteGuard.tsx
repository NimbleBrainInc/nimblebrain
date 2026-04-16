import { useEffect } from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { toWsId } from "../lib/workspace-slug";

/**
 * Route guard for /w/:slug/* routes.
 * Reads the workspace slug from URL, syncs it to WorkspaceContext,
 * and renders child routes via Outlet.
 */
export function WorkspaceRouteGuard() {
  const { slug } = useParams<{ slug: string }>();
  const { workspaces, activeWorkspace, setActiveWorkspace, loading } = useWorkspaceContext();

  // Sync URL slug → workspace context
  useEffect(() => {
    if (loading || !slug || workspaces.length === 0) return;

    const wsId = toWsId(slug);
    // Only update if the URL workspace differs from the active one
    if (activeWorkspace?.id !== wsId) {
      const target = workspaces.find((ws) => ws.id === wsId);
      if (target) {
        setActiveWorkspace(target);
      }
    }
  }, [slug, workspaces, activeWorkspace?.id, setActiveWorkspace, loading]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading workspace...
      </div>
    );
  }

  // If the slug doesn't match any workspace, redirect to default
  if (slug && workspaces.length > 0) {
    const wsId = toWsId(slug);
    const exists = workspaces.some((ws) => ws.id === wsId);
    if (!exists) {
      return <Navigate to="/" replace />;
    }
  }

  return <Outlet />;
}
