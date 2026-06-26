import { SkillsBrowser } from "./SkillsTab";

/**
 * Org-admin skills tab — `/org/skills`.
 *
 * Renders the shared `SkillsBrowser` locked to org-tier. The route guard
 * (`RouteGuard requireRole="org_admin"` in App.tsx) is the access gate; this tab
 * assumes it has been passed before mount. Backend `checkPathAccess` is
 * the source of truth — UI gating is defense in depth, not the security
 * boundary.
 */
export function OrgSkillsTab() {
  return <SkillsBrowser lockedScope="org" />;
}
