import type { UserIdentity } from "../../src/identity/provider.ts";

/**
 * A complete `UserIdentity` for a test, from the fields the test cares about.
 *
 * The defaults are what code already sees for an absent field: `orgRole` is
 * `"member"` (the user store's own default on load), `preferences` is empty, and
 * a missing `email` or `displayName` is `""`, falsy like the `undefined` it
 * replaces. Set `orgRole` explicitly in any test about org-level authority.
 */
export function makeIdentity(fields: Partial<UserIdentity> & { id: string }): UserIdentity {
  return { email: "", displayName: "", orgRole: "member", preferences: {}, ...fields };
}
