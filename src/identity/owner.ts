import type { UserIdentity } from "./provider.ts";

/**
 * Resolve the owning user id for a request, applying one strict rule used
 * everywhere identity-scoped data is reached (conversations, files,
 * tasks): the request MUST carry an identity, under every identity
 * provider (`dev` included). Absence means a caller skipped authentication —
 * throw, never silently own the data as a sentinel user.
 *
 * This is the single source of truth for that resolution. `runtime.chat()`,
 * the host-resources `files://` resolver, and the REST file handlers all call
 * it so an upload and its later read resolve to the SAME owner — and thus the
 * same identity-scoped store. Drift here would strand files in one store while
 * reads look in another.
 */
export function resolveRequestOwnerId(identity: UserIdentity | null | undefined): string {
  return requireRequestIdentity(identity).id;
}

/** The request's identity, or a throw when it carries none (see `resolveRequestOwnerId`). */
export function requireRequestIdentity(identity: UserIdentity | null | undefined): UserIdentity {
  if (!identity) {
    throw new Error(
      "[identity] no identity on request — auth middleware (or an in-process " +
        "caller) must supply it before any identity-scoped data access.",
    );
  }
  return identity;
}
