import { Badge } from "./badge";

/**
 * One source of truth for role chips. Lifted from three duplicated copies
 * (`UsersTab`, `WorkspaceMembersTab`, `WorkspaceDetailPage`).
 *
 * Covers org roles and workspace roles alike: both are `admin` or `member`.
 */
const ROLE_STYLES: Record<string, string> = {
  admin: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  member: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant="outline" className={ROLE_STYLES[role] ?? ROLE_STYLES.member}>
      {role}
    </Badge>
  );
}
