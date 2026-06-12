/**
 * Silent token refresh interceptor.
 *
 * Wraps fetch to intercept 401 responses, attempt a cookie-based token
 * refresh, and retry the original request exactly once. Concurrent 401s
 * are deduplicated — only one refresh call is in-flight at a time.
 *
 * ## Network failure ≠ auth failure
 *
 * A 401 means the access token expired; the cure is a refresh. But the
 * refresh request itself can fail two very different ways, and only ONE of
 * them means the session is over:
 *
 * - **Rejected** — the refresh endpoint responded with a non-OK status (the
 *   server returns 401 when the refresh token is expired/revoked/reused).
 *   The session is genuinely dead → log out.
 * - **Unavailable** — the refresh request never got a response: it threw at
 *   the transport layer (connection dropped, TLS reset, a roaming hand-off
 *   between networks). The session may be perfectly valid — we just couldn't
 *   reach the server this instant → do NOT log out. Surface the original 401
 *   so the caller can retry; the next attempt will refresh cleanly.
 *
 * Collapsing both into "logged out" (the historical `.catch(() => false)`)
 * meant a single dropped refresh POST on a flaky/mobile connection bounced the
 * user to the sign-in screen mid-session even though nothing was wrong with
 * their session. Transport failures are also retried a couple times before we
 * give up, to ride out brief blips without surfacing an error at all.
 */

/** How many times to re-attempt a refresh that failed at the transport layer. */
const REFRESH_NETWORK_RETRIES = 2;
/** Delay between transport-failure retries. */
const REFRESH_RETRY_DELAY_MS = 400;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Outcome of a refresh attempt:
 * - `refreshed`   — server issued a new token; retry the original request.
 * - `rejected`    — server refused the refresh token; the session is dead.
 * - `unavailable` — the request never reached the server (transient transport
 *                   failure); the session is likely still valid.
 */
type RefreshOutcome = "refreshed" | "rejected" | "unavailable";

export interface FetchWithRefreshOptions {
  /** The underlying fetch implementation. */
  fetch: typeof globalThis.fetch;
  /** URL for the refresh endpoint. */
  refreshUrl: string;
  /**
   * Called only when the session is genuinely over — the refresh endpoint
   * rejected the refresh token, or the retry still 401s after a successful
   * refresh. NOT called on a transient transport failure.
   */
  onAuthError?: () => void;
}

export interface FetchWithRefresh {
  /** Fetch with automatic 401 → refresh → retry. */
  (input: string, init?: RequestInit): Promise<Response>;
  /**
   * Attempt a token refresh. Exposed for SSE modules that manage their own
   * fetch. Returns true only on a successful refresh; both a server rejection
   * and a transport failure return false (the SSE caller stops the stream and
   * its own backoff loop reconnects — it never logs out directly).
   */
  tryRefresh(): Promise<boolean>;
}

export function createFetchWithRefresh(options: FetchWithRefreshOptions): FetchWithRefresh {
  const { fetch: fetchFn, refreshUrl, onAuthError } = options;

  let refreshInFlight: Promise<RefreshOutcome> | null = null;

  /** One refresh round-trip. A throw is transport-level (`unavailable`). */
  async function attemptRefresh(): Promise<RefreshOutcome> {
    try {
      const res = await fetchFn(refreshUrl, { method: "POST", credentials: "include" });
      return res.ok ? "refreshed" : "rejected";
    } catch {
      return "unavailable";
    }
  }

  /**
   * Refresh with transport-failure retries, deduplicated across concurrent
   * callers. A `rejected` outcome is definitive and returns immediately; only
   * the `unavailable` (transport) path is retried.
   */
  function refresh(): Promise<RefreshOutcome> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      let outcome = await attemptRefresh();
      for (let i = 0; outcome === "unavailable" && i < REFRESH_NETWORK_RETRIES; i++) {
        await delay(REFRESH_RETRY_DELAY_MS);
        outcome = await attemptRefresh();
      }
      return outcome;
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function tryRefresh(): Promise<boolean> {
    return refresh().then((outcome) => outcome === "refreshed");
  }

  async function fetchWithRefresh(input: string, init?: RequestInit): Promise<Response> {
    const res = await fetchFn(input, init);

    if (res.status !== 401) return res;

    // 401 — attempt silent refresh
    const outcome = await refresh();

    if (outcome === "rejected") {
      // The refresh token was refused — the session is genuinely over.
      onAuthError?.();
      return res;
    }

    if (outcome === "unavailable") {
      // We couldn't reach the refresh endpoint (network blip / roaming). The
      // session may still be valid — do NOT log out. Return the original 401;
      // the caller surfaces a transient error and the next request refreshes.
      return res;
    }

    // Refresh succeeded — retry the original request once.
    const retry = await fetchFn(input, init);
    if (retry.status === 401) {
      // A fresh token still gets 401 → genuinely unauthenticated.
      onAuthError?.();
    }
    return retry;
  }

  fetchWithRefresh.tryRefresh = tryRefresh;
  return fetchWithRefresh;
}
