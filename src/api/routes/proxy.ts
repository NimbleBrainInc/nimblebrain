import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/**
 * HTTP proxy routes for bundles that declare
 * `_meta["ai.nimblebrain/http-proxy"]` in their manifest. Forwards same-origin
 * browser requests from `/v1/apps/<bundle>/<mount>/*` to the bundle's local
 * HTTP server (typically on 127.0.0.1:<port>).
 *
 * Opt-in per bundle (manifest) and per workspace (`allowHttpProxy`).
 *
 * Scope (v1): HTTP methods. WebSocket upgrade is a follow-up — see
 * HttpProxyConfig.websocket for the declaration; upgrade handling will be
 * added once Bun/Hono integration is wired through this route.
 */
export function proxyRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("/v1/apps/*", requireAuth(ctx.authOptions))
    .use("/v1/apps/*", requireWorkspace(ctx.workspaceStore))
    .use("/v1/apps/*", errorLog(ctx))
    .all("/v1/apps/:bundle/:mount/*", async (c) => {
      const bundleName = decodeURIComponent(c.req.param("bundle") ?? "");
      const mount = c.req.param("mount") ?? "";
      const wsId = c.var.workspaceId;

      // Workspace-level kill switch.
      const ws = await ctx.workspaceStore.get(wsId);
      if (ws?.allowHttpProxy === false) {
        return apiError(403, "proxy_disabled", "HTTP proxy routes are disabled for this workspace");
      }

      const instance = ctx.runtime.getLifecycle().getInstance(bundleName, wsId);
      if (!instance) {
        return apiError(404, "not_found", `App "${bundleName}" not found`);
      }

      const cfg = instance.httpProxy;
      if (!cfg || cfg.mount !== mount) {
        return apiError(
          404,
          "not_found",
          `App "${bundleName}" does not expose proxy mount "${mount}"`,
        );
      }

      // Forward the FULL incoming path to the target. The bundle is expected
      // to configure its upstream server (e.g., `astro --base`) to match the
      // public prefix so absolute URLs in responses line up. This avoids
      // response-body rewriting.
      const url = new URL(c.req.url);
      const target = new URL(cfg.target);
      const targetUrl = new URL(target.toString().replace(/\/$/, "") + url.pathname + url.search);

      // Copy safe headers; strip hop-by-hop + Host (fetch sets its own).
      const forwardHeaders = new Headers();
      for (const [k, v] of c.req.raw.headers) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (lk === "host") continue;
        forwardHeaders.set(k, v);
      }
      forwardHeaders.set("X-Forwarded-Host", url.host);
      forwardHeaders.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
      forwardHeaders.set("X-Forwarded-For", forwardHeaders.get("X-Forwarded-For") ?? "");

      // Forward the request. Bun's fetch streams both directions.
      let upstream: Response;
      try {
        upstream = await fetch(targetUrl.toString(), {
          method: c.req.method,
          headers: forwardHeaders,
          body: REQUEST_HAS_BODY.has(c.req.method) ? c.req.raw.body : undefined,
          redirect: "manual",
          duplex: "half",
        } as RequestInit);
      } catch (err) {
        console.error(
          `[proxy] upstream ${cfg.target} unreachable:`,
          err instanceof Error ? err.message : err,
        );
        return apiError(502, "bad_gateway", `Upstream ${cfg.target} unreachable`);
      }

      // Pipe response back, stripping hop-by-hop headers.
      const outHeaders = new Headers();
      for (const [k, v] of upstream.headers) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        outHeaders.set(k, v);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    });
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REQUEST_HAS_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);
