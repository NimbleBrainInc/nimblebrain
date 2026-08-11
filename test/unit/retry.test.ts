import { describe, expect, it, spyOn } from "bun:test";
import { isRetryable, withRetry } from "../../src/engine/retry.ts";
import { ModelStreamStallError } from "../../src/model/stream.ts";

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

describe("isRetryable — retryable marker", () => {
  it("returns true for an error flagged retryable === true", () => {
    expect(isRetryable({ retryable: true })).toBe(true);
    expect(isRetryable(Object.assign(new Error("stalled"), { retryable: true }))).toBe(true);
  });

  it("returns false for retryable:false or a non-true marker", () => {
    expect(isRetryable({ retryable: false })).toBe(false);
    expect(isRetryable({ retryable: "yes" })).toBe(false);
  });
});

describe("withRetry — retryable marker", () => {
  it("retries an error flagged retryable and then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error("stalled"), { retryable: true });
        return "recovered";
      },
      3,
      0,
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });
});

describe("withRetry logging", () => {
  /** Capture the logger's output channel (log.warn writes to console.error). */
  function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("logs nothing when the call succeeds on the first attempt", async () => {
    const { lines, restore } = captureWarnings();
    try {
      await withRetry(async () => "ok", 3, 0);
    } finally {
      restore();
    }
    expect(lines.filter((l) => l.includes("[engine] retry"))).toHaveLength(0);
  });

  it("logs one line per retried attempt, with attempt, reason and backoff", async () => {
    const { lines, restore } = captureWarnings();
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 3) throw httpError(429);
          return "recovered";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    // Two failures before the third attempt succeeded.
    expect(retries).toHaveLength(2);
    expect(retries[0]).toContain("attempt=1/3");
    expect(retries[0]).toContain("reason=429");
    expect(retries[0]).toMatch(/delayMs=\d+/);
    expect(retries[1]).toContain("attempt=2/3");
  });

  // Uses the real ModelStreamStallError, not a local stand-in. A stand-in has to
  // restate the name this asserts, which makes the assertion vacuous: drop
  // `this.name` from the real class and production logs `reason=Error` while the
  // test stays green. This is the one case where `reason` is not a status, so it
  // is the case the test has to actually bind to.
  it("names the error when the retryable error carries no HTTP status", async () => {
    const { lines, restore } = captureWarnings();
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 2) throw new ModelStreamStallError(1000, { retryable: true });
          return "ok";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("reason=ModelStreamStallError");
  });

  // The `retryable` branch of isRetryable never inspects `status`, and getStatus
  // is an unchecked cast — so an error can be retryable AND carry a `status` of
  // any shape. `reason` must fall back to the name rather than interpolate it.
  it("ignores a non-retryable status on an error flagged retryable", async () => {
    const { lines, restore } = captureWarnings();
    const err = new ModelStreamStallError(1000, { retryable: true }) as Error & {
      status?: unknown;
    };
    err.status = "sk-should-never-be-logged";
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 2) throw err;
          return "ok";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("reason=ModelStreamStallError");
    expect(retries[0]).not.toContain("sk-should-never-be-logged");
  });

  it("does not log the provider's error message", async () => {
    const { lines, restore } = captureWarnings();
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 2) throw httpError(529, "sk-secret-looking-payload");
          return "ok";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).not.toContain("sk-secret-looking-payload");
  });

  it("logs every attempt when retries are exhausted", async () => {
    const { lines, restore } = captureWarnings();
    try {
      await withRetry(
        async () => {
          throw httpError(429);
        },
        3,
        0,
      ).catch(() => {});
    } finally {
      restore();
    }
    // 3 retries logged; the 4th (terminal) failure rethrows without a retry line.
    expect(lines.filter((l) => l.includes("[engine] retry"))).toHaveLength(3);
  });
});
