import { useParams } from "react-router-dom";
import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { toSlug } from "../../lib/workspace-slug";
import type { PlacementEntry } from "../../types";
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
  const shell = useShellContext();

  const workspace = slug ? wsCtx.workspaces.find((w) => toSlug(w.id) === slug) : undefined;
  const base = `/w/${slug}/settings`;

  // Per-bundle settings panels (bundles' own settings UIs in the `settings`
  // placement slot). The placement registry is already scoped to the focused
  // workspace server-side, so this lists the right workspace's apps.
  const appPanels: PlacementEntry[] = shell ? shell.forSlot("settings") : [];

  const items: SettingsNavItem[] = [
    { id: "ws-general", label: "General", to: `${base}/general`, minRole: "ws_member" },
    { id: "ws-members", label: "Members", to: `${base}/members`, minRole: "ws_member" },
    { id: "ws-usage", label: "Usage", to: `${base}/usage`, minRole: "ws_member" },
    {
      id: "ws-apps",
      label: "Apps",
      to: `${base}/apps`,
      end: true,
      minRole: "ws_member",
      children: appPanels.map((panel) => ({
        id: panel.serverName,
        label: panel.label ?? panel.serverName,
        to: `${base}/apps/${panel.serverName}`,
        icon: panel.icon,
      })),
    },
    { id: "ws-connectors", label: "Connectors", to: `${base}/connectors`, minRole: "ws_member" },
    { id: "ws-skills", label: "Skills", to: `${base}/skills`, minRole: "ws_member" },
  ];

  return <SettingsShell title={workspace?.name ?? "Workspace"} items={items} />;
}
