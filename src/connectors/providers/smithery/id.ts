/**
 * Smithery's registered provider id.
 *
 * Its own module for the same reason Composio's is: the id is the one string
 * shared by the registry key, the catalog `auth` value, the `provider` on a
 * brokered ref, and the credential-provider name — and the modules that need it
 * would otherwise import each other to get it.
 */
export const SMITHERY_PROVIDER_ID = "smithery";
