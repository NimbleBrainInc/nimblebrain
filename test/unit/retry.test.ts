import { describe, expect, it } from "bun:test";
import { isRetryable, withRetry } from "../../src/engine/retry.ts";

/** Helper: create an error with an HTTP status code. */
function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("isRetryable", () => {
  it("returns true for 429", () => {
    expect(isRetryable(httpError(429))).toBe(true);
  });

  it("returns true for 529", () => {
    expect(isRetryable(httpError(529))).toBe(true);
  });

  it("returns false for 401", () => {
    expect(isRetryable(httpError(401))).toBe(false);
  });

  it("returns false for 500", () => {
    expect(isRetryable(httpError(500))).toBe(false);
  });

  it("returns false for plain Error (no status)", () => {
    expect(isRetryable(new Error("network timeout"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on success (no retry)", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on 429 and succeeds on 3rd attempt", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw httpError(429);
        return "recovered";
      },
      3,
      0, // zero base delay for fast tests
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("retries on 429 and throws after all retries exhausted", async () => {
    let calls = 0;
    const original = httpError(429, "rate limited");
    await expect(
      withRetry(
        async () => {
          calls++;
          throw original;
        },
        3,
        0,
      ),
    ).rejects.toThrow(original);
    // 1 initial + 3 retries = 4 calls
    expect(calls).toBe(4);
  });

  it("retries on 529 (same as 429)", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw httpError(529);
        return "ok";
      },
      3,
      0,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("fails immediately on 401 with clear message", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw httpError(401);
        },
        3,
        0,
      ),
    ).rejects.toThrow("Authentication failed (401)");
    expect(calls).toBe(1);
  });

  it("fails immediately on non-HTTP error (no retry)", async () => {
    let calls = 0;
    const err = new Error("ECONNRESET");
    await expect(
      withRetry(
        async () => {
          calls++;
          throw err;
        },
        3,
        0,
      ),
    ).rejects.toThrow(err);
    expect(calls).toBe(1);
  });

  it("interrupts backoff when signal aborts mid-sleep", async () => {
    // Pre-existing gap closed: if the signal aborted during the
    // backoff window, the engine had to wait the full delay (up to
    // ~8.5s on attempt 3) before the next retry attempt observed
    // the abort. Now the sleep is abort-aware — cancellation bites
    // within the abort tick.
    const controller = new AbortController();
    let calls = 0;
    const err = { status: 429 };
    const start = Date.now();

    const runPromise = withRetry(
      async () => {
        calls++;
        throw err;
      },
      3,
      // 5-second base delay — without the abort, attempt 1's
      // backoff alone would block this test for 5s+.
      5_000,
      controller.signal,
    );

    // Let attempt 1 fail and the backoff timer arm.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    await expect(runPromise).rejects.toMatchObject({ name: "AbortError" });

    const elapsed = Date.now() - start;
    // Way under the 5-second backoff that would have held us
    // without the abort. A generous ceiling that still catches
    // any regression to "wait the full delay first".
    expect(elapsed).toBeLessThan(500);
    // Exactly one attempt fired before the abort interrupted backoff.
    expect(calls).toBe(1);
  });

  it("rejects synchronously when called with a pre-aborted signal during backoff", async () => {
    // Symmetric coverage: a signal that's already aborted when the
    // backoff sleep starts must reject immediately, not arm a timer
    // it then has to clean up. Matters for the engine's iteration
    // path where the abort may have fired during the prior attempt.
    const controller = new AbortController();
    let calls = 0;
    const err = { status: 429 };

    const fn = async () => {
      calls++;
      // Abort BEFORE we throw — backoff observes a pre-aborted
      // signal when it tries to sleep.
      if (calls === 1) controller.abort();
      throw err;
    };

    const start = Date.now();
    await expect(withRetry(fn, 3, 5_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - start).toBeLessThan(100);
    expect(calls).toBe(1);
  });
});
