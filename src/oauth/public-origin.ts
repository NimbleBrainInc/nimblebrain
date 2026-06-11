/**
 * The single source of truth for this tenant's **public origin** — the
 * scheme+host that every outward-facing URL the platform hands to a user's
 * browser or a vendor's OAuth server is built from:
 *
 *   - WorkOS login redirect   (`${publicOrigin()}/v1/auth/callback`)
 *   - Composio connector callback (`${publicOrigin()}/v1/composio-auth/callback`)
 *   - Non-bouncer MCP static-auth callback (`${publicOrigin()}/v1/mcp-auth/callback`)
 *   - Post-callback connectors return URL (`connectors-redirect.ts`)
 *   - `appOrigin` (post-login landing)
 *
 * Why this module exists: "what is this tenant's public origin?" used to be
 * smeared across `NB_API_URL`, `NB_WEB_URL`, `WORKOS_REDIRECT_URI`, and
 * `ALLOWED_ORIGINS[0]` — four values in two layers that had to agree by hand.
 * For a custom-domain tenant they didn't: callbacks defaulted to the platform
 * subdomain while the user was signed in on the branded domain, so the OAuth
 * return leg landed cross-origin (no session cookie) and 401'd. Collapsing the
 * derivation to one policy here makes those URLs consistent by construction.
 *
 * **Policy.** The canonical origin is, in order:
 *   1. `NB_PUBLIC_ORIGIN` — explicit operator override. The rare escape hatch
 *      for an origin that is neither the platform host nor the custom domain
 *      (e.g. a white-labeled `auth.customer.com`). Trusted as given.
 *   2. Derived: `https://{NB_CUSTOM_DOMAIN}` when a custom domain is set AND
 *      canonical (`NB_CUSTOM_DOMAIN_CANONICAL` !== "false"), else
 *      `https://{NB_PLATFORM_HOST}`. This is the normal path — the chart
 *      forwards these as facts; the policy ("custom domain wins") lives here,
 *      not in Helm templating.
 *   3. `NB_API_URL` — legacy migration fallback. Older deployments set only
 *      this. Centralizing the read here (and nowhere else — see
 *      `scripts/check-public-origin.ts`) lets us delete it cleanly once every
 *      tenant ships the facts.
 *   4. `http://localhost:27247` — dev default (no auth gate, `dev:worktree`).
 *
 * **Why config-derived, never request-derived.** The origin must NOT come from
 * the inbound `Host` / `X-Forwarded-Host` header. A header-derived `redirect_uri`
 * is an open-redirect / account-takeover surface: an attacker sets the header,
 * the OAuth `code` lands on their origin. Operator config is the only trusted
 * source, so this module reads env exclusively.
 *
 * **Fails closed.** The result is asserted to be a bare `https` origin (or a
 * `localhost` `http` origin in dev) with no path/query/fragment. A malformed
 * value throws at first call — same eager-validation posture as
 * `validateComposioConfig` / `getBouncerMode` — so a misconfigured deploy
 * crashes at startup instead of minting broken callback URLs at first click.
 *
 * Recomputed per call (deliberately uncached) so it always reflects current
 * config and can't leak a stale value between calls or tests.
 */

const PUBLIC_ORIGIN_ENV = "NB_PUBLIC_ORIGIN";
const PLATFORM_HOST_ENV = "NB_PLATFORM_HOST";
const CUSTOM_DOMAIN_ENV = "NB_CUSTOM_DOMAIN";
const CUSTOM_DOMAIN_CANONICAL_ENV = "NB_CUSTOM_DOMAIN_CANONICAL";
/**
 * Legacy origin var. This module is the ONLY sanctioned reader —
 * `check:public-origin` rejects `process.env.NB_API_URL` / `NB_WEB_URL`
 * anywhere else so the derivation can't re-fragment.
 */
const LEGACY_API_URL_ENV = "NB_API_URL";

/**
 * User-facing SPA origin for post-callback returns. In production the API and
 * the SPA share one origin (Caddy proxies `/v1/*` to the API), so this equals
 * `publicOrigin()`. In dev they split — API on :27247, SPA on :27246 — and
 * `src/cli/dev.ts` sets `NB_WEB_URL` so a connector return lands on the SPA,
 * not a JSON error page on the API port. Sanctioned reader, same as above.
 */
const WEB_URL_ENV = "NB_WEB_URL";

