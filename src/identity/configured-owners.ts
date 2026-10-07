/**
 * The owners `instance.json` names (`auth.owners`), as a lookup by email.
 *
 * Matched case-insensitively against the email the provider verified at sign-in,
 * which `manage_users` cannot change under any adapter that reads this list
 * (`providerOwnedUserFields`), so an admin can never edit their way onto it.
 */
export interface ConfiguredOwners {
  has(email: string): boolean;
}

export function configuredOwners(emails: readonly string[] | undefined): ConfiguredOwners {
  const set = new Set((emails ?? []).map((e) => e.trim().toLowerCase()));
  return { has: (email) => set.has(email.trim().toLowerCase()) };
}
