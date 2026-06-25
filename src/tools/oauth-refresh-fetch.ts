import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { log } from "../observability/log.ts";

/**
 * Refresh-aware `fetch` wrapper for remote OAuth MCP connectors.
 *
 * ## Why this exists
 *
 * The MCP SDK's `auth()` collapses three distinct token-refresh outcomes
 * into one indistinguishable `redirectToAuthorization()` call
 * (`@modelcontextprotocol/sdk/client/auth.js`, the `catch` at the refresh
 * `try`): a transient failure (network throw, or a 5xx/`server_error` that
 * `parseErrorResponse` maps to `ServerError`) is **swallowed** and falls
 * through to a fresh-authorization attempt — exactly like a genuinely dead
 * refresh token. On our headless server, `WorkspaceOAuthProvider`
 * `redirectToAuthorization()` can't open a browser, so it throws
 * `UnauthorizedError`. `McpSource.execute()` then reads that as "the refresh
 * token was rejected", flips the connection to `reauth_required`, and drops
 * the connector from the run — telling the user to reconnect a connector
 * whose credential was never actually rejected.
 *
 * By the time control reaches the provider, the transient-vs-dead bit has
 * already been erased. The one seam where it is still live is the refresh
 * HTTP call itself. The SDK threads the transport's `fetch` (`opts.fetch`)
 * all the way into `executeTokenRequest` via `createFetchWithInit`, so a
 * wrapping `fetch` injected on the OAuth transport can absorb transient
 * token-endpoint failures with bounded retry *before* the swallow can
 * fabricate a fake `UnauthorizedError`. A genuine `invalid_grant` /
 * `invalid_client` is passed through unmodified on the first attempt, so the
 * SDK's existing dead-token → redirect → `UnauthorizedError` path still
 * fires and the `reauth_required` flip stays correct.
 *
 * ## Scope
 *
 * Only the idempotent OAuth refresh-token POST (`grant_type=refresh_token`)
 * is retried. Every other transport request — the MCP JSON-RPC tool calls,
 * the one-shot `authorization_code` exchange — passes straight through to a
 * single `fetch`, so tool-call semantics and the inline/task retry asymmetry
 * in `McpSource` are untouched.
 */

/**
 * OAuth error codes that mean the refresh token is genuinely dead — retrying
 * can't help and the connector must be reconnected by the user. Anything else
 * (5xx, 429, network throw, `server_error`, `temporarily_unavailable`) is
 * transient and worth a bounded retry.
 *
 * Safety note: the retry decision is an ALLOWLIST — only `TRANSIENT_REFRESH_ERRORS`
 * retry; any unrecognized 4xx code is treated as permanent by default. This set
 * is therefore an intent-documenting short-circuit, not the load-bearing guard
 * (the allowlist default is). Fail-closed: an unknown code never retries.
 */
const PERMANENT_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

/** OAuth error codes that are explicitly transient even on a 4xx response. */
const TRANSIENT_REFRESH_ERRORS = new Set([
  "server_error",
  "temporarily_unavailable",
  "too_many_requests",
]);

export interface OAuthRefreshFetchOptions {
  /** Total attempts including the first (default 3 → up to 2 retries). */
  maxAttempts?: number;
  /** Backoff base in ms; grows exponentially with full jitter (default 300). */
  baseDelayMs?: number;
  /** Underlying fetch — injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Sleep — injectable for tests. Defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** RNG for jitter in [0,1) — injectable for deterministic tests. */
  rng?: () => number;
}

/** Is this the OAuth refresh-token grant POST (the only request we retry)? */
function isRefreshGrant(init?: RequestInit): boolean {
  const body = init?.body;
  if (!body) return false;
  if (body instanceof URLSearchParams) {
    return body.get("grant_type") === "refresh_token";
  }
  if (typeof body === "string") {
    return new URLSearchParams(body).get("grant_type") === "refresh_token";
  }
  return false;
}

/**
 * Does a non-OK refresh response represent a transient failure (retry) rather
 * than a permanent credential rejection (give up, let the SDK reauth)?
 *
 * Reads a clone so the original body stays intact for the SDK's own
 * `parseErrorResponse` re-read.
 */
