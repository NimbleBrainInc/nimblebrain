import { Navigate, useLocation, useParams } from "react-router-dom";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";
import { useDefaultWorkspace } from "../lib/default-workspace";
import { usePinnedWorkspaces } from "../lib/pinned-workspaces";
import { orderWorkspacesForSidebar } from "../lib/workspace-order";
import { toSlug } from "../lib/workspace-slug";

/**
 * The addresses where connectors and skills were managed before Plugins, kept
 * so bookmarks, old links and sign-in callbacks that return to them still land:
 * a workspace's `settings/connectors`, `settings/connectors/browse` and
 * `settings/skills`, and the profile's `connectors` and `skills`. Each goes to
 * a Plugins page and keeps its query, so a callback's `?connected=` arrives
 * with it. `settings/connectors/:serverName` is `ConnectorPageRedirect`, which
 * finds the plugin that holds the connector.
 */

/** A Plugins page with the old address's query, on the given tab. */
export function pluginsTarget(slug: string, search: string, tab?: "browse"): string {
  const params = new URLSearchParams(search);
  if (tab) params.set("tab", tab);
  const query = params.toString();
  return `/w/${slug}/plugins${query ? `?${query}` : ""}`;
}

/** An old workspace settings address, to this workspace's Plugins. */
export function WorkspacePluginsRedirect({ tab }: { tab?: "browse" }) {
  const { slug = "" } = useParams<{ slug: string }>();
  const { search } = useLocation();
  return <Navigate to={pluginsTarget(slug, search, tab)} replace />;
}

/**
 * The workspace whose Plugins an old profile address opens, since the profile
 * names none: the one in focus, else the viewer's default workspace, else the
 * first in sidebar order. None when the viewer has no workspace.
 */
export function profileRedirectWorkspace(
  workspaces: readonly WorkspaceInfo[],
  activeId: string | null,
  defaultId: string | null,
  pinned: ReadonlySet<string>,
): WorkspaceInfo | undefined {
  return (
    workspaces.find((w) => w.id === activeId) ??
    workspaces.find((w) => w.id === defaultId) ??
    orderWorkspacesForSidebar(workspaces, pinned)[0]
  );
}

/** An old profile address, to a workspace's Plugins, or home without one. */
export function ProfilePluginsRedirect() {
  const { workspaces, activeWorkspace } = useWorkspaceContext();
  const { defaultId } = useDefaultWorkspace();
  const { pinned } = usePinnedWorkspaces();
  const { search } = useLocation();
  const target = profileRedirectWorkspace(
    workspaces,
    activeWorkspace?.id ?? null,
    defaultId,
    pinned,
  );
  return <Navigate to={target ? pluginsTarget(toSlug(target.id), search) : "/"} replace />;
}
