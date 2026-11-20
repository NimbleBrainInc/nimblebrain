import { createMiddleware } from "hono/factory";
import { apiError } from "../types.ts";
import { isLocalAddressHostname } from "./origin.ts";

/**
 * Answer only a request addressed to a loopback or configured host, with `403`
 * otherwise. Mounted on every route in `app.ts` when the identity provider
 * checks no credential (the `dev` adapter).
 *
 * Without sign-in every request is the local admin, so the address a request
 * names is what says it came from a page of this server. A page served under
 * another hostname that resolves to this machine is same-origin to the
 * browser: CORS and the cross-site guard pass it, and its `GET`s carry no
 * `Origin`. Its `Host` still names that other hostname.
 *
 * `Host` is accepted when it is the host of one of `trusted` (the canonical,
 * web and CORS-allowlisted origins), or when its hostname is `localhost` or an
 * IP literal (`isLocalAddressHostname`). A request without `Host` is not from
 * a browser and passes.
 */
export function rejectUnlistedHost(trusted: ReadonlySet<string>) {
  const hosts = new Set<string>();
  for (const origin of trusted) {
    try {
      hosts.add(new URL(origin).host);
    } catch {
      // An `ALLOWED_ORIGINS` entry that is not a URL names no host.
    }
  }
  return createMiddleware(async (c, next) => {
    const host = c.req.header("host");
    if (host === undefined || isListedHost(host.toLowerCase(), hosts)) return next();
    return apiError(
      403,
      "untrusted_host",
      "Without sign-in, this server answers only requests addressed to a loopback or configured host",
    );
  });
}

function isListedHost(host: string, hosts: ReadonlySet<string>): boolean {
  if (hosts.has(host)) return true;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  // `Host` is `hostname[:port]` and nothing else; a value the URL parser reads
  // differently (userinfo, a path) is malformed.
  if (url.host !== host && `${url.hostname}:80` !== host) return false;
  return isLocalAddressHostname(url.hostname);
}
