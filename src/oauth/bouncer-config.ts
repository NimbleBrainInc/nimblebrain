/**
 * Process-wide configuration for OAuth callback bouncer mode.
 *
 * The bouncer lets a multi-tenant deployment register a single
 * `redirect_uri` per vendor (Google, Dropbox, ...) instead of one per
 * tenant. When bouncer mode is enabled, the platform sends the bouncer's
 * URL as `redirect_uri` and wraps the `state` parameter in a signed
 * envelope so the bouncer can route the callback back to this tenant.
 *
 * Single-instance self-hosters leave these env vars unset; every
 * branch in `mcp-auth.ts` falls back to direct mode (tenant host as
 * `redirect_uri`, opaque `state`). See `envelope.ts` for the wire
 * protocol.
 *
 * Configuration is via environment variables:
 *
 *   NB_OAUTH_BOUNCER_CALLBACK_URL: full URL the vendor will redirect to
 *     (e.g. `https://connect.example.com/v1/mcp-auth/callback`).
 *     Presence of this var enables bouncer mode; absence disables it.
 *
 *   NB_OAUTH_BOUNCER_TENANT_KEY: base64-encoded 32-byte HMAC key for
 *     this tenant. Provisioned at deploy time from the bouncer's master
 *     key via HKDF; the tenant pod never sees the master. Mount via
 *     `secretKeyRef` so it lands in env from a k8s Secret.
 *
 *   NB_TENANT_ID: this pod's tenant identifier, matching the DNS label
 *     grammar enforced by `ALLOWED_TID_PATTERN`. This is the general
 *     "which tenant am I" primitive (useful beyond OAuth: structured
 *     logs, telemetry, error reporting); bouncer mode reuses it as the
 *     envelope tid and as the HKDF salt. Critically, the SAME value
 *     must feed key derivation at deploy time and envelope signing at
 *     runtime, so plumbing both endpoints from one source eliminates
 *     a class of `bad_mac` mismatches from typos.
 *
 * Bouncer mode requires all three. Partial configuration of the two
 * `NB_OAUTH_BOUNCER_*` vars, a missing `NB_TENANT_ID` while bouncer
 * mode is requested, or any malformed value is a deploy-time error
 * that fails closed at the first call to `getBouncerMode()`. The
 * mcp-auth route module calls this at module load via `mcpAuthRoutes`,
 * so a misconfigured deployment crashes immediately at server startup
 * rather than serving traffic and failing on the first user OAuth
 * attempt. Subsequent calls hit the cache and don't re-validate.
 */

import { ALLOWED_TID_PATTERN, isUniformByte } from "./envelope.ts";

export interface BouncerMode {
  /** Full URL registered at every vendor's OAuth Client. */
  callbackUrl: string;
  /** This tenant's identifier, used in the state envelope. */
  tid: string;
  /** This tenant's derived HMAC key, 32 bytes. */
  tenantKey: Buffer;
}

const CALLBACK_URL_ENV = "NB_OAUTH_BOUNCER_CALLBACK_URL";
const TENANT_KEY_ENV = "NB_OAUTH_BOUNCER_TENANT_KEY";
const TENANT_ID_ENV = "NB_TENANT_ID";

const REQUIRED_KEY_BYTES = 32;

/**
 * Path the bouncer must serve. The platform-side `nb_oauth_state`
 * cookie is scoped to this path; any divergence in the bouncer URL
 * silently breaks every OAuth flow with a session-mismatch error
 * that points nowhere obvious. Hardcoded here and in `mcp-auth.ts`
 * by the same value; changing one without the other is incoherent.
 */
const EXPECTED_CALLBACK_PATH = "/v1/mcp-auth/callback";

let _cached: BouncerMode | null | undefined;

/**
 * Returns the bouncer-mode config if configured, or `null` if direct
 * mode is in use. Validates and caches on first access; throws if any
 * of the three env vars are set without the others or with malformed
 * values.
 */
export function getBouncerMode(): BouncerMode | null {
  if (_cached !== undefined) return _cached;
  _cached = readAndValidate(process.env);
  return _cached;
}

/**
 * Reset the cached config. Test-only — production code reads env once
 * at process start and never re-reads.
 */
export function _resetBouncerModeForTest(): void {
  _cached = undefined;
}

