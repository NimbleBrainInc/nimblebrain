/**
 * Silent token refresh interceptor.
 *
 * Wraps fetch to intercept 401 responses, attempt a cookie-based token
 * refresh, and retry the original request exactly once. Concurrent 401s
 * are deduplicated — only one refresh call is in-flight at a time.
 */

export interface FetchWithRefreshOptions {
  /** The underlying fetch implementation. */
  fetch: typeof globalThis.fetch;
  /** URL for the refresh endpoint. */
  refreshUrl: string;
  /** Called when refresh fails or the retry still returns 401. */
  onAuthError?: () => void;
}

export interface FetchWithRefresh {
  /** Fetch with automatic 401 → refresh → retry. */
  (input: string, init?: RequestInit): Promise<Response>;
  /** Attempt a token refresh. Exposed for SSE modules that manage their own fetch. */
  tryRefresh(): Promise<boolean>;
}

export function createFetchWithRefresh(options: FetchWithRefreshOptions): FetchWithRefresh {
  const { fetch: fetchFn, refreshUrl, onAuthError } = options;

  let refreshInFlight: Promise<boolean> | null = null;

  function tryRefresh(): Promise<boolean> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = fetchFn(refreshUrl, {
      method: "POST",
      credentials: "include",
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  }

  async function fetchWithRefresh(input: string, init?: RequestInit): Promise<Response> {
    const res = await fetchFn(input, init);

    if (res.status !== 401) return res;

    // 401 — attempt silent refresh
    const refreshed = await tryRefresh();
    if (!refreshed) {
      onAuthError?.();
      return res;
    }

    // Refresh succeeded — retry the original request once
    const retry = await fetchFn(input, init);
    if (retry.status === 401) {
      onAuthError?.();
    }
    return retry;
  }

  fetchWithRefresh.tryRefresh = tryRefresh;
  return fetchWithRefresh;
}
