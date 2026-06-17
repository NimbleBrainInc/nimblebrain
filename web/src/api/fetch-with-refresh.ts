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
 * refresh request itself can fail several ways, and only ONE of them means
 * the session is over:
 *
 * - **Rejected** — the refresh endpoint returned one of its definitive-failure
 *   codes: **401** (`refresh_failed` / `no_refresh_token` — token expired/
 *   revoked/reused) or **400** (`not_configured` — this deployment can't
 *   refresh). The session is genuinely dead → log out and re-auth.
 * - **Unavailable** — anything else: the request threw at the transport layer
 *   (connection dropped, TLS reset, a roaming hand-off between networks), OR it
 *   reached the server but came back with a non-definitive status — a 5xx/429
 *   from the ingress during a rolling deploy, a 408 timeout, a proxy/captive-
 *   portal interstitial, a WAF 403. None of those mean the session is dead; we
 *   just couldn't refresh this instant → do NOT log out. Surface the original
 *   401 so the caller can retry; the next attempt will refresh cleanly.
 *
 * Collapsing all of these into "logged out" (the historical `.catch(() => false)`,
 * and then a naive `res.ok ? … : rejected`) bounced users to the sign-in screen
 * mid-session over a single dropped or 5xx'd refresh POST — exactly the
 * mobile/proxy/deploy conditions this module exists to survive. Unavailable
 * outcomes are also retried a couple times before we give up, to ride out brief
 * blips without surfacing an error at all.
 */

/** How many times to re-attempt a refresh that failed at the transport layer. */
const REFRESH_NETWORK_RETRIES = 2;
/** Delay between transport-failure retries. */
const REFRESH_RETRY_DELAY_MS = 400;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Outcome of a refresh attempt:
 * - `refreshed`   — server issued a new token; retry the original request.
 * - `rejected`    — server returned 400/401 (its definitive-failure codes):
 *                   the session is dead → log out.
 * - `unavailable` — transient: a thrown fetch OR any other server response
 *                   (5xx/429/408/403/…); the session is likely still valid.
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
  /**
   * Telemetry hook fired with each refresh outcome (`refreshed` / `rejected` /
   * `unavailable`). Injected so this module stays decoupled from the Sentry
   * singleton; the client wires it to a breadcrumb. Optional — defaults to no-op.
   */
  onRefreshOutcome?: (outcome: RefreshOutcome) => void;
  /**
   * Telemetry hook fired on the two terminal involuntary-logout exits, with a
   * reason (`refresh_rejected` / `retry_401`). Injected for the same reason as
   * `onRefreshOutcome`. Optional — defaults to no-op.
   */
  onLogout?: (reason: "refresh_rejected" | "retry_401") => void;
}

export interface FetchWithRefresh {
  /** Fetch with automatic 401 → refresh → retry. */
  (input: string, init?: RequestInit): Promise<Response>;
  /**
   * Attempt a token refresh. Exposed for SSE modules that manage their own
   * fetch. Returns true only on a successful refresh; both a server rejection
   * and a transient failure return false, on which the SSE caller stops the
   * stream and surfaces an error — it never logs out directly.
   */
  tryRefresh(): Promise<boolean>;
}

export function createFetchWithRefresh(options: FetchWithRefreshOptions): FetchWithRefresh {
  const { fetch: fetchFn, refreshUrl, onAuthError, onRefreshOutcome, onLogout } = options;

  let refreshInFlight: Promise<RefreshOutcome> | null = null;

  /** One refresh round-trip. A throw is transport-level (`unavailable`). */
  async function attemptRefresh(): Promise<RefreshOutcome> {
    try {
      const res = await fetchFn(refreshUrl, { method: "POST", credentials: "include" });
      if (res.ok) return "refreshed";
      // Allowlist of our refresh endpoint's *definitive-failure* codes — the
      // only statuses `handleOidcRefresh` returns when the session genuinely
      // can't be refreshed: 401 (`refresh_failed` / `no_refresh_token` — token
      // expired/revoked/reused) and 400 (`not_configured` — this deployment's
      // provider can't refresh at all). Both mean "stop retrying, re-auth":
      // log out cleanly rather than loop. If the endpoint ever grows a new
      // definitive code, add it here.
      //
      // Anything else that comes back is NOT our refresh logic saying "no" —
      // it's transient or infrastructural: a 5xx/429 from the ingress during a
      // rolling deploy, a 408 timeout, a WAF 403, a proxy interstitial. Those
      // join the thrown-fetch path as `unavailable` (retry, keep the session).
      // Treating them as dead would log valid users out — the exact spurious
      // logout this module exists to prevent.
      if (res.status === 400 || res.status === 401) return "rejected";
      return "unavailable";
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
    // Report every outcome (not an event) so the trail preceding a logout is
    // visible without quota burn — transient blips vs. a genuine rejection.
    onRefreshOutcome?.(outcome);

    if (outcome === "rejected") {
      // The refresh token was refused — the session is genuinely over. Signal the
      // involuntary logout (the client emits a single event for the incident).
      onLogout?.("refresh_rejected");
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
      onLogout?.("retry_401");
      onAuthError?.();
    }
    return retry;
  }

  fetchWithRefresh.tryRefresh = tryRefresh;
  return fetchWithRefresh;
}
