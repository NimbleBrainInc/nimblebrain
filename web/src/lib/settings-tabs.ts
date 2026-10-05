// ---------------------------------------------------------------------------
// The tabs of each settings area: a workspace's settings, the organization's,
// and the viewer's profile.
//
// One list per area, read by both the area's side nav (`SettingsShell`) and the
// top bar's breadcrumb (`lib/page-title`), so a tab is named the same in both
// places by construction. The FIRST tab is the area's landing page: the area's
// root redirects there (`App.tsx`) and the breadcrumb links there, so reordering
// a list moves its default with it.
// ---------------------------------------------------------------------------

import type { ScopedRole } from "../hooks/useScopedRole";

export interface SettingsTab {
  /** The path segment after the area's root, e.g. `members`. */
  segment: string;
  label: string;
  /** Minimum role to see the tab in the nav. A hidden tab is not a permission. */
  minRole: ScopedRole;
}

export const WORKSPACE_SETTINGS_TABS: readonly SettingsTab[] = [
  { segment: "general", label: "General", minRole: "ws_member" },
  { segment: "members", label: "Members", minRole: "ws_member" },
  { segment: "connectors", label: "Connectors", minRole: "ws_member" },
  { segment: "skills", label: "Skills", minRole: "ws_member" },
  { segment: "mcp", label: "MCP", minRole: "ws_member" },
  // Admin-only in the NAV, and separately admin-only in the tool — a route
  // decides what a connector does unasked, under its author's identity.
  { segment: "notifications", label: "Notifications", minRole: "ws_admin" },
  // Admin-only in the NAV, and separately admin-only in the tool. The nav gate
  // decides whether the tab is worth showing; the tool decides whether a URL is
  // returned.
  { segment: "webhooks", label: "Webhooks", minRole: "ws_admin" },
];

// Ordered by what an org admin comes to do: who and where (workspaces, users),
// then what the assistant can do (skills, model), then oversight (usage), then
// cleanup after a workspace is deleted (archives).
export const ORG_SETTINGS_TABS: readonly SettingsTab[] = [
  { segment: "workspaces", label: "Workspaces", minRole: "org_admin" },
  { segment: "users", label: "Users", minRole: "org_admin" },
  { segment: "skills", label: "Skills", minRole: "org_admin" },
  // "Models", plural: the page sets two (default and fast) and the limits and
  // thinking they run under. The segment stays `model` so existing links work.
  { segment: "model", label: "Models", minRole: "org_admin" },
  { segment: "usage", label: "Usage", minRole: "org_admin" },
  { segment: "archives", label: "Archives", minRole: "org_admin" },
];

/** Pinned to the org nav's footer and role-exempt: any signed-in user may read it. */
export const ORG_ABOUT_TAB: SettingsTab = { segment: "about", label: "About", minRole: "none" };

export const PROFILE_TABS: readonly SettingsTab[] = [
  { segment: "general", label: "General", minRole: "none" },
  { segment: "connectors", label: "Connectors", minRole: "none" },
  { segment: "skills", label: "Skills", minRole: "none" },
];

/** An area's landing tab: the first in its list. */
export function landingTab(tabs: readonly SettingsTab[]): string {
  return tabs[0].segment;
}
