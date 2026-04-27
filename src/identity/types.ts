/** Org-level roles for multi-user identity. */
export type OrgRole = "owner" | "admin" | "member";

/**
 * Org-level roles that grant admin powers (manage all workspaces, all
 * users, instance config). Source of truth for server-side role gates.
 *
 * Used by `set_model_config`, `instructions__write_instructions`,
 * `manage_workspaces`, `manage_users`, and any future tool whose
 * authority spans the entire org. Web-side has its own constant in
 * `useScopedRole`.
 */
export const ORG_ADMIN_ROLES: ReadonlySet<OrgRole> = new Set(["admin", "owner"]);
