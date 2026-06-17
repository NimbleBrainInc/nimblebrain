// ---------------------------------------------------------------------------
// createFetchWithRefresh — telemetry wiring for the involuntary-logout signal.
//
// The whole point of this PR is to make "random logouts" observable. The auth
// telemetry is injected as hooks (onRefreshOutcome / onLogout), so these tests
// assert the exact wiring — one logout signal on each terminal exit, none on the
// happy path — locking the behavior the feature exists to deliver.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import { createFetchWithRefresh } from "../src/api/fetch-with-refresh";

const REFRESH = "/v1/auth/refresh";

/** Fake fetch: refresh URL returns `refreshStatus`; the original request walks
 *  `reqStatuses` (first call, then the post-refresh retry). */
function makeFetch(reqStatuses: number[], refreshStatus: number) {
  let i = 0;
  const fn = mock((input: string) => {
    if (input === REFRESH) return Promise.resolve(new Response(null, { status: refreshStatus }));
    const status = reqStatuses[Math.min(i, reqStatuses.length - 1)] ?? 200;
    i++;
    return Promise.resolve(new Response(null, { status }));
  });
  return fn as unknown as typeof globalThis.fetch;
}

describe("createFetchWithRefresh telemetry", () => {
  test("rejected refresh → onLogout('refresh_rejected') once + onAuthError", async () => {
    const onLogout = mock(() => {});
    const onAuthError = mock(() => {});
    const onRefreshOutcome = mock(() => {});
    const f = createFetchWithRefresh({
      fetch: makeFetch([401], 401),
      refreshUrl: REFRESH,
      onAuthError,
      onLogout,
      onRefreshOutcome,
    });
    const res = await f("/v1/x");
    expect(res.status).toBe(401);
    expect(onRefreshOutcome).toHaveBeenCalledWith("rejected");
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledWith("refresh_rejected");
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  test("refresh ok + retry ok → no logout", async () => {
    const onLogout = mock(() => {});
    const onAuthError = mock(() => {});
    const onRefreshOutcome = mock(() => {});
    const f = createFetchWithRefresh({
      fetch: makeFetch([401, 200], 200),
      refreshUrl: REFRESH,
      onAuthError,
      onLogout,
      onRefreshOutcome,
    });
    const res = await f("/v1/x");
    expect(res.status).toBe(200);
    expect(onRefreshOutcome).toHaveBeenCalledWith("refreshed");
    expect(onLogout).not.toHaveBeenCalled();
    expect(onAuthError).not.toHaveBeenCalled();
  });

  test("refresh ok but retry still 401 → onLogout('retry_401')", async () => {
    const onLogout = mock(() => {});
    const onAuthError = mock(() => {});
    const f = createFetchWithRefresh({
      fetch: makeFetch([401, 401], 200),
      refreshUrl: REFRESH,
      onAuthError,
      onLogout,
    });
    await f("/v1/x");
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledWith("retry_401");
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  test("non-401 response: no refresh, no telemetry", async () => {
    const onLogout = mock(() => {});
    const onRefreshOutcome = mock(() => {});
    const f = createFetchWithRefresh({
      fetch: makeFetch([200], 200),
      refreshUrl: REFRESH,
      onLogout,
      onRefreshOutcome,
    });
    const res = await f("/v1/x");
    expect(res.status).toBe(200);
    expect(onRefreshOutcome).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });
});
