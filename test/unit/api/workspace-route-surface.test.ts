/**
 * The edges of the workspace-scoped REST surface that are not the `:wsId` gate
 * itself: what CORS lets a browser send, which browser writes reach it, and
 * where the internal connector token may go.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { isInternalTokenPath, validateInternalToken } from "../../../src/api/auth-utils.ts";
import { corsMiddleware } from "../../../src/api/middleware/cors.ts";
import { rejectCrossSiteWrites } from "../../../src/api/middleware/fetch-site.ts";

const ORIGIN = "https://nb.example.com";
const PARTNER = "https://partner.example.com";

describe("CORS", () => {
  function preflight(authConfigured: boolean, allowed: Set<string> | null) {
    const app = new Hono();
    app.use("*", corsMiddleware(authConfigured, allowed));
    return app.request(`${ORIGIN}/v1/workspaces/ws_acme/tools/call`, {
      method: "OPTIONS",
      headers: {
        Origin: PARTNER,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-workspace-id",
      },
    });
  }

  it("does not allow the X-Workspace-Id header, with or without an allowlist", async () => {
    for (const res of [await preflight(false, null), await preflight(true, new Set([PARTNER]))]) {
      const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase());
      expect(allowed).toContain("content-type");
      expect(allowed).not.toContain("x-workspace-id");
    }
  });
});

describe("rejectCrossSiteWrites", () => {
  function makeApp(allowed: Set<string> | null) {
    const app = new Hono();
    app.use("/v1/workspaces/*", rejectCrossSiteWrites(allowed));
    app.all("/v1/workspaces/:wsId/tools/call", (c) => c.json({ ok: true }));
    return app;
  }

  function send(app: Hono, method: string, headers: Record<string, string>) {
    return app.request(`${ORIGIN}/v1/workspaces/ws_acme/tools/call`, { method, headers });
  }

  it("refuses a same-site or cross-site browser write from an origin not allowlisted", async () => {
    const app = makeApp(null);
    for (const site of ["same-site", "cross-site"]) {
      const res = await send(app, "POST", {
        "Sec-Fetch-Site": site,
        Origin: "https://tenant-a.example.com",
        "Content-Type": "text/plain",
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("cross_site_request");
    }
  });

  it("refuses a cross-site write that carries no Origin", async () => {
    const res = await send(makeApp(new Set([PARTNER])), "POST", { "Sec-Fetch-Site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("admits a cross-site write from an allowlisted CORS origin", async () => {
    const res = await send(makeApp(new Set([PARTNER])), "POST", {
      "Sec-Fetch-Site": "cross-site",
      Origin: PARTNER,
    });
    expect(res.status).toBe(200);
  });

  it("admits same-origin, user-initiated, and non-browser writes", async () => {
    const app = makeApp(null);
    for (const headers of [
      { "Sec-Fetch-Site": "same-origin", Origin: ORIGIN },
      { "Sec-Fetch-Site": "none" },
      {},
    ]) {
      expect((await send(app, "POST", headers)).status).toBe(200);
    }
  });

  it("leaves reads alone", async () => {
    const res = await send(makeApp(null), "GET", {
      "Sec-Fetch-Site": "cross-site",
      Origin: "https://tenant-a.example.com",
    });
    expect(res.status).toBe(200);
  });
});

describe("internal token paths", () => {
  it("reaches a workspace's chat and chat stream, and nothing else", () => {
    expect(isInternalTokenPath("/v1/workspaces/ws_acme/chat")).toBe(true);
    expect(isInternalTokenPath("/v1/workspaces/ws_acme/chat/stream")).toBe(true);
    for (const path of [
      "/v1/chat",
      "/v1/chat/stream",
      "/v1/workspaces/ws_acme/chat/start",
      "/v1/workspaces/ws_acme/tools/call",
      "/v1/workspaces/ws_acme/chat/stream/x",
      "/v1/workspaces/ws_acme/x/chat",
      "/v1/workspaces//chat",
      "/v1/events",
    ]) {
      expect(isInternalTokenPath(path)).toBe(false);
    }
  });

  it("is POST only", () => {
    const token = "internal-token";
    expect(validateInternalToken(token, token, "/v1/workspaces/ws_acme/chat", "POST")).toBeNull();
    expect(validateInternalToken(token, token, "/v1/workspaces/ws_acme/chat", "GET")?.status).toBe(
      403,
    );
  });
});
