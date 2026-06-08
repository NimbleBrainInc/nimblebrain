import { signEnvelope } from "./envelope.ts";

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
 * Returns `null` when the key isn't provisioned (rollout phase 1): the caller
 * simply omits the assertion, and the authorizer's accept-but-don't-require mode
 * falls back to the legacy path. Once the authorizer enforces assertions
 * (rather than accepting-but-not-requiring), an unprovisioned tenant fails
 * closed at the authorizer, which is correct.
 */
export function buildTenantAssertion(opts: { inner: string; ttlSeconds?: number }): string | null {
  const tid = process.env.NB_TENANT_ID;
  const keyB64 = process.env.NB_MCP_AUTHORIZER_TENANT_KEY;
  if (!tid || !keyB64) return null;

  const tenantKey = Buffer.from(keyB64, "base64");
  // Defensive: a truncated/garbled key would mint assertions the authorizer
  // rejects with no clear cause. Fail loud at the signing boundary instead.
  if (tenantKey.length < 32) {
    throw new Error(
      `NB_MCP_AUTHORIZER_TENANT_KEY must decode to >= 32 bytes (got ${tenantKey.length})`,
    );
  }

  return signEnvelope({ tid, inner: opts.inner, tenantKey, ttlSeconds: opts.ttlSeconds });
}
