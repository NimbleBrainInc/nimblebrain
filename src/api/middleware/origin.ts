import { isIP } from "node:net";
import { createMiddleware } from "hono/factory";
import { apiError } from "../types.ts";

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
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return hostname === "localhost" || isIP(hostname) !== 0;
}
