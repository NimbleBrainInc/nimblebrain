import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { verifyTurnstileToken, isTurnstileEnabled, resetTurnstileState } from "../../../src/api/turnstile.ts";

describe("verifyTurnstileToken", () => {
  const originalFetch = globalThis.fetch;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.TURNSTILE_SECRET_KEY;
    resetTurnstileState();
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.TURNSTILE_SECRET_KEY;
    consoleErrorSpy.mockRestore();
  });

  test("returns null when TURNSTILE_SECRET_KEY is unset", async () => {
    const result = await verifyTurnstileToken("some-token");
    expect(result).toBeNull();
  });

  test("returns null when TURNSTILE_SECRET_KEY is unset even without token", async () => {
    const result = await verifyTurnstileToken(undefined);
    expect(result).toBeNull();
  });

  test("returns error when secret is set but token is undefined", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const result = await verifyTurnstileToken(undefined);
    expect(result).toBe("Turnstile token is required");
  });

  test("returns error when secret is set but token is empty string", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const result = await verifyTurnstileToken("");
    expect(result).toBe("Turnstile token is required");
  });

  test("returns null on successful verification", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, "error-codes": [] }), { status: 200 })),
    );

    const result = await verifyTurnstileToken("valid-token");
    expect(result).toBeNull();
  });

  test("sends correct payload to siteverify", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    let capturedBody: string | undefined;
    globalThis.fetch = mock((url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve(new Response(JSON.stringify({ success: true, "error-codes": [] }), { status: 200 }));
    });

    await verifyTurnstileToken("my-token", "1.2.3.4");

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.secret).toBe("test-secret");
    expect(parsed.response).toBe("my-token");
    expect(parsed.remoteip).toBe("1.2.3.4");
  });

  test("omits remoteip when not provided", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    let capturedBody: string | undefined;
    globalThis.fetch = mock((_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve(new Response(JSON.stringify({ success: true, "error-codes": [] }), { status: 200 }));
    });

    await verifyTurnstileToken("my-token");

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.remoteip).toBeUndefined();
  });

  test("returns specific message for timeout-or-duplicate", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }),
          { status: 200 },
        ),
      ),
    );

    const result = await verifyTurnstileToken("expired-token");
    expect(result).toBe("Turnstile token expired or already used. Please try again.");
  });

  test("returns generic failure for other error codes", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200 },
        ),
      ),
    );

    const result = await verifyTurnstileToken("bad-token");
    expect(result).toBe("Turnstile verification failed");
  });

  test("fails open on HTTP error from Cloudflare", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );

    const result = await verifyTurnstileToken("some-token");
    expect(result).toBeNull();
  });

  test("fails open on network/fetch error", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() => Promise.reject(new Error("network failure")));

    const result = await verifyTurnstileToken("some-token");
    expect(result).toBeNull();
  });

  test("fails closed after 3 consecutive HTTP errors", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );

    // First 3 failures should fail open (return null)
    expect(await verifyTurnstileToken("token-1")).toBeNull();
    expect(await verifyTurnstileToken("token-2")).toBeNull();
    expect(await verifyTurnstileToken("token-3")).toBeNull();

    // 4th request should fail closed
    const result = await verifyTurnstileToken("token-4");
    expect(result).toBe("Bot verification temporarily unavailable. Please try again later.");
  });

  test("resets failure counter on successful verification", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";

    // 2 failures
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );
    await verifyTurnstileToken("token-1");
    await verifyTurnstileToken("token-2");

    // 1 success resets the counter
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, "error-codes": [] }), { status: 200 })),
    );
    await verifyTurnstileToken("token-3");

    // Another failure — should still be open (counter was reset)
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );
    const result = await verifyTurnstileToken("token-4");
    expect(result).toBeNull();
  });

  test("resets failure counter on token rejection (not API error)", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";

    // 2 failures
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );
    await verifyTurnstileToken("token-1");
    await verifyTurnstileToken("token-2");

    // Token rejection (API is working, just rejected the token) resets counter
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200 },
        ),
      ),
    );
    await verifyTurnstileToken("token-3");

    // Another failure — should still be open (counter was reset)
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );
    const result = await verifyTurnstileToken("token-4");
    expect(result).toBeNull();
  });

  test("fail-closed message is descriptive", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );

    // Exhaust the 3 failures
    await verifyTurnstileToken("t1");
    await verifyTurnstileToken("t2");
    await verifyTurnstileToken("t3");

    const result = await verifyTurnstileToken("t4");
    expect(result).toBe("Bot verification temporarily unavailable. Please try again later.");
  });

  test("logs error on failed verification", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200 },
        ),
      ),
    );

    await verifyTurnstileToken("bad-token");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[nimblebrain] Turnstile verification failed: invalid-input-response",
    );
  });
});

describe("isTurnstileEnabled", () => {
  beforeEach(() => {
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  afterEach(() => {
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  test("returns false when TURNSTILE_SECRET_KEY is unset", () => {
    expect(isTurnstileEnabled()).toBe(false);
  });

  test("returns true when TURNSTILE_SECRET_KEY is set", () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    expect(isTurnstileEnabled()).toBe(true);
  });
});