function readAndValidate(env: NodeJS.ProcessEnv): BouncerMode | null {
  const callbackUrl = env[CALLBACK_URL_ENV];
  const tenantKeyB64 = env[TENANT_KEY_ENV];
  const tid = env[TENANT_ID_ENV];

  const bouncerVarsPresent = [callbackUrl, tenantKeyB64].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  // Direct mode: neither bouncer-specific var is set. Don't care
  // whether NB_TENANT_ID is set; other parts of the platform may use
  // it for telemetry/logs without triggering bouncer mode.
  if (bouncerVarsPresent.length === 0) return null;

  // Partial config of the two bouncer vars is almost always a deploy
  // mistake (operator wired one Helm value but not the other).
  if (bouncerVarsPresent.length < 2) {
    const missing = [
      callbackUrl ? null : CALLBACK_URL_ENV,
      tenantKeyB64 ? null : TENANT_KEY_ENV,
    ].filter((v): v is string => v !== null);
    throw new Error(
      `[oauth bouncer] Partial configuration. Set both ${CALLBACK_URL_ENV} and ${TENANT_KEY_ENV} together or neither. Missing: ${missing.join(", ")}`,
    );
  }

  // Bouncer mode requires the tenant identity primitive — both for the
  // envelope tid and to keep deploy-time HKDF salting and runtime
  // signing pinned to the same value.
  if (typeof tid !== "string" || tid.length === 0) {
    throw new Error(
      `[oauth bouncer] Bouncer mode requires ${TENANT_ID_ENV} to be set. The chart should inject it from .Values.tenant.id.`,
    );
  }

  // Narrow for TS. Both bouncer vars are non-empty strings at this point.
  if (!callbackUrl || !tenantKeyB64) {
    throw new Error("[oauth bouncer] internal: presence check failed unexpectedly");
  }

  // URL must be absolute https (or http for localhost-style dev only).
  // Reject anything else — the vendor will reject non-https URIs anyway,
  // and we'd rather fail at boot than at the first OAuth flow.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(callbackUrl);
  } catch {
    throw new Error(`[oauth bouncer] ${CALLBACK_URL_ENV} is not a valid URL: ${callbackUrl}`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error(
      `[oauth bouncer] ${CALLBACK_URL_ENV} must use http(s); got ${parsedUrl.protocol}`,
    );
  }
  // The platform-side cookie that binds the OAuth flow to a session is
  // scoped to `Path=/v1/mcp-auth/callback`, hard-coded in `mcp-auth.ts`.
  // A bouncer URL that lands callbacks on any other path means the cookie
  // never travels back, and every flow fails the session-mismatch check
  // with no clear root cause. Lock the implicit coupling explicit.
  if (!parsedUrl.pathname.endsWith(EXPECTED_CALLBACK_PATH)) {
    throw new Error(
      `[oauth bouncer] ${CALLBACK_URL_ENV} must end with "${EXPECTED_CALLBACK_PATH}" (got "${parsedUrl.pathname}"). The platform's session-binding cookie is scoped to this path; a divergent URL silently breaks every OAuth flow.`,
    );
  }

  if (!ALLOWED_TID_PATTERN.test(tid)) {
    throw new Error(
      `[oauth bouncer] ${TENANT_ID_ENV}="${tid}" does not match the DNS-label grammar required for tenant ids in bouncer mode`,
    );
  }

  let tenantKey: Buffer;
  try {
    tenantKey = Buffer.from(tenantKeyB64, "base64");
  } catch {
    throw new Error(`[oauth bouncer] ${TENANT_KEY_ENV} is not valid base64`);
  }
  if (tenantKey.length !== REQUIRED_KEY_BYTES) {
    throw new Error(
      `[oauth bouncer] ${TENANT_KEY_ENV} must decode to ${REQUIRED_KEY_BYTES} bytes (got ${tenantKey.length})`,
    );
  }
  // Symmetric defense with the master-key check in `deriveTenantKey`.
  // The blast radius is smaller here (one tenant, not all), but the
  // operator failure mode is identical: a base64-encoded placeholder
  // buffer lands in 1Password and passes the length check.
  if (isUniformByte(tenantKey, 0) || isUniformByte(tenantKey, 0xff)) {
    throw new Error(
      `[oauth bouncer] ${TENANT_KEY_ENV} is a placeholder pattern (all 0x00 or all 0xff); ensure HKDF derivation ran during onboarding`,
    );
  }

  return { callbackUrl, tid, tenantKey };
}
