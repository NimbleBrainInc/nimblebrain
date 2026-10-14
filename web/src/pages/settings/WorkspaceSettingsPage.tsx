import { useParams } from "react-router-dom";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { WORKSPACE_SETTINGS_TABS } from "../../lib/settings-tabs";
import { toSlug } from "../../lib/workspace-slug";
import { type SettingsNavItem, SettingsShell } from "./SettingsShell";

// ── Workspace settings shell — `/w/:slug/settings/*` ─────────────────
//
// Workspace-scoped settings live UNDER the workspace URL, so the focused
// workspace is the slug in the path — not a remembered selection. This
// page renders inside `WorkspaceRouteGuard`, which validates membership
// (non-member / unknown slug → home) and syncs the slug into context, so
// the tab components below resolve their workspace the same way they
// always have. The single source of truth for "which workspace" is the URL.

export function WorkspaceSettingsPage() {
  const { slug } = useParams<{ slug: string }>();
  const wsCtx = useWorkspaceContext();

  const workspace = slug ? wsCtx.workspaces.find((w) => toSlug(w.id) === slug) : undefined;
  const base = `/w/${slug}/settings`;

  const items: SettingsNavItem[] = WORKSPACE_SETTINGS_TABS.map((tab) => ({
    id: `ws-${tab.segment}`,
    label: tab.label,
    to: `${base}/${tab.segment}`,
    minRole: tab.minRole,
  }));

  return <SettingsShell title={workspace?.name ?? "Workspace"} items={items} />;
}
