import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Browser binding for a connector's redirect flow: the return leg completes
 * only in a browser the server handed a secret to when the flow began.
 *
 * An authenticated initiate mints a binding: a random cookie value for the
 * browser and its sha256 for the flow record. The callback admits a request
 * only when the sha256 of its cookie is one the flow recorded. The cookie
 * value is never in any URL, so knowing the flow's lookup key (the OAuth
 * `state`, the Composio nonce) does not let anyone build an admitted cookie.
 * The record keeps only the hash, so a dump of pending flows yields no cookie
 * either.
 *
 * A flow may record several bindings: each authenticated initiate that hands
 * out the same pending flow (a second member connecting a workspace connector
 * that is waiting on sign-in, a person pressing Connect again after closing the
 * provider's tab) adds one, and each of those browsers can complete it.
 *
 * Only this host can set a flow cookie: each one travels as `__Host-<name>`
 * (RFC 6265bis: `Secure`, `Path=/`, no `Domain`), which a browser accepts only
 * from this exact host, never from a sibling subdomain or a parent domain.
 * {@link flowCookieName} names it for both the write and the read, so the two
 * never name different cookies. Browsers treat http://localhost as a secure
 * context, so the `Secure` cookie works in local development too.
 *
 * Used by the connector OAuth callback (`src/api/routes/mcp-auth.ts`) and the
 * Composio callback (`src/connectors/providers/composio/routes.ts`). Each owns
 * its own flow store; this module owns only the binding.
 */

/** A minted binding: the value for the browser's cookie, and the hash the flow records. */
export interface BrowserBinding {
  cookieValue: string;
  bindingHash: string;
}

/** 32 random bytes, hex: the only shape a binding cookie takes. */
const BINDING_VALUE_RE = /^[0-9a-f]{64}$/;

/** Mint a fresh binding for one authenticated initiate. */
export function mintBrowserBinding(): BrowserBinding {
  const cookieValue = randomBytes(32).toString("hex");
  return { cookieValue, bindingHash: sha256(cookieValue).toString("hex") };
}

/** The name flow cookie `name` travels under: `__Host-<name>`. Every write and read of a flow cookie resolves its name here. */
export function flowCookieName(name: string): string {
  return `__Host-${name}`;
}

/**
 * Whether flow cookie `name` in `cookieHeader` is the browser half of one of
 * `bindingHashes`. False when the cookie is absent or malformed, or when no
 * hash is recorded. Every recorded hash is compared, each in constant time on
 * equal-length buffers, so the time taken does not say which (if any) matched.
 */
export function browserBindingMatches(
  cookieHeader: string | undefined,
  name: string,
  bindingHashes: Iterable<string>,
): boolean {
  const value = readFlowCookie(cookieHeader, name);
  if (!value || !BINDING_VALUE_RE.test(value)) return false;
  const presented = sha256(value);
  let matched = false;
  for (const hash of bindingHashes) {
    if (!BINDING_VALUE_RE.test(hash)) continue;
    if (timingSafeEqual(presented, Buffer.from(hash, "hex"))) matched = true;
  }
  return matched;
}

/**
 * Serialize flow cookie `name` as the `__Host-` prefix requires: `Secure`,
 * `Path=/`, no `Domain`; also `HttpOnly` and `SameSite=Lax` (a top-level return
 * navigation from the provider carries it). An empty `value` with
 * `maxAgeSeconds` 0 clears it.
 */
export function buildFlowCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${flowCookieName(name)}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "Secure",
  ].join("; ");
}

/** The value of flow cookie `name` in a `Cookie` header, or null when absent. */
export function readFlowCookie(header: string | undefined, name: string): string | null {
  return readCookie(header, flowCookieName(name));
}

/** The value of cookie `name` in a `Cookie` header, or null when absent. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}
