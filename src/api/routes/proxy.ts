import { Hono } from "hono";
import { log } from "../../cli/log.ts";
import { WORKSPACE_ID_RE } from "../auth-middleware.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/**
 * HTTP proxy routes for bundles that declare
 * `_meta["ai.nimblebrain/http-proxy"]` in their manifest. Forwards same-origin
 * browser requests from `/v1/ws/<wsId>/apps/<bundle>/<mount>/*` to the
 * bundle's local HTTP server (typically on 127.0.0.1:<port>).
 *
 * The workspace ID is in the URL (not a header) because this route is
 * targeted by the BROWSER's iframe loads — those can't set custom headers
 * the way the platform's REST helpers do. Membership is enforced in the
 * handler against the authenticated identity.
 *
 * Opt-in per bundle (manifest) and per workspace (`allowHttpProxy`).
 *
 * ─── Trust model (read this before installing any http-proxy bundle) ───
 *
 * A bundle declaring `http-proxy` runs as **same-origin code in the
 * authenticated user's session**. The iframe loaded from this proxy is
 * sandboxed `allow-scripts allow-same-origin`, which means the bundle's
 * preview JS can read cookies for the platform origin, call same-origin
 * REST APIs authenticated as the user, and read top-frame DOM where the
 * host UI permits it. Treat http-proxy bundles like browser extensions:
 * the operator vouches for the code.
 *
 * Defenses we DO enforce:
 *   1. `target` restricted to loopback hosts in `extractHttpProxy` (no
 *      SSRF to cloud metadata, RFC1918 networks, or external hosts).
 *   2. `Authorization`, `Cookie`, `X-Workspace-Id` stripped before
 *      forwarding — bundle's loopback server can't read user credentials.
 *   3. `Set-Cookie` stripped from upstream — bundle can't plant cookies
 *      on the platform's origin.
 *   4. Workspace membership verified per-request before forwarding.
 *   5. `Workspace.allowHttpProxy = false` is the per-workspace kill switch.
 *
 * Defenses we do NOT have today: cross-origin isolation per bundle (would
 * require subdomain-per-bundle + COEP). For untrusted-bundle marketplaces,
 * that's the next investment.
 *
 * Scope (v1): HTTP methods only. WebSocket upgrade declared in
 * HttpProxyConfig.websocket but not yet wired through the route.
 */
