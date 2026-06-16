import type { BundleRef } from "./types.ts";

/**
 * Transport auth kinds that carry their own credential — the bundle presents or
 * mints a token on demand. Allowlist (not `!== "none"`) so a future interactive
 * auth type defaults to the OAuth path instead of silently boot-starting.
 */
const STATIC_AUTH_TYPES: readonly string[] = ["bearer", "header", "provider"];

/**
 * A url bundle has STATIC transport auth (`bearer` / `header` / `provider`)
 * when it carries its own credential: it presents or mints a token on demand and
 * needs no persisted OAuth tokens and no interactive "Connect". `none` (or no
 * auth) means the bundle authenticates through the workspace OAuth provider.
 *
 * Gate boot-start and connection-state decisions on this so a static-auth source
 * is not mistaken for an un-authenticated OAuth bundle. Without it, a provider-
 * auth fleet source (artifacts / nimbletasks / web-search) is skipped at boot for
 * "no tokens" — tools never surface — and seeded `not_authenticated`, which the
 * UI renders as a "Connect" button that would spin a bogus OAuth flow against a
 * server that has no OAuth.
 *
 * Mirrors the `hasStaticAuth` short-circuit in `startBundleSource`
 * (`startup.ts`): the two boot gates (`workspace-runtime.ts` boot-start,
 * `lifecycle.ts` `seedInstance`) consume the same predicate so all three agree.
 *
 * CAUTION: Composio-backed bundles also carry `header` auth (the platform's
 * `x-api-key`), so this returns true for them too — correct for `startup.ts`
 * (Composio never uses the OAuth provider). But Composio STILL needs a per-user
 * connect, so the two boot gates MUST check the Composio marker FIRST and only
 * fall back to this predicate for non-Composio url bundles. Otherwise an
 * unconnected Composio connector seeds `running` and loses its Connect button.
 */
export function bundleHasStaticAuth(ref: BundleRef): boolean {
  return (
    "url" in ref && !!ref.transport?.auth && STATIC_AUTH_TYPES.includes(ref.transport.auth.type)
  );
}