async function isTransientRefreshResponse(res: Response): Promise<boolean> {
  if (res.status >= 500) return true; // gateway / ServerError class
  if (res.status === 429 || res.status === 408) return true;
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // A 4xx may still be transient if it carries a transient OAuth code.
    // Unparseable / unrecognized 4xx → treat as permanent so we never mask a
    // real `invalid_grant`.
    try {
      const data = (await res.clone().json()) as { error?: unknown };
      const code = typeof data?.error === "string" ? data.error : undefined;
      if (!code || PERMANENT_REFRESH_ERRORS.has(code)) return false;
      return TRANSIENT_REFRESH_ERRORS.has(code);
    } catch {
      return false;
    }
  }
  return false;
}

function backoffDelayMs(attempt: number, baseDelayMs: number, rng: () => number): number {
  // attempt is 1-based. Exponential with full jitter, capped — the whole retry
  // budget must stay well under McpSource's remote-connect timeout (15s) so a
  // persistently-down token endpoint still fails fast into the SDK's reauth
  // path instead of hanging the handshake.
  const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), 2_000);
  return Math.floor(exp * (0.5 + rng() * 0.5));
}

/**
 * Build a `fetch` that retries transient OAuth refresh-token failures in place.
 * Pass as the `fetch:` option to a remote OAuth transport.
 */
export function createOAuthRefreshFetch(options: OAuthRefreshFetchOptions = {}): FetchLike {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = options.rng ?? Math.random;

  // The (retrying) refresh POST, run once. A thrown fetch is network-level
  // (connection drop, TLS reset, DNS, abort) — always transient; a transient
  // response (5xx/429/transient OAuth code) is retried within budget. On
  // exhaustion the last response is returned / the last error re-thrown so the
  // SDK sees a real failure and its reauth path can fire.
  const refreshWithRetry = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isLast = attempt >= maxAttempts;
      try {
        const res = await doFetch(url, init);
        if (!isLast && (await isTransientRefreshResponse(res))) {
          const delay = backoffDelayMs(attempt, baseDelayMs, rng);
          log.warn(
            `[oauth] token refresh transient failure (status=${res.status}) — ` +
              `retry ${attempt}/${maxAttempts - 1} in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        return res;
      } catch (err) {
        // A thrown fetch is network-level (connection drop, TLS reset, DNS,
        // abort). Retrying is safe EXCEPT one unavoidable window: if the prior
        // attempt actually reached the server and rotated the refresh token
        // (rotating IdPs), but the response was lost on the wire, the retry
        // re-sends the now-stale token → `invalid_grant` → reauth. That is
        // inherent to retrying a refresh (not idempotent under rotation), and it
        // is strictly NARROWER than the pre-fix behavior where *every* transient
        // blip flipped to reauth — here only the lost-response-after-rotation
        // case does, and the same lost response would reauth without any retry.
        if (isLast) throw err;
        const delay = backoffDelayMs(attempt, baseDelayMs, rng);
        log.warn(
          `[oauth] token refresh network error — retry ${attempt}/${maxAttempts - 1} ` +
            `in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(delay);
      }
    }
    // Unreachable: the final attempt either returns or throws above.
    throw new Error("oauth refresh fetch: retry loop exited without result");
  };

  // Run the refresh once and snapshot the response body into a buffer, so every
  // coalesced caller can be handed an independent, fully-readable `Response`
  // (the SDK's `auth()` reads the body on each caller's own flow). Token
  // responses are small JSON, so buffering is trivial.
  const refreshOnceSnapshot = async (
    url: string | URL,
    init?: RequestInit,
  ): Promise<() => Response> => {
    const res = await refreshWithRetry(url, init);
    const body = await res.arrayBuffer();
    const responseInit: ResponseInit = {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    };
    return () => new Response(body, responseInit);
  };

  // Single-flight scope: this wrapper is created once per transport
  // (`createRemoteTransport`), and one transport speaks for exactly one
  // (workspace, connector) token. So every concurrent refresh POST that reaches
  // it refreshes the SAME credential — one nullable in-flight slot is the
  // correct coalescing scope, no keying needed.
  let inFlight: Promise<() => Response> | null = null;

  return async (url, init) => {
    if (!isRefreshGrant(init)) {
      return doFetch(url, init);
    }
    // Coalesce concurrent refreshes. The engine runs a turn's tool calls in
    // parallel, so on token expiry N calls 401 at once and would otherwise each
    // fire their own refresh POST — an IdP rate-limit storm, and on rotating
    // providers a race where the losers get `invalid_grant` (a spurious dead
    // credential). One upstream attempt serves them all; awaiters get an
    // independent snapshot of its result.
    if (!inFlight) {
      inFlight = refreshOnceSnapshot(url, init).finally(() => {
        inFlight = null;
      });
    }
    const makeResponse = await inFlight;
    return makeResponse();
  };
}
