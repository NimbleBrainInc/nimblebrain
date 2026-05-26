import { type SettingsNavItem, SettingsShell } from "./SettingsShell";

// ── Organization settings shell — `/org/*` ───────────────────────────
//
// Org-scoped settings own a dedicated top-level home, separate from
// workspace settings (which live under `/w/:slug/settings`). Everything
// here affects the org as a whole — the global model config, the full
// workspace/user roster, registries — so it's gated to org admins. About
// is the one role-exempt entry (platform version / info), pinned to the
// footer so any signed-in user can reach it.

const ORG_ITEMS: SettingsNavItem[] = [
  { id: "org-model", label: "Model", to: "/org/model", minRole: "org_admin" },
  { id: "org-workspaces", label: "Workspaces", to: "/org/workspaces", minRole: "org_admin" },
  { id: "org-users", label: "Users", to: "/org/users", minRole: "org_admin" },
  { id: "org-usage", label: "Usage", to: "/org/usage", minRole: "org_admin" },
  { id: "org-registries", label: "Registries", to: "/org/registries", minRole: "org_admin" },
];

export function OrgSettingsPage() {
  return (
    <SettingsShell
      title="Organization"
      items={ORG_ITEMS}
      footer={{ id: "about", label: "About", to: "/org/about" }}
    />
  );
}
