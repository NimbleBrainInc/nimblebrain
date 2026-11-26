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

/**
 * Whether the `cookieName` cookie in `cookieHeader` is the browser half of one
 * of `bindingHashes`. False when the cookie is absent or malformed, or when no
 * hash is recorded. Every recorded hash is compared, each in constant time on
 * equal-length buffers, so the time taken does not say which (if any) matched.
 */
export function browserBindingMatches(
  cookieHeader: string | undefined,
  cookieName: string,
  bindingHashes: Iterable<string>,
): boolean {
  const value = readCookie(cookieHeader, cookieName);
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
 * Serialize a binding cookie scoped to its callback path, so the browser sends
 * it only on the return leg. `HttpOnly` and `SameSite=Lax` (a top-level return
 * navigation from the provider carries it); `Secure` when `secure`. An empty
 * `value` with `maxAgeSeconds` 0 clears it.
 */
export function buildFlowCookie(
  name: string,
  path: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${name}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
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
