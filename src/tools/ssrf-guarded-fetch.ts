import type { FetchLike } from "@modelcontextprotocol/server";
import { loopbackDial } from "../connectors/runtime/host-loopback.ts";
import { validateConnectorUrl } from "../connectors/runtime/url-validator.ts";

/**
 * Maximum redirect hops to follow before giving up. A legitimate remote MCP
 * endpoint needs at most one or two same-origin hops (a trailing-slash or path
 * normalization — a scheme or host change is cross-origin and refused); a long
 * chain is either misconfiguration or an attacker walking us around the network.
 */
const MAX_REDIRECT_HOPS = 5;

/** How {@link createSsrfGuardedFetch} validates, dials and follows. */
export interface SsrfGuardOptions {
  allowInsecure: boolean;
  fleetInternal: boolean;
  /**
   * `"same-origin"` (the default) follows a same-origin redirect and refuses a
   * cross-origin one; `"refuse"` answers every 3xx with an error, and sends the
   * request body as given, unbuffered, since nothing replays it.
   */
  redirects?: "same-origin" | "refuse";
  /**
   * Where the request is actually sent, given the validated URL: replaces the
   * local-install loopback dial. Called after validation and never fed back,
   * so validation always sees the stored URL. A caller that resolves the name
   * itself connects to the address it checked here.
   */
  dial?: (url: URL, init: RequestInit) => Promise<{ url: URL; init: RequestInit }>;
}

/**
 * Wrap a `FetchLike` so HTTP redirects are followed MANUALLY with an SSRF
 * check on every hop.
 *
 * The MCP SDK's HTTP transports (`StreamableHTTPClientTransport`,
 * `SSEClientTransport`) call `fetch` with its default `redirect: "follow"`.
 * For a remote connector whose URL is tenant-supplied (a self-service `dcr` /
 * `static` connector install), that lets a hostile or compromised server
 * answer the initial request with `30x Location: http://169.254.169.254/...`
 * (cloud-metadata / IMDS) or an in-cluster service, and the SDK's fetch
 * silently follows it — turning our outbound fetch into an internal-network
 * probe. `validateConnectorUrl` runs once on the configured URL at startup; it
 * never sees the redirect target.
 *
 * This wrapper closes that gap by reusing the per-hop validation the headless
 * OAuth probe already performs (see `workspace-oauth-provider.ts`): issue each
 * request with `redirect: "manual"` and re-run `validateConnectorUrl` on every
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
  opts: SsrfGuardOptions,
): FetchLike {
  const doFetch: FetchLike = baseFetch ?? ((u, i) => fetch(u, i));
  const refuseRedirects = opts.redirects === "refuse";

  return async (input, init) => {
    let currentUrl = typeof input === "string" ? new URL(input) : new URL(input.toString());
    // A request that is never replayed keeps its body as given, so a streamed
    // body is sent as it arrives instead of buffered whole.
    let currentInit = await replayableInit(init, refuseRedirects);

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      // Redirects are same-origin only (enforced in `resolveRedirect`), so the
      // configured endpoint's opts — including `fleetInternal` for an
      // operator-vetted in-cluster http source — apply unchanged on every hop.
      // This validation is a backstop; the same-origin rule is the primary control.
      validateConnectorUrl(currentUrl, {
        allowInsecure: opts.allowInsecure,
        fleetInternal: opts.fleetInternal,
      });

      // On a local install a loopback URL is dialed at the host alias, with
      // its own `Host` kept (`loopbackDial`). Applied after validation and
      // never fed back into the loop: validation and the same-origin rule
      // always see the stored URL.
      const dial = await dialFor(opts, currentUrl, { ...currentInit, redirect: "manual" });
      const res = await doFetch(dial.url, dial.init);

      if (refuseRedirects) return refusingRedirect(res);
      const outcome = resolveRedirect(res, currentUrl, currentInit);
      if (!outcome.follow) return outcome.response;

      currentUrl = outcome.url;
      currentInit = outcome.init;
    }

    throw new Error(`SSRF guard: remote endpoint exceeded ${MAX_REDIRECT_HOPS} redirect hops`);
  };
}

/** Where to send a request for the validated `url`: the caller's dial, else the local-install loopback dial. */
async function dialFor(
  opts: SsrfGuardOptions,
  url: URL,
  init: RequestInit,
): Promise<{ url: URL; init: RequestInit | undefined }> {
  return opts.dial ? opts.dial(url, init) : loopbackDial(url, init);
}

/** `res`, unless it is a redirect, which a transfer that refuses redirects answers with an error. */
function refusingRedirect(res: Response): Response {
  if (res.status < 300 || res.status >= 400) return res;
  void res.body?.cancel().catch(() => {});
  throw new Error(`SSRF guard: refusing a redirect (${res.status})`);
}

/**
 * The result of inspecting one `redirect: "manual"` response: either a terminal
 * response to hand back to the caller, or the next same-origin hop to follow.
 */
type RedirectOutcome =
  | { follow: false; response: Response }
  | { follow: true; url: URL; init: RequestInit };

/** The request's init: its body as given when nothing replays it, else buffered for replay. */
async function replayableInit(
  init: RequestInit | undefined,
  refuseRedirects: boolean,
): Promise<RequestInit> {
  return refuseRedirects ? { ...init } : bufferReplayableBody({ ...init });
}

/** Buffer a non-string request body to BYTES so it survives replay across 307/308 redirect hops. */
async function bufferReplayableBody(init: RequestInit): Promise<RequestInit> {
  // Buffer a non-string body once so it can be replayed across redirect hops
  // (a 307/308 re-sends the same body). JSON-RPC bodies are already strings,
  // so this is a no-op on the hot path.
  //
  // Buffered as bytes, not text. Decoding to a string round-trips the body
  // through UTF-8, which is lossless only for input that was valid UTF-8 to
  // begin with: anything else — a binary payload, a latin-1 body, a truncated
  // multi-byte sequence — comes back with replacement characters, and the
  // request that goes upstream is no longer the one that came in. That is
  // invisible on the JSON-RPC path this originally served and fatal on the
  // hooks door, which forwards a vendor's bytes verbatim so the receiving
  // server can verify a signature computed over them.
  const rawBody = init.body;
  if (rawBody == null || typeof rawBody === "string") return init;
  return { ...init, body: new Uint8Array(await new Response(rawBody).arrayBuffer()) };
}

/** Classify a manual-redirect response as terminal or a same-origin hop to follow; throw on a cross-origin bounce. */
function resolveRedirect(
  res: Response,
  currentUrl: URL,
  currentInit: RequestInit,
): RedirectOutcome {
  // Not a redirect — hand the response back as the SDK expects.
  if (res.status < 300 || res.status >= 400) return { follow: false, response: res };

  const location = res.headers.get("location");
  if (!location) return { follow: false, response: res }; // 3xx with no Location: nothing to follow.

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
  const nextInit =
    res.status === 303 ? { ...currentInit, method: "GET", body: undefined } : currentInit;

  return { follow: true, url: next, init: nextInit };
}
