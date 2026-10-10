/**
 * `rejectUntrustedOrigin`: the DNS-rebinding guard on `/mcp/<wsId>`.
 *
 * A rebinding page sends `Origin` and `Host` naming the attacker's hostname,
 * so trusting a request's own origin is safe only on a host no one can rebind.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { rejectUntrustedOrigin } from "../../../src/api/middleware/origin.ts";

const TRUSTED = new Set(["https://nb.example.com", "https://partner.example.com"]);

function makeApp(): Hono {
  const app = new Hono();
  app.post("/mcp/ws", rejectUntrustedOrigin(TRUSTED), (c) => c.json({ ok: true }));
  return app;
}

async function status(headers: Record<string, string>, url = "http://localhost:27247/mcp/ws") {
  const res = await makeApp().request(url, { method: "POST", headers });
  return res.status;
}

describe("rejectUntrustedOrigin", () => {
  it("passes a request without Origin, as every non-browser client sends", async () => {
    expect(await status({ host: "nb.example.com" })).toBe(200);
  });

  it("passes a configured origin, whatever Host says", async () => {
    expect(await status({ origin: "https://nb.example.com", host: "runtime:27247" })).toBe(200);
    expect(await status({ origin: "https://partner.example.com", host: "nb.example.com" })).toBe(
      200,
    );
  });

  it("refuses a rebinding request: Origin and Host name the attacker's hostname", async () => {
    expect(await status({ origin: "http://evil.example.com", host: "evil.example.com" })).toBe(403);
    expect(
      await status({ origin: "http://evil.example.com:27247", host: "evil.example.com:27247" }),
    ).toBe(403);
  });

  it("passes a request to this server's own loopback or IP address", async () => {
    expect(await status({ origin: "http://localhost:27246", host: "localhost:27246" })).toBe(200);
    expect(await status({ origin: "http://127.0.0.1:27246", host: "127.0.0.1:27246" })).toBe(200);
    expect(await status({ origin: "http://[::1]:27246", host: "[::1]:27246" })).toBe(200);
    expect(await status({ origin: "http://192.168.1.5:27246", host: "192.168.1.5:27246" })).toBe(
      200,
    );
  });

  it("refuses a loopback origin that is not the address the request was sent to", async () => {
    expect(await status({ origin: "http://localhost:3000", host: "localhost:27246" })).toBe(403);
    expect(await status({ origin: "http://localhost:27246", host: "evil.example.com" })).toBe(403);
  });

  it("refuses an opaque or malformed origin", async () => {
    expect(await status({ origin: "null", host: "localhost:27246" })).toBe(403);
    expect(await status({ origin: "not a url", host: "localhost:27246" })).toBe(403);
    expect(await status({ origin: "http://localhost:27246/path", host: "localhost:27246" })).toBe(
      403,
    );
  });

  it("answers the refusal as an API error naming the cause", async () => {
    const res = await makeApp().request("http://localhost:27247/mcp/ws", {
      method: "POST",
      headers: { origin: "http://evil.example.com", host: "evil.example.com" },
    });
    expect(await res.json()).toEqual({
      error: "untrusted_origin",
      message: "Request origin is not trusted",
    });
  });
});
