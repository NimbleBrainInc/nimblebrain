/**
 * Composio's registered provider id.
 *
 * Its own module because the id is the one string this provider shares with
 * every layer that addresses it — the registry key, the catalog `auth` value,
 * the `provider` on a brokered ref, and its credential directory segment — and
 * the modules that need it (`provider.ts`, `connection.ts`,
 * `transport-credential.ts`) would otherwise import each other to get it.
 */
export const COMPOSIO_PROVIDER_ID = "composio";