/** Dev default — matches the API port; used only when no host facts are set. */
const DEV_ORIGIN = "http://localhost:27247";

/**
 * Resolve and validate the canonical public origin (scheme + host, no trailing
 * slash, no path). Throws on a malformed configured value.
 *
 * Recomputed per call (env reads + one URL parse — negligible, and these are
 * low-frequency: OAuth init, server start). Deliberately uncached so it matches
 * the per-call env contract of the helpers it replaced and can't leak a stale
 * value across config changes or between tests.
 */
export function publicOrigin(): string {
  return computePublicOrigin();
}

/**
 * Every origin the platform is reachable at and trusts as same-origin: the
 * canonical origin, the platform subdomain, AND the custom domain when set —
 * the custom domain is included even when pinned non-canonical, because the ALB
 * still serves it, so a browser on it must pass CORS regardless of which host is
 * canonical. Callers fold these into the CORS allowlist so the canonical hosts
 * never have to be listed by hand in `ALLOWED_ORIGINS` (reserved for *additional*
 * origins).
 */
export function canonicalOrigins(): string[] {
  const origins = new Set<string>();
  origins.add(publicOrigin());
  const platformHost = process.env[PLATFORM_HOST_ENV]?.trim();
  if (platformHost) origins.add(`https://${platformHost}`);
  const customDomain = process.env[CUSTOM_DOMAIN_ENV]?.trim();
  if (customDomain) origins.add(`https://${customDomain}`);
  return [...origins];
}

/**
 * Origin for user-facing SPA URLs the platform redirects a browser to after an
 * OAuth callback (the connectors return page). `NB_WEB_URL` when set (dev's
 * API/SPA port split, or an operator override), else the canonical
 * `publicOrigin()`. Use this — not `publicOrigin()` — for anything the user's
 * browser navigates to; use `publicOrigin()` for vendor/OAuth callback URLs.
 */
export function webOrigin(): string {
  const explicit = process.env[WEB_URL_ENV]?.trim();
  if (explicit) return assertOrigin(explicit, WEB_URL_ENV);
  return publicOrigin();
}

function computePublicOrigin(): string {
  // 1. Explicit override — trusted as given, only shape-validated.
  const override = process.env[PUBLIC_ORIGIN_ENV]?.trim();
  if (override) return assertOrigin(override, PUBLIC_ORIGIN_ENV);

  // 2. Derived from the chart-forwarded facts. Custom domain wins when canonical.
  const platformHost = process.env[PLATFORM_HOST_ENV]?.trim();
  const customDomain = process.env[CUSTOM_DOMAIN_ENV]?.trim();
  const canonical = (process.env[CUSTOM_DOMAIN_CANONICAL_ENV] ?? "true").trim() !== "false";

  const derivedHost = customDomain && canonical ? customDomain : platformHost;
  if (derivedHost) return assertOrigin(`https://${derivedHost}`, "derived");

  // 3. Legacy fallback during migration (older deploys set only NB_API_URL).
  const legacy = process.env[LEGACY_API_URL_ENV]?.trim();
  if (legacy) return assertOrigin(legacy, LEGACY_API_URL_ENV);

  // 4. Dev default.
  return DEV_ORIGIN;
}

/**
 * Validate that `value` is a bare origin (scheme + host only) and return it
 * normalized without a trailing slash. `https` is required except for a
 * `localhost` host, which may be `http` for local dev. Throws on anything
 * malformed so the misconfig surfaces at startup, not at first OAuth click.
 */
function assertOrigin(value: string, source: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[public-origin] ${source} is not a valid URL: "${value}"`);
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
    throw new Error(
      `[public-origin] ${source} must be https (or http://localhost in dev): "${value}"`,
    );
  }
  // A path of only slashes (`/`, `//`) is sloppy-but-harmless trailing-slash
  // config that the legacy `NB_API_URL` consumers stripped with a regex — keep
  // tolerating it. A *real* path (`/v1/auth/callback`) is a misconfiguration
  // (someone pasted a full callback URL) and is rejected.
  const hasRealPath = url.pathname.replace(/\/+$/, "") !== "";
  if (hasRealPath || url.search || url.hash) {
    throw new Error(
      `[public-origin] ${source} must be a bare origin with no path/query/fragment: "${value}"`,
    );
  }
  // `url.origin` drops the trailing slash and any default port noise.
  return url.origin;
}
