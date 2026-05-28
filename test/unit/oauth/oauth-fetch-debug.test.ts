import { describe, expect, it, mock } from "bun:test";
import { wrapFetchForOAuthDebug } from "../../../src/oauth/oauth-fetch-debug.ts";

// The wrapper must be transparent: it logs token-endpoint traffic and passes
// every request through to the underlying fetch unchanged, returning the same
// response. Non-token requests must not be touched.

describe("wrapFetchForOAuthDebug", () => {
  it("passes a token-endpoint request through and returns the original response", async () => {
    const orig = mock(async () => new Response('{"error":"invalid_code"}', { status: 400 }));
    const wrapped = wrapFetchForOAuthDebug(orig as unknown as typeof fetch);

    const res = await wrapped("https://mcp-auth.granola.ai/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: "abc" }),
    });

    expect(orig).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
    // Body still readable by the caller (the wrapper only cloned it to log).
    expect(await res.text()).toBe('{"error":"invalid_code"}');
  });

  it("passes non-token requests through untouched", async () => {
    const orig = mock(async () => new Response("ok", { status: 200 }));
    const wrapped = wrapFetchForOAuthDebug(orig as unknown as typeof fetch);

    const res = await wrapped("https://mcp.granola.ai/mcp", { method: "POST" });

    expect(orig).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("matches token endpoints by path (/token, /oauth2/token) and ignores others", async () => {
    const orig = mock(async () => new Response("{}", { status: 200 }));
    const wrapped = wrapFetchForOAuthDebug(orig as unknown as typeof fetch);
    // All of these must still pass through (the wrapper never blocks); this
    // just exercises the matcher without throwing on odd inputs.
    for (const u of [
      "https://as.example.com/token",
      "https://as.example.com/oauth2/token",
      "https://as.example.com/authorize",
      "not-a-url",
    ]) {
      const res = await wrapped(u, { method: "POST" });
      expect(res.status).toBe(200);
    }
    expect(orig).toHaveBeenCalledTimes(4);
  });
});
