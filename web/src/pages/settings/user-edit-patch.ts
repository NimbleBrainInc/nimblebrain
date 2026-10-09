/**
 * The Organization → Users editor's fields and the `manage_users` update each
 * one sends, as pure data logic.
 *
 * Free of React and of the API client so a server-side test can feed the exact
 * object the editor sends to `manage_users` (see `model-config-patch.ts`).
 */

/** Mirrors `OrgRole` in src/identity/types.ts; web/ does not import src/. */
export type OrgRole = "admin" | "member";

export const ORG_ROLE_OPTIONS: ReadonlyArray<{ value: OrgRole; label: string }> = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
];

/** What each field holds while it is edited. */
export interface UserEditValues {
  displayName: string;
  email: string;
  orgRole: OrgRole;
}

export type UserEditField = keyof UserEditValues;

/**
 * The `manage_users` update for one field of one user. One field per save, so
 * a save never touches a field the admin did not change. None of these fields
 * can be cleared, so nothing here sends `null`; the server refuses an empty
 * name or email with its own message.
 */
export function userEditPatch<K extends UserEditField>(
  userId: string,
  field: K,
  value: UserEditValues[K],
): Record<string, unknown> {
  return { action: "update", userId, [field]: field === "orgRole" ? value : value.trim() };
}

/** Whether moving from `from` to `to` takes away the right to manage the org. */
export function removesAdminRights(from: OrgRole, to: OrgRole): boolean {
  return from === "admin" && to === "member";
}
