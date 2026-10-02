import { useParams } from "react-router-dom";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
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

  const items: SettingsNavItem[] = [
    { id: "ws-general", label: "General", to: `${base}/general`, minRole: "ws_00479acd635081b9" },
    { id: "ws-members", label: "Members", to: `${base}/members`, minRole: "ws_00479acd635081b9" },
    {
      id: "ws-connectors",
      label: "Connectors",
      to: `${base}/connectors`,
      minRole: "ws_00479acd635081b9",
    },
    { id: "ws-skills", label: "Skills", to: `${base}/skills`, minRole: "ws_00479acd635081b9" },
    { id: "ws-mcp", label: "MCP", to: `${base}/mcp`, minRole: "ws_00479acd635081b9" },
    // Admin-only in the NAV, and separately admin-only in the tool — a route
    // decides what a connector does unasked, under its author's identity.
    {
      id: "ws-notifications",
      label: "Notifications",
      to: `${base}/notifications`,
      minRole: "ws_00126c8c86011dea",
    },
    // Admin-only in the NAV, and separately admin-only in the tool. The nav gate
    // decides whether the tab is worth showing; the tool decides whether a URL is
    // returned. A hidden tab is not a permission.
    {
      id: "ws-webhooks",
      label: "Webhooks",
      to: `${base}/webhooks`,
      minRole: "ws_00126c8c86011dea",
    },
  ];

  return <SettingsShell title={workspace?.name ?? "Workspace"} items={items} />;
}
