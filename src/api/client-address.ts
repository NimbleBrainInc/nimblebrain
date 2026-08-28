/**
 * Resolving the client address of a request that arrived through a proxy.
 *
 * **This is the only load-bearing reader of `X-Forwarded-For` in the runtime.**
 * Two others exist — `logAuthFailure` in `auth-middleware.ts` and
 * `fmtSessionContext` in `mcp-server.ts` — and both take the left-most entry,
 * which a caller can set to anything. That is tolerable there because both feed
 * a log line and neither decides whether a request is served. Nothing else may
 * join them: a security decision keyed on the left-most entry is a security
 * decision the caller makes for you. `middleware/rate-limit.ts` reaches the same
 * conclusion from the other side and refuses to read the header at all, which is
 * right for a route whose limiter has a better key available (an authenticated
 * identity).
 *
 * The hooks door has no better key. Its pre-token bucket runs before anything is
 * known about the caller, and the spec is explicit that keying it per source is
 * the whole design: a single prefix-wide counter lets one flooding host hold the
 * bucket empty and 429 every legitimate delivery, so the control becomes the
 * denial. That makes an honest client address a correctness requirement, not a
 * diagnostic nicety.
 *
 * **The rule.** Each proxy in the chain APPENDS the address it saw. So the
 * entries a caller can forge are the ones on the LEFT — the ones supposedly
 * added before our infrastructure got involved — and the trustworthy ones are on
 * the RIGHT, one per proxy we actually run. Counting `trustedHops` back from the
 * right lands on the address our outermost proxy observed, which is the client.
 *
 * **Why the default is 1, and why the error directions are not symmetric.**
 * Configure too FEW hops and you land on a proxy's address instead of the
 * client's, collapsing everyone behind that proxy into one bucket — an
 * availability problem. Configure too MANY and you land on an entry the caller
 * wrote, letting them pick their own bucket key — a bypass. One is worse than
 * the other, so the default errs toward the safe direction: a single trusted hop
 * (the shared ALB in a deployed tenant, which appends the client address it saw)
 * and no assumption of anything beyond it. A deployment that fronts the ALB with
 * a CDN raises `NB_TRUSTED_PROXY_HOPS` to match.
 */

import { log } from "../observability/log.ts";

/** Operator override for how many proxies append to `X-Forwarded-For` before us. */
export const TRUSTED_PROXY_HOPS_ENV = "NB_TRUSTED_PROXY_HOPS";

/** One proxy: the shared ALB in front of a deployed tenant. See the header doc. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

let warnedInvalidHops = false;

/**
 * Read the configured trusted-hop count. An unparseable or negative value falls
 * back to the default with one warning — a typo must not silently promote a
 * caller-controlled entry to trusted.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TRUSTED_PROXY_HOPS_ENV]?.trim();
  if (!raw) return DEFAULT_TRUSTED_PROXY_HOPS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    if (!warnedInvalidHops) {
      warnedInvalidHops = true;
      log.warn("[hooks] invalid trusted-proxy-hop count; using the default", {
        configured: raw,
        using: DEFAULT_TRUSTED_PROXY_HOPS,
      });
    }
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  return parsed;
}

/**
 * The rate-limit key for one request: the client address as the outermost proxy
 * we trust observed it, or the socket peer when there is no usable header.
 *
 * `peer` is the transport-level remote address (Bun's `server.requestIP`), which
 * behind a proxy is the proxy — correct only when the header is absent, which is
 * exactly when it is used. `"unknown"` is the last resort and is a shared
 * bucket; it is reachable only when a request arrives with neither a usable
 * forwarded chain nor a peer, which in practice means an in-process test.
 */
export function clientAddressFor(
  headers: Headers,
  peer: string | null | undefined,
  hops: number = trustedProxyHops(),
): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    // Take the entry `hops` back from the right. A chain SHORTER than the
    // configured hop count means the request did not come through the proxies
    // we expect, so none of its entries were appended by us and none may be
    // trusted — fall through to the peer rather than reaching left into
    // caller-written territory.
    if (entries.length >= hops) {
      const entry = entries[entries.length - hops];
      if (entry) return entry;
    }
  }
  return peer?.trim() || "unknown";
}
