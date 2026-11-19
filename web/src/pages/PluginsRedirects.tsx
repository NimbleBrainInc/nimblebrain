import { Navigate, useLocation, useParams } from "react-router-dom";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";
import { useDefaultWorkspace } from "../lib/default-workspace";
import { usePinnedWorkspaces } from "../lib/pinned-workspaces";
import { browsePluginsPath, newSkillPath, pluginsPath, skillsPath } from "../lib/plugins";
import { orderWorkspacesForSidebar } from "../lib/workspace-order";
import { toSlug } from "../lib/workspace-slug";

/**
 * Old addresses, kept so bookmarks, old links and sign-in callbacks that
 * return to them still land: a workspace's `settings/connectors`,
 * `settings/connectors/browse` and `settings/skills`, the profile's
 * `connectors` and `skills`, and skill pages under `plugins/skills/`. Each
 * keeps its query, so a callback's `?connected=` arrives with it.
 * `settings/connectors/:serverName` is `ConnectorPageRedirect`, which finds the
 * plugin that holds the connector. `plugins?tab=browse` is answered by
 * `PluginsPage` itself.
 */

/** Which page an old address opens. */
export type RedirectPage = "plugins" | "browse" | "skills";

function pagePath(slug: string, page: RedirectPage): string {
  return page === "browse"
    ? browsePluginsPath(slug)
    : page === "skills"
      ? skillsPath(slug)
      : pluginsPath(slug);
}

/** A page with the old address's query. */
export function pluginsTarget(
  slug: string,
  search: string,
  page: RedirectPage = "plugins",
): string {
  const params = new URLSearchParams(search);
  params.delete("tab");
  const query = params.toString();
  return `${pagePath(slug, page)}${query ? `?${query}` : ""}`;
}

/** An old workspace settings address, to this workspace's Plugins or Browse plugins. */
export function WorkspacePluginsRedirect({ tab }: { tab?: "browse" }) {
  const { slug = "" } = useParams<{ slug: string }>();
  const { search } = useLocation();
  return <Navigate to={pluginsTarget(slug, search, tab ?? "plugins")} replace />;
}

/** The old workspace skills settings address, to this workspace's Skills. */
export function WorkspaceSkillsRedirect() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { search } = useLocation();
  return <Navigate to={pluginsTarget(slug, search, "skills")} replace />;
}

/**
 * A skill's old address under Plugins, `plugins/skills/<rest>`, to the same
 * place under Skills: `new`, a `<scope>/<name>` page, or Skills itself.
 */
export function OldSkillAddressRedirect() {
  const { slug = "", "*": rest = "" } = useParams<{ slug: string; "*": string }>();
  const { search } = useLocation();
  const target =
    rest === "new" ? newSkillPath(slug) : rest ? `${skillsPath(slug)}/${rest}` : skillsPath(slug);
  return <Navigate to={`${target}${search}`} replace />;
}

/**
 * The workspace an old profile address opens, since the profile names none:
 * the one in focus, else the viewer's default workspace, else the first in
 * sidebar order. None when the viewer has no workspace.
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

/** An old profile address, to a workspace's Plugins (or Skills), or home without one. */
export function ProfilePluginsRedirect({ page = "plugins" }: { page?: "plugins" | "skills" }) {
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
  return <Navigate to={target ? pluginsTarget(toSlug(target.id), search, page) : "/"} replace />;
}
