import type { BundleRef } from "./types.ts";

/**
 * A url bundle has STATIC transport auth (`bearer` / `header` / `tenant-key`)
 * when it carries its own credential: it presents or mints a token on demand and
 * needs no persisted OAuth tokens and no interactive "Connect". `none` (or no
 * auth) means the bundle authenticates through the workspace OAuth provider.
 *
 * Gate boot-start and connection-state decisions on this so a static-auth source
 * is not mistaken for an un-authenticated OAuth bundle. Without it, a tenant-key
 * fleet source (artifacts / nimbletasks / web-search) is skipped at boot for
 * "no tokens" — tools never surface — and seeded `not_authenticated`, which the
 * UI renders as a "Connect" button that would spin a bogus OAuth flow against a
 * server that has no OAuth.
 *
 * Mirrors the `hasStaticAuth` short-circuit in `startBundleSource`
 * (`startup.ts`): the two boot gates (`workspace-runtime.ts` boot-start,
 * `lifecycle.ts` `seedInstance`) consume the same predicate so all three agree.
 */
export function bundleHasStaticAuth(ref: BundleRef): boolean {
  return "url" in ref && !!ref.transport?.auth && ref.transport.auth.type !== "none";
}
