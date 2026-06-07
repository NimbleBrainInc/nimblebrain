import { type SettingsNavItem, SettingsShell } from "./settings/SettingsShell";

// ── Profile shell — `/profile/*` ─────────────────────────────────────
//
// Profile is identity-level: it follows the user across every workspace
// and isn't gated by workspace role. Items declare `minRole: "none"` so
// any authenticated identity sees them. Future identity-level config
// (custom instructions, model preferences) slots in alongside Skills.

const PROFILE_ITEMS: SettingsNavItem[] = [
  { id: "profile-general", label: "General", to: "/profile/general", minRole: "none" },
  { id: "profile-skills", label: "Skills", to: "/profile/skills", minRole: "none" },
];

export function ProfilePage() {
  return <SettingsShell title="Profile" items={PROFILE_ITEMS} />;
}
