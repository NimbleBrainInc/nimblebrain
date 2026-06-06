import { type SettingsNavItem, SettingsShell } from "./settings/SettingsShell";

// ── Profile shell — `/profile/*` ─────────────────────────────────────
//
// Profile is identity-level: it follows the user across every workspace
// and isn't gated by workspace role. Items declare `minRole: "none"` so
// any authenticated identity sees them. Phase 3 of SKILLS_SURFACE.md
// adds the Skills tab; future identity-level config (custom
// instructions, model preferences) slots in alongside.

const PROFILE_ITEMS: SettingsNavItem[] = [
  { id: "profile-general", label: "Profile", to: "/profile/general", minRole: "none" },
  { id: "profile-skills", label: "Skills", to: "/profile/skills", minRole: "none" },
];

export function ProfilePage() {
  return <SettingsShell title="Profile" items={PROFILE_ITEMS} />;
}
