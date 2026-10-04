import { ORG_ABOUT_TAB, ORG_SETTINGS_TABS } from "../../lib/settings-tabs";
import { type SettingsNavItem, SettingsShell } from "./SettingsShell";

// ── Organization settings shell — `/org/*` ───────────────────────────
//
// Org-scoped settings own a dedicated top-level home, separate from
// workspace settings (which live under `/w/:slug/settings`). Everything
// here affects the org as a whole — the global model config, the full
// workspace/user roster — so it's gated to org admins. About
// is the one role-exempt entry (platform version / info), pinned to the
// footer so any signed-in user can reach it.

const ORG_ITEMS: SettingsNavItem[] = ORG_SETTINGS_TABS.map((tab) => ({
  id: `org-${tab.segment}`,
  label: tab.label,
  to: `/org/${tab.segment}`,
  minRole: tab.minRole,
}));

export function OrgSettingsPage() {
  return (
    <SettingsShell
      title="Organization"
      items={ORG_ITEMS}
      footer={{ id: "about", label: ORG_ABOUT_TAB.label, to: `/org/${ORG_ABOUT_TAB.segment}` }}
    />
  );
}
