/**
 * Which account an OAuth connection signed in as, from the standard OpenID
 * Connect sources: the `id_token` in the token response, then the
 * authorization server's userinfo endpoint (OIDC Core §5.3). MCP defines no
 * identity call, so a server that does no OIDC has no account to name, and the
 * connection shows "Connected". Nothing here guesses: an access token is opaque
 * to its client (RFC 9068 §6), and token introspection is for resource servers.
 *
 * The claims are informational. They are shown in the UI and never used for an
 * access decision.
 */

import { buildDiscoveryUrls, type FetchLike } from "@modelcontextprotocol/client";

export interface IdentityClaims {
  sub?: string;
  email?: string;
  name?: string;
}

/** The part of an authorization server's metadata that bears on identity. */
export interface IdentityMetadata {
  scopesSupported: string[];
  userinfoEndpoint?: string;
}

/** Bound on each identity read, so a slow server delays a sign-in by at most this per read. */
export const IDENTITY_FETCH_TIMEOUT_MS = 3_000;

/** Largest metadata or userinfo body read. Real ones run to a few KB. */
const MAX_BODY_BYTES = 64 * 1024;

/** `sub`, `email`, and `name` when present as strings, or `null` for none. */
export function pickIdentityClaims(claims: Record<string, unknown>): IdentityClaims | null {
  const out: IdentityClaims = {};
  if (typeof claims.sub === "string") out.sub = claims.sub;
  if (typeof claims.email === "string") out.email = claims.email;
  if (typeof claims.name === "string") out.name = claims.name;
  return Object.keys(out).length > 0 ? out : null;
}

/** Whether the claims name an account a person can recognize. `sub` is opaque. */
export function namesAccount(claims: IdentityClaims | null): boolean {
  return !!claims && (claims.email !== undefined || claims.name !== undefined);
}

/**
 * The OIDC scopes to add to an authorize request so the server returns an
 * identity: `openid`, plus `email` where advertised. `profile` is left out: the
 * email names the account, and each scope can lengthen the consent screen. Empty when
 * the server does not advertise `openid` (it does no OIDC) or when `scope` is
 * absent. An absent `scope` asks for the server's default grant, and adding
 * identity scopes to it would narrow that grant to identity alone.
 */
export function identityScopesToAdd(
  scope: string | null,
  metadata: IdentityMetadata | undefined,
): string[] {
  if (!scope || !metadata?.scopesSupported.includes("openid")) return [];
  const have = new Set(scope.split(" "));
  return ["openid", "email"].filter((s) => metadata.scopesSupported.includes(s) && !have.has(s));
}

/**
 * Read the identity fields of the metadata for `issuer`. OIDC discovery comes
 * first, because the userinfo endpoint is an OIDC field that many servers
 * publish only there; RFC 8414 metadata is the fallback. A document whose
 * `issuer` differs from the one asked about is ignored (RFC 8414 §3.3, OIDC
 * Discovery §4.3). Returns undefined when no document is found. `fetcher` must
 * be SSRF-guarded: the issuer comes from a remote server's metadata.
 */
export async function discoverIdentityMetadata(
  issuer: string,
  fetcher: FetchLike,
): Promise<IdentityMetadata | undefined> {
  const urls = buildDiscoveryUrls(issuer).sort(
    (a, b) => Number(b.type === "oidc") - Number(a.type === "oidc"),
  );
  const expected = issuer.replace(/\/$/, "");
  for (const { url } of urls) {
    const doc = await fetchJson(fetcher, url, {});
    if (!doc || typeof doc.issuer !== "string" || doc.issuer.replace(/\/$/, "") !== expected) {
      continue;
    }
    const scopesSupported = Array.isArray(doc.scopes_supported)
      ? doc.scopes_supported.filter((s): s is string => typeof s === "string")
      : [];
    const userinfo = doc.userinfo_endpoint;
    return {
      scopesSupported,
      ...(typeof userinfo === "string" ? { userinfoEndpoint: userinfo } : {}),
    };
  }
  return undefined;
}

/**
 * The claims the userinfo endpoint returns for `accessToken`, or `null`. The
 * endpoint comes from the metadata of the server that issued the token, and
 * `fetcher` must be SSRF-guarded, which also keeps a redirect on the endpoint's
 * origin. A response without `sub` is not a userinfo response (OIDC Core
 * §5.3.2) and yields `null`.
 */
export async function fetchUserinfo(
  endpoint: string,
  accessToken: string,
  fetcher: FetchLike,
): Promise<IdentityClaims | null> {
  const body = await fetchJson(fetcher, new URL(endpoint), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!body || typeof body.sub !== "string") return null;
  return pickIdentityClaims(body);
}

async function fetchJson(
  fetcher: FetchLike,
  url: URL,
  init: RequestInit,
): Promise<Record<string, unknown> | undefined> {
  const res = await fetcher(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers as Record<string, string>) },
  });
  if (!res.ok) {
    await res.body?.cancel();
    return undefined;
  }
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
