import { SkillsBrowser } from "./SkillsTab";

/**
 * Personal-skills tab — `/profile/skills`.
 *
 * Renders the shared `SkillsBrowser` locked to user-tier. Personal skills
 * follow the identity across every workspace; the load path reads from
 * `users/<userId>/skills/` at runtime regardless of focused workspace
 * (see `runtime.loadConversationSkills`) so the "follow me" invariant is
 * delivered by the runtime, not the UI placement.
 */
export function ProfileSkillsTab() {
  return <SkillsBrowser lockedScope="user" />;
}
