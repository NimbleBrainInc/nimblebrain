import type { UserIdentity } from "./provider.ts";
import { DEV_IDENTITY } from "./providers/dev.ts";

/**
 * Resolve the owning user id for a request, applying one strict rule used
 * everywhere identity-scoped data is reached (conversations, files,
 * automations):
 *
 *   - An identity provider is configured (production / `instance.json`):
 *     the request MUST carry an identity. Absence is a misconfigured
 *     deployment (auth middleware didn't populate it) — throw, never
 *     silently own the data as a sentinel user.
 *   - No identity provider (dev / tests / CLI): fall back to `DEV_IDENTITY`
 *     (`usr_default`). The fallback is gated on the provider being absent so
 *     the same path can't degrade production into "owned by usr_default."
 *
 * This is the single source of truth for that resolution. `runtime.chat()`,
 * the host-resources `files://` resolver, and the REST file handlers all call
 * it so an upload and its later read resolve to the SAME owner — and thus the
 * same identity-scoped store. Drift here would strand files in one store while
 * reads look in another.
 */
export function resolveRequestOwnerId(
  identity: UserIdentity | null | undefined,
  identityProviderConfigured: boolean,
): string {
  if (!identity && identityProviderConfigured) {
    throw new Error(
      "[identity] no identity on request but an identity provider is configured — " +
        "auth middleware must populate it before any identity-scoped data access.",
    );
  }
  return (identity ?? DEV_IDENTITY).id;
}
