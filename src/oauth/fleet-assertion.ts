import { ALLOWED_TID_PATTERN, isUniformByte, signEnvelope } from "./envelope.ts";

/**
 * Sign the tenant-auth assertion the runtime presents to the MCP fleet
 * authorizer.
 *
 * The `tenant_id` claim minted by `mcp-authorizer` is the cross-tenant trust
 * boundary for the whole fleet. Rather than let the authorizer derive it from a
 * client-supplied string, the runtime PROVES its tenant: it holds a per-tenant
 * key (`NB_MCP_AUTHORIZER_TENANT_KEY` = HKDF(authorizer-master, salt=tid,
 * info="mcp-authorizer/v1"), provisioned at deploy time) and signs an assertion
 * binding its tid to the OAuth flow's PKCE `code_challenge` (passed as `inner`).
 * The authorizer re-derives the key from the master, verifies the MAC, checks
 * `inner === code_challenge`, and mints the verified tid.
 *
 * Reuses `signEnvelope` directly — the runtime never re-derives a key, so the
 * HKDF `info` string lives only in the offline derivation script. The key here
 * is the SAME wire protocol as the oauth-bouncer envelope, under a separate
 * trust domain (distinct master + info).
 *
 * `NB_FLEET_AUTHORIZER_ISSUER` is the mode signal. When it is set, the tenant id
 * and key are required: the authorizer refuses a token request without an
 * assertion, so a tenant that cannot sign one has no working fleet path. The
 * runtime refuses to start in that state (`readFleetAuthorizer`, called at
 * server start) rather than serving traffic and failing at the first connect.
 * When the issuer is unset, nothing here runs and the SDK's own client auth
 * handles every token request.
 */

const ISSUER_ENV = "NB_FLEET_AUTHORIZER_ISSUER";
const TENANT_KEY_ENV = "NB_MCP_AUTHORIZER_TENANT_KEY";
const TENANT_ID_ENV = "NB_TENANT_ID";
const MIN_TENANT_KEY_BYTES = 32;

/** The fleet authorizer this runtime asserts its tenant to. */
export interface FleetAuthorizer {
  /** Issuer of the fleet authorizer; the assertion goes only to its origin. */
  issuer: string;
  /** This tenant's id, the HKDF salt and the asserted tid. */
  tid: string;
  /** This tenant's derived assertion key, at least 32 bytes. */
  tenantKey: Buffer;
}

/**
 * Read the fleet-authorizer config from env. Returns `null` when
 * `NB_FLEET_AUTHORIZER_ISSUER` is unset (no fleet authorizer). Throws when the
 * issuer is set but the tenant id or key is missing or malformed. Validation is
 * a base64 decode, so it is read fresh on every call rather than cached.
 */
export function readFleetAuthorizer(env: NodeJS.ProcessEnv = process.env): FleetAuthorizer | null {
  const issuer = env[ISSUER_ENV];
  if (!issuer) return null;
  return { issuer, ...readTenantKey(env) };
}

/**
 * Provider option that turns on the fleet tenant assertion, derived from
 * `NB_FLEET_AUTHORIZER_ISSUER`. Spread into every `WorkspaceOAuthProvider`
 * construction at a token-exchanging site: `...fleetIssuerOption()`. Returns an
 * empty object when unset, so the provider leaves its token-auth hook
 * uninstalled (the SDK's own client auth runs). Centralized here so a new
 * token-exchanging site can't silently omit it.
 */
export function fleetIssuerOption(): { fleetAuthorizerIssuer?: string } {
  const fleet = readFleetAuthorizer();
  return fleet ? { fleetAuthorizerIssuer: fleet.issuer } : {};
}

/**
 * Sign an assertion binding this tenant to `inner`. Throws when the tenant id or
 * key is not provisioned: a token request to the fleet authorizer without an
 * assertion is refused, so failing here names the cause the authorizer's
 * `invalid_grant` would not.
 */
export function buildTenantAssertion(opts: { inner: string; ttlSeconds?: number }): string {
  const { tid, tenantKey } = readTenantKey(process.env);
  return signEnvelope({ tid, inner: opts.inner, tenantKey, ttlSeconds: opts.ttlSeconds });
}

function readTenantKey(env: NodeJS.ProcessEnv): { tid: string; tenantKey: Buffer } {
  const tid = env[TENANT_ID_ENV];
  const keyB64 = env[TENANT_KEY_ENV];
  if (!tid) {
    throw new Error(
      `[fleet authorizer] ${TENANT_ID_ENV} is not set; the fleet authorizer requires a tenant assertion`,
    );
  }
  if (!ALLOWED_TID_PATTERN.test(tid)) {
    throw new Error(
      `[fleet authorizer] ${TENANT_ID_ENV}="${tid}" does not match the DNS-label grammar required for tenant ids`,
    );
  }
  if (!keyB64) {
    throw new Error(
      `[fleet authorizer] ${TENANT_KEY_ENV} is not set; the fleet authorizer requires a tenant assertion. ` +
        "Provision the per-tenant key, HKDF of the authorizer master with the tenant id as salt.",
    );
  }
  const tenantKey = Buffer.from(keyB64, "base64");
  // A truncated or garbled key would sign assertions the authorizer rejects
  // with no clear cause. Fail loud here instead.
  if (tenantKey.length < MIN_TENANT_KEY_BYTES) {
    throw new Error(
      `[fleet authorizer] ${TENANT_KEY_ENV} must decode to >= ${MIN_TENANT_KEY_BYTES} bytes (got ${tenantKey.length})`,
    );
  }
  if (isUniformByte(tenantKey, 0) || isUniformByte(tenantKey, 0xff)) {
    throw new Error(
      `[fleet authorizer] ${TENANT_KEY_ENV} is a placeholder pattern (all 0x00 or all 0xff); ensure HKDF derivation ran during onboarding`,
    );
  }
  return { tid, tenantKey };
}
