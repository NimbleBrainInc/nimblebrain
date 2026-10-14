import { PROFILE_TABS } from "../lib/settings-tabs";
import { type SettingsNavItem, SettingsShell } from "./settings/SettingsShell";

// ── Profile shell — `/profile/*` ─────────────────────────────────────
//
// Profile is identity-level: it follows the user across every workspace
// and isn't gated by workspace role. Items declare `minRole: "none"` so
// any authenticated identity sees them. Future identity-level config
// (custom instructions, model preferences) slots in alongside Skills.

const PROFILE_ITEMS: SettingsNavItem[] = PROFILE_TABS.map((tab) => ({
  id: `profile-${tab.segment}`,
  label: tab.label,
  to: `/profile/${tab.segment}`,
  minRole: tab.minRole,
}));

export function ProfilePage() {
  return <SettingsShell title="Profile" items={PROFILE_ITEMS} />;
}
