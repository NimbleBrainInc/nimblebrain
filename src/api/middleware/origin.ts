import { isIP } from "node:net";
import { createMiddleware } from "hono/factory";
import { canonicalOrigins, webOrigin } from "../../oauth/public-origin.ts";
import { apiError } from "../types.ts";

/**
 * The origins a browser page may call this server's tool doors from: this
 * deployment's own (canonical and web) and the CORS allowlist. Shared by `/mcp`
 * and the `/v1` tool-call routes, so the two doors trust the same pages.
 */
export function trustedBrowserOrigins(allowedOrigins: ReadonlySet<string> | null): Set<string> {
  return new Set([...canonicalOrigins(), webOrigin(), ...(allowedOrigins ?? [])]);
}

/**
 * Refuse a request whose `Origin` this server does not trust, with `403`.
 *
 * This is the MCP transport's DNS-rebinding rule: a page on an attacker's
 * hostname, re-resolved to this server's address, sends requests the browser
 * treats as same-origin, so no CORS preflight stops them, and an identity
 * provider that authenticates every request (`dev`) admits them. The `Origin`
 * still names the attacker's hostname.
 *
 * An `Origin` is trusted when it is one of `trusted` (the canonical, web and
 * CORS-allowlisted origins), or when it is this request's own origin on a host
 * no one can rebind: `localhost` or an IP literal, matched against `Host`. That
 * second case is a self-hosted runtime opened at its own address with no origin
 * configured; a hostname it is reached by must be configured to be trusted.
 *
 * A request without `Origin` is not from a browser page and passes: MCP
 * clients and other server callers send none.
 */
export function rejectUntrustedOrigin(trusted: ReadonlySet<string>) {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header("origin");
    if (origin === undefined || isTrustedOrigin(origin, c.req.header("host"), trusted)) {
      return next();
    }
    return apiError(403, "untrusted_origin", "Request origin is not trusted");
  });
}

function isTrustedOrigin(
  origin: string,
  host: string | undefined,
  trusted: ReadonlySet<string>,
): boolean {
  if (trusted.has(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // `null` (an opaque origin) and anything malformed.
    return false;
  }
  if (url.origin !== origin || url.host !== host?.toLowerCase()) return false;
  return isLocalAddressHostname(url.hostname);
}

/**
 * Whether a URL's hostname is `localhost` or an IP literal (IPv6 in brackets,
 * as `URL` gives it): an address the browser connects to as written, so a page
 * served under that name is this server's own. Any other name resolves through
 * DNS, and only configuration can say it names this server.
 */
export function isLocalAddressHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  return bare === "localhost" || isIP(bare) !== 0;
}
