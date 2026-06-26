import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { validateBundleUrl } from "../bundles/url-validator.ts";

/**
 * Maximum redirect hops to follow before giving up. A legitimate remote MCP
 * endpoint needs at most one or two same-origin hops (a trailing-slash or path
 * normalization — a scheme or host change is cross-origin and refused); a long
 * chain is either misconfiguration or an attacker walking us around the network.
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * Wrap a `FetchLike` so HTTP redirects are followed MANUALLY with an SSRF
 * check on every hop.
 *
 * The MCP SDK's HTTP transports (`StreamableHTTPClientTransport`,
 * `SSEClientTransport`) call `fetch` with its default `redirect: "follow"`.
 * For a remote bundle whose URL is tenant-supplied (a self-service `dcr` /
 * `static` connector install), that lets a hostile or compromised server
 * answer the initial request with `30x Location: http://169.254.169.254/...`
 * (cloud-metadata / IMDS) or an in-cluster service, and the SDK's fetch
 * silently follows it — turning our outbound fetch into an internal-network
 * probe. `validateBundleUrl` runs once on the configured URL at startup; it
 * never sees the redirect target.
 *
 * This wrapper closes that gap by reusing the per-hop validation the headless
 * OAuth probe already performs (see `workspace-oauth-provider.ts`): issue each
 * request with `redirect: "manual"` and re-run `validateBundleUrl` on every
 * hop. The primary control is stricter than the probe's, though: redirects are
 * followed **same-origin only**. A cross-origin bounce is refused outright —
 * it is the SSRF pivot, and re-issuing the request to a new origin would leak
 * the connection's credential headers (Authorization / minted fleet token /
 * API key) to a different trust scope, which WHATWG `fetch` strips for exactly
 * this reason. Because every hop is same-origin as the configured endpoint, the
 * connection's own opts (`fleetInternal` for an operator-vetted in-cluster
 * source) apply unchanged throughout, and replaying credentials is safe.
 *
 * @param baseFetch The fetch the transport would otherwise use (a minting fetch,
 *   the OAuth-refresh fetch, or `undefined` → the global `fetch`). Its behavior
 *   is preserved; only redirect handling is interposed.
 */
export function createSsrfGuardedFetch(
  baseFetch: FetchLike | undefined,
  opts: { allowInsecure: boolean; fleetInternal: boolean },
): FetchLike {
  const doFetch: FetchLike = baseFetch ?? ((u, i) => fetch(u, i));

  return async (input, init) => {
    let currentUrl = typeof input === "string" ? new URL(input) : new URL(input.toString());
    let currentInit: RequestInit = { ...init };

    // Buffer a non-string body once so it can be replayed across redirect hops
    // (a 307/308 re-sends the same body). JSON-RPC bodies are already strings,
    // so this is a no-op on the hot path.
    const rawBody = currentInit.body;
    if (rawBody != null && typeof rawBody !== "string") {
      currentInit.body = await new Response(rawBody).text();
    }

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      // Redirects are same-origin only (enforced below), so the configured
      // endpoint's opts — including `fleetInternal` for an operator-vetted
      // in-cluster http source — apply unchanged on every hop. This validation
      // is a backstop; the same-origin rule below is the primary control.
      validateBundleUrl(currentUrl, {
        allowInsecure: opts.allowInsecure,
        fleetInternal: opts.fleetInternal,
      });

      const res = await doFetch(currentUrl, { ...currentInit, redirect: "manual" });

      // Not a redirect — hand the response back as the SDK expects.
      if (res.status < 300 || res.status >= 400) return res;

      const location = res.headers.get("location");
      if (!location) return res; // 3xx with no Location: nothing to follow.

      const next = new URL(location, currentUrl);

      // Follow SAME-ORIGIN redirects only; refuse anything cross-origin. A
      // cross-origin bounce is both the SSRF pivot (to a host we don't control,
      // or an internal one) AND a credential-leak vector: we re-issue the
      // request with its original headers, which carry Authorization /
      // minted-fleet / API-key credentials. WHATWG `fetch` strips those across
      // origins precisely because the new origin is a different trust scope —
      // this manual loop must not regress that protection. A legitimate
      // JSON-RPC endpoint needs at most a same-origin redirect (trailing-slash
      // or path normalization); same origin = same trust scope, so replaying
      // credentials there is safe.
      if (next.origin !== currentUrl.origin) {
        throw new Error(
          `SSRF guard: refusing cross-origin redirect from ${currentUrl.origin} to ${next.origin}`,
        );
      }

      // Per fetch semantics, a 303 turns the follow-up into a bodyless GET;
      // 307/308 preserve method and body. We only need to drop the body on 303.
      if (res.status === 303) {
        currentInit = { ...currentInit, method: "GET", body: undefined };
      }
      currentUrl = next;
    }

    throw new Error(`SSRF guard: remote endpoint exceeded ${MAX_REDIRECT_HOPS} redirect hops`);
  };
}