export function proxyRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("/v1/ws/*", requireAuth(ctx.authOptions))
    .use("/v1/ws/*", errorLog(ctx))
    .all("/v1/ws/:wsId/apps/:bundle/:mount/*", async (c) => {
      const wsId = decodeURIComponent(c.req.param("wsId") ?? "");
      const bundleName = decodeURIComponent(c.req.param("bundle") ?? "");
      const mount = c.req.param("mount") ?? "";
      const method = c.req.method;
      const requestPath = new URL(c.req.url).pathname;

      // Validate workspace ID format (prevents path traversal).
      if (!WORKSPACE_ID_RE.test(wsId)) {
        log.info(`[proxy] ${method} ${requestPath} → 400 (invalid wsId)`);
        return apiError(400, "workspace_error", "Invalid workspace ID format.");
      }

      const ws = await ctx.workspaceStore.get(wsId);
      if (!ws) {
        log.info(`[proxy] ${method} ${requestPath} → 400 (workspace not found)`);
        return apiError(400, "workspace_error", `Workspace "${wsId}" not found.`);
      }
      const identity = c.var.identity;
      if (identity) {
        const isMember = ws.members.some((m) => m.userId === identity.id);
        if (!isMember) {
          log.info(`[proxy] ${method} ${requestPath} → 403 (not a member of ${wsId})`);
          return apiError(
            403,
            "workspace_error",
            `Access denied: not a member of workspace "${wsId}".`,
          );
        }
      }
      c.set("workspaceId", wsId);

      if (ws.allowHttpProxy === false) {
        log.info(`[proxy] ${method} ${requestPath} → 403 (workspace ${wsId} disabled)`);
        return apiError(403, "proxy_disabled", "HTTP proxy routes are disabled for this workspace");
      }

      const instance = ctx.runtime.getLifecycle().getInstance(bundleName, wsId);
      if (!instance) {
        log.info(`[proxy] ${method} ${requestPath} → 404 (no instance "${bundleName}" in ${wsId})`);
        return apiError(404, "not_found", `App "${bundleName}" not found`);
      }

      const cfg = instance.httpProxy;
      if (!cfg || cfg.mount !== mount) {
        log.info(
          `[proxy] ${method} ${requestPath} → 404 (mount "${mount}" not declared by ${bundleName})`,
        );
        return apiError(
          404,
          "not_found",
          `App "${bundleName}" does not expose proxy mount "${mount}"`,
        );
      }

      // Forward the FULL incoming path to the target. Bundle is expected to
      // configure its upstream server (e.g., `astro --base`) to match the
      // public prefix so absolute URLs in responses line up.
      const url = new URL(c.req.url);
      const target = new URL(cfg.target);
      const targetUrl = new URL(target.toString().replace(/\/$/, "") + url.pathname + url.search);

      const forwardHeaders = new Headers();
      for (const [k, v] of c.req.raw.headers) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (REQUEST_HEADERS_STRIPPED.has(lk)) continue;
        forwardHeaders.set(k, v);
      }
      forwardHeaders.set("X-Forwarded-Host", url.host);
      forwardHeaders.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
      forwardHeaders.set("X-Forwarded-For", forwardHeaders.get("X-Forwarded-For") ?? "");

      // `duplex: "half"` is only valid (per WHATWG fetch) when the body is a
      // stream — passing it for bodyless GET/HEAD can produce a 400 in Bun.
      const hasBody = REQUEST_HAS_BODY.has(method);
      const init: RequestInit = {
        method,
        headers: forwardHeaders,
        redirect: "manual",
      };
      if (hasBody) {
        init.body = c.req.raw.body;
        (init as RequestInit & { duplex?: "half" }).duplex = "half";
      }

      log.info(`[proxy] ${method} ${requestPath} → ${targetUrl.toString()}`);

      let upstream: Response;
      try {
        upstream = await fetch(targetUrl.toString(), init);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[proxy] ${method} ${requestPath} fetch failed: ${msg}`);
        return apiError(502, "bad_gateway", `Upstream ${cfg.target} unreachable`);
      }
      log.info(`[proxy] ${method} ${requestPath} ← ${upstream.status} from ${cfg.target}`);

      const outHeaders = new Headers();
      for (const [k, v] of upstream.headers) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (RESPONSE_HEADERS_STRIPPED.has(lk)) continue;
        outHeaders.set(k, v);
      }
      // Same-origin embedding: the security-headers middleware respects this
      // when already set; cross-origin embedding stays denied.
      outHeaders.set("X-Frame-Options", "SAMEORIGIN");
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

/** Stripped before forwarding upstream — see top-of-file trust model. */
const REQUEST_HEADERS_STRIPPED = new Set(["host", "authorization", "cookie", "x-workspace-id"]);

/**
 * Stripped from upstream responses.
 *
 *   - Set-Cookie / Set-Cookie2: see top-of-file trust model.
 *   - X-Frame-Options / CSP: replaced with our own SAMEORIGIN.
 *   - Content-Encoding / Content-Length: Bun's fetch transparently decompresses
 *     gzipped responses, so the body we hand back is already decoded. Forwarding
 *     the original `content-encoding: gzip` would tell the browser to gunzip
 *     decompressed bytes → corrupted/empty render. Stripping `content-length`
 *     for the same reason — Bun's response layer sets transfer-encoding:
 *     chunked anyway.
 */
const RESPONSE_HEADERS_STRIPPED = new Set([
  "set-cookie",
  "set-cookie2",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
]);

const REQUEST_HAS_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);
