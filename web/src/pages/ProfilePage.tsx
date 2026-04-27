import { ProfileTab } from "./settings/ProfileTab";

/**
 * Top-level Profile page — identity is not a setting, so it lives outside
 * the `/settings/*` tree and renders without the settings sub-nav.
 *
 * The page chrome matches the padding the settings outlet uses
 * (`p-4 md:p-6`) so visiting Profile feels visually congruent with
 * visiting any settings tab — just without the inner nav competing for
 * attention.
 */
export function ProfilePage() {
  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <ProfileTab />
    </div>
  );
}
