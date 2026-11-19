/**
 * `rejectUnlistedHost`: which `Host` values a server without sign-in answers.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { rejectUnlistedHost } from "../../../src/api/middleware/host.ts";

const TRUSTED = new Set(["https://nb.example.com", "http://nimblebrain.lan:27246", "not a url"]);

async function status(host: string | undefined): Promise<number> {
  const app = new Hono();
  app.use("*", rejectUnlistedHost(TRUSTED));
  app.get("/v1/bootstrap", (c) => c.json({ ok: true }));
  const headers: Record<string, string> = host === undefined ? {} : { host };
  return (await app.request("http://localhost/v1/bootstrap", { headers })).status;
}

describe("rejectUnlistedHost", () => {
  it("answers loopback names and IP literals, with or without a port", async () => {
    for (const host of [
      "localhost",
      "localhost:80",
      "LOCALHOST:27247",
      "127.0.0.1:27246",
      "[::1]:27247",
      "192.168.1.20:27246",
    ]) {
      expect(await status(host)).toBe(200);
    }
  });

  it("answers the host of a configured origin", async () => {
    expect(await status("nb.example.com")).toBe(200);
    expect(await status("nimblebrain.lan:27246")).toBe(200);
  });

  it("refuses any other hostname", async () => {
    expect(await status("other-site.example:27247")).toBe(403);
    expect(await status("nimblebrain.lan:8080")).toBe(403);
    expect(await status("localhost.other-site.example")).toBe(403);
  });

  it("refuses a Host that is not hostname[:port]", async () => {
    expect(await status("localhost@other-site.example")).toBe(403);
    expect(await status("other-site.example/localhost")).toBe(403);
  });

  it("answers a request with no Host, which no browser sends", async () => {
    expect(await status(undefined)).toBe(200);
  });
});
