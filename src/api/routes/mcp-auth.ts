import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { WORKSPACE_PRINCIPAL_ID } from "../../bundles/connection.ts";
import { log } from "../../cli/log.ts";
import { getBouncerMode } from "../../oauth/bouncer-config.ts";
import {
  ENVELOPE_VERSION,
  EnvelopeError,
  signEnvelope,
  verifyEnvelopeAsTenant,
} from "../../oauth/envelope.ts";
import { mcpAuthCallbackUrl } from "../../oauth/mcp-callback-url.ts";
import { peekWorkspaceId, resolveWithCode } from "../../tools/oauth-flow-registry.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";
import { workspaceConnectorsUrl } from "./connectors-redirect.ts";

/**
 * Inline CSS for the OAuth success page. Held in a module constant so the
 * SHA-256 below is computed once over the same string the response embeds —
 * the route's CSP allowlists exactly that hash, so any edit here that isn't
 * paired with re-running tests will surface as an unstyled page (the hash
 * stops matching, the browser blocks the <style>). Kept terse: this page is
 * visible for one second before meta-refresh fires.
 */
const SUCCESS_PAGE_STYLE = `html,body{margin:0;height:100%}
body{font-family:'Satoshi',system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f7;color:#171717;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:1rem;box-sizing:border-box;-webkit-font-smoothing:antialiased}
.h{font-family:'Erode',Georgia,serif;font-size:clamp(2.5rem,6.5vw,4.25rem);font-weight:500;letter-spacing:-0.02em;margin:0;animation:rise .35s ease-out both}
.wm{margin-top:1.5rem;font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:#737373;font-weight:700;display:flex;align-items:center;gap:.55rem;animation:rise .35s ease-out .08s both}
.wm svg{width:.65rem;height:.65rem;display:block}
.fb{position:fixed;bottom:1.25rem;font-size:.75rem;color:#525252;margin:0;font-weight:500}
.fb a{color:#404040;text-decoration:none;border-bottom:1px dotted #a3a3a3}
.fb a:hover{color:#d4620a;border-bottom-color:#d4620a}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-color-scheme:dark){body{background:#0a0a09;color:#e5e5e5}.wm{color:#a3a3a3}.fb{color:#a3a3a3}.fb a{color:#d4d4d4;border-bottom-color:#525252}.fb a:hover{color:#f59542;border-bottom-color:#f59542}}
@media (prefers-reduced-motion:reduce){.h,.wm{animation:none}}`;
const SUCCESS_PAGE_STYLE_SHA256 = createHash("sha256").update(SUCCESS_PAGE_STYLE).digest("base64");
/**
 * CSP for the OAuth success page. The default platform CSP
 * (`default-src 'none'`) blocks inline `<style>`, so the page would render
 * unstyled in production without this override. We allowlist exactly the
 * one inline style block we serve, by sha256, and nothing else: no scripts,
 * no fonts, no images, no fetches. The dotted "go back" anchor needs no
 * directive (CSP does not gate `<a href>`); the meta-refresh redirect
 * needs no directive (CSP does not gate `http-equiv="refresh"`).
 */
const SUCCESS_PAGE_CSP = `default-src 'none'; style-src 'sha256-${SUCCESS_PAGE_STYLE_SHA256}'; frame-ancestors 'none'; base-uri 'none'`;

/**
 * OAuth integration routes for outbound flows where NimbleBrain is the
 * client against a remote MCP server's authorization server.
 *
 * Two endpoints:
 *
 * - `POST /v1/mcp-auth/initiate` (workspace-authed): launches an
 *   interactive flow. Looks up the captured authorization URL on the
 *   bundle's pending Connection, sets a session-bound `nb_oauth_state`
 *   cookie scoped to the callback path, and returns the URL the client
 *   should navigate the user's browser to. **POST-only** so a malicious
 *   `<img>` or prefetch can't trigger a flow without same-origin
 *   privileges. The `X-Workspace-Id` header that
 *   `requireWorkspace` enforces forces a CORS preflight, which kills
 *   simple-form CSRF.
 *
 * - `GET /v1/mcp-auth/callback?code&state` (unauthenticated): the return
 *   leg of the OAuth dance. Verifies the `nb_oauth_state` cookie hashes
 *   to the URL-bound `state` (closes the gap where a leaked state value
 *   alone would let an attacker complete a flow on someone else's
 *   account), looks up the pending flow in `oauth-flow-registry` by
 *   state, and resolves it with the code. Stays unauthenticated by
 *   design — the user just came back from the AS and the platform's own
 *   session may not be present in this navigation context.
 */
// The redirect URI the platform registers with remote authorization
// servers is resolved by the single source of truth in
// `src/oauth/mcp-callback-url.ts` (bouncer-aware). Re-exported here
// because the web shell reaches it via the `manage_connectors` tool and
// existing callers import it from this route module.
export { mcpAuthCallbackUrl };

export function mcpAuthRoutes(ctx: AppContext) {
  // Eagerly validate bouncer config (if any) so a misconfigured
  // deployment fails at server startup with a precise error, rather
  // than serving traffic until the first user clicks "connect" and
  // hitting a generic 500. Idempotent: returns the cached value on
  // subsequent calls in the route handlers below.
  getBouncerMode();

  const app = new Hono<AppEnv>();

  // ── POST /v1/mcp-auth/initiate ────────────────────────────────────
  //
  // Workspace-authed. Body: { serverName }. Stage 2: every URL bundle
  // is workspace-scoped, so the principal is always `WORKSPACE_PRINCIPAL_ID`.
  // Personal connectors bind to the user's personal workspace, which is
  // itself a workspace from the lifecycle's vantage. Calls
  // `lifecycle.startAuth`, which is idempotent on double-click and tears
  // down stale sources (so disconnect → reconnect works without a
  // process restart).
  //
  // Auth + workspace middleware applied per-handler (not via .use("*"))
  // so the unauthenticated /callback below is unaffected. Hono's
  // sub-app `.use("*")` middleware applies to ALL routes under the
  // mount, which would otherwise gate /callback on workspace headers
  // the user's browser can't set on a return-from-AS navigation.
  app.post(
    "/v1/mcp-auth/initiate",
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx.workspaceStore),
    async (c) => {
      let body: { serverName?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return apiError(400, "bad_request", "Body must be JSON.");
      }
      const serverName = typeof body.serverName === "string" ? body.serverName : "";
      if (!serverName) {
        return apiError(400, "bad_request", "serverName is required.");
      }

      const wsId = c.var.workspaceId;
      const lifecycle = ctx.runtime.getLifecycle();

      const instance = lifecycle.getInstance(serverName, wsId);
      if (!instance) {
        return apiError(404, "bundle_not_found", `Bundle "${serverName}" not installed.`);
      }

      // Stage 2: every URL bundle is workspace-scoped (legacy `"user"`
      // literal was deleted). Personal connectors bind to the user's
      // personal workspace, so the workspace principal is the only
      // legal value here. `instance.oauthScope` is always `"workspace"`
      // or undefined post-Stage-2.
      const principalId = WORKSPACE_PRINCIPAL_ID;

      let authorizationUrl: string;
      try {
        const callbackUrl = mcpAuthCallbackUrl();
        const result = await lifecycle.startAuth(serverName, wsId, principalId, {
          workDir: ctx.runtime.getWorkDir(),
          callbackUrl,
          allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
        });
        authorizationUrl = result.authorizationUrl;
      } catch (err) {
        // Don't leak SDK / DNS / TLS details in the response body.
        // Workspace-authed callers, but the surface is wide and the
        // body crosses trust boundaries (proxies, browser dev tools,
        // HAR export). Log raw server-side; return a generic shape.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[mcp-auth] startAuth failed for ${serverName} in ${wsId}: ${msg}`);
        return apiError(
          500,
          "auth_start_failed",
          "Failed to start OAuth flow. Check server logs for details.",
        );
      }

      // Extract `state` from the URL the SDK built. We bind the user's
      // browser session to this state via a hashed cookie so a leaked
      // `state` value alone can't let a different session land tokens.
      let urlObj: URL;
      try {
        urlObj = new URL(authorizationUrl);
      } catch {
        return apiError(500, "internal_error", "Captured authorization URL is invalid.");
      }
      const state = urlObj.searchParams.get("state");
      if (!state) {
        return apiError(
          500,
          "internal_error",
          "Authorization URL is missing required state parameter.",
        );
      }

      // In bouncer mode, wrap the SDK-generated state in a signed
      // envelope so the bouncer can route the callback back to this
      // tenant. The inner state is what's bound to the cookie and what
      // `oauth-flow-registry` is keyed on — both unchanged. The vendor
      // sees only the wrapped value.
      const bouncer = getBouncerMode();
      if (bouncer) {
        try {
          const wrapped = signEnvelope({
            tid: bouncer.tid,
            inner: state,
            tenantKey: bouncer.tenantKey,
          });
          urlObj.searchParams.set("state", wrapped);
          authorizationUrl = urlObj.toString();
        } catch (err) {
          // signEnvelope rejects inputs that violate the envelope's
          // own contract (oversize inner, invalid tid). Both are
          // pre-validated above (tid at config load, inner from the
          // SDK), so reaching here implies a regression elsewhere.
          // Match the error posture of the startAuth catch above:
          // log the cause, surface a generic 500.
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[mcp-auth] envelope wrap failed for ${serverName} in ${wsId}: ${msg}`);
          return apiError(500, "internal_error", "Failed to wrap OAuth state.");
        }
      }

      const stateHash = sha256Hex(state);

      // Cookie scoped to /v1/mcp-auth/callback so it's only sent on the
      // return leg. HttpOnly + SameSite=Lax matches the existing session
      // cookie posture; Secure when not on localhost.
      const cookieParts = [
        `nb_oauth_state=${stateHash}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/v1/mcp-auth/callback",
        "Max-Age=900",
      ];
      if (!ctx.isLocalhost) cookieParts.push("Secure");
      c.header("Set-Cookie", cookieParts.join("; "));

      return c.json({ authorizationUrl });
    },
  );

  // ── GET /v1/mcp-auth/callback ─────────────────────────────────────
  //
  // Unauthenticated. Verifies the cookie matches before resolving the
  // flow. Returns minimal HTML in either branch so the user sees a clean
  // confirmation / error page.
  app.get("/v1/mcp-auth/callback", (c) => {
    // Belt-and-suspenders: an intermediate proxy caching the success page
    // (with `?code=...` in the URL) in a shared cache space is a classic
    // OAuth footgun. Codes are single-use so the real boundary is the
    // flow registry, but explicitly marking the response non-cacheable
    // kills the class entirely.
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");

    const code = c.req.query("code");
    const wireState = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.html(
        `<html><body><h3>Authorization failed</h3><pre>${escapeHtml(error)}</pre></body></html>`,
        400,
      );
    }
    if (!code || !wireState) {
      return c.text("missing code or state", 400);
    }

    // In bouncer mode the URL state arrives wrapped — unwrap it to
    // recover the inner state, which is what the cookie binding and
    // flow registry are keyed on. In direct mode (single-instance
    // self-hosts) the wire state is the inner state. We refuse to
    // unwrap an inner-shaped state in bouncer mode: a callback that
    // bypassed the bouncer is either a stale flow from before bouncer
    // mode was enabled (rare, user should re-initiate) or an attacker
    // probing the platform's direct hostname.
    const bouncer = getBouncerMode();
    let state: string;
    if (bouncer) {
      if (!wireState.startsWith(`${ENVELOPE_VERSION}.`)) {
        return c.html(
          "<html><body><h3>Authorization state envelope missing.</h3>" +
            "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
          400,
        );
      }
      try {
        const payload = verifyEnvelopeAsTenant({
          wire: wireState,
          tenantKey: bouncer.tenantKey,
          expectedTid: bouncer.tid,
        });
        state = payload.inner;
      } catch (err) {
        // Log the specific failure code for ops, but show the user a
        // generic message — leaking which check failed gives an attacker
        // an oracle for probing the envelope format.
        const code = err instanceof EnvelopeError ? err.code : "unknown";
        log.warn(`[mcp-auth] bouncer envelope verification failed: ${code}`);
        return c.html(
          "<html><body><h3>Authorization session invalid.</h3>" +
            "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
          400,
        );
      }
    } else {
      state = wireState;
    }

    // Session-binding check: the cookie set by /initiate must match the
    // URL state. Without this, a leaked state value (referrer header,
    // browser history, network log) could let an attacker drop tokens
    // into someone else's flow. The cookie is a sha256 of state — bound
    // to the originating session, can't be derived from the URL alone.
    const expected = sha256Hex(state);
    const cookieValue = readCookie(c.req.header("cookie"), "nb_oauth_state");
    if (!cookieValue || !timingSafeEqualHex(cookieValue, expected)) {
      return c.html(
        "<html><body><h3>Authorization session mismatch.</h3>" +
          "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
        400,
      );
    }

    // Recover the workspace the flow was initiated in *before* resolving
    // (which deletes the registry entry), so we can land the user back on
    // the right `/w/<slug>/settings/connectors` page. Synchronous + single-
    // process, so the peek can't race the resolve below.
    const flowWsId = peekWorkspaceId(state);
    if (!resolveWithCode(state, code)) {
      return c.html(
        "<html><body><h3>Unknown or expired OAuth flow.</h3>" +
          "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
        404,
      );
    }

    // Every connector lands on the workspace Connectors page. Stage 2
    // collapsed user-scope into the owner's personal workspace; per-
    // workspace dispatch needs no additional branching here.

    // Clear the one-shot state cookie so a refresh of this page can't
    // be used as a replay vector.
    const expireParts = [
      "nb_oauth_state=",
      "HttpOnly",
      "SameSite=Lax",
      "Path=/v1/mcp-auth/callback",
      "Max-Age=0",
    ];
    if (!ctx.isLocalhost) expireParts.push("Secure");
    c.header("Set-Cookie", expireParts.join("; "));

    // Auto-redirect back to the workspace Connectors page. The user came
    // from NimbleBrain and was navigated away to the OAuth provider in
    // their existing tab — telling them to "close this tab" is wrong
    // because they'd lose NimbleBrain entirely. We bring them home, to the
    // same `/w/<slug>` workspace the flow was initiated in. `flowWsId` is
    // non-null here (resolveWithCode succeeded just above ⟹ the flow
    // existed when we peeked it).
    const returnUrl = workspaceConnectorsUrl(flowWsId ?? "");
    const safeReturnUrl = escapeHtml(returnUrl);
    // Override the platform-default CSP (`default-src 'none'`) for this
    // response only. Without this the inline <style> below is blocked and
    // the page renders unstyled in any deployment that doesn't override
    // NB_CSP — i.e. all of them. The hash pins us to exactly the bytes
    // we serve.
    c.header("Content-Security-Policy", SUCCESS_PAGE_CSP);
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization complete</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="1;url=${safeReturnUrl}">
<style>${SUCCESS_PAGE_STYLE}</style></head>
<body>
<h1 class="h">You're in.</h1>
<div class="wm"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0L12 6L6 12L0 6Z" fill="#d4620a"/></svg>NimbleBrain</div>
<p class="fb">not redirecting? <a href="${safeReturnUrl}">go back &rarr;</a></p>
</body></html>`,
    );
  });

  return app;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time hex string comparison via Node's `crypto.timingSafeEqual`.
 * Both inputs must be 64-char sha256 hex; anything else (malformed cookie,
 * wrong length) is rejected up-front so the constant-time compare always
 * runs on equal-length 32-byte buffers.
 */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
function timingSafeEqualHex(a: string, b: string): boolean {
  if (!SHA256_HEX_RE.test(a) || !SHA256_HEX_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq);
    const v = trimmed.slice(eq + 1);
    if (k === name) return v;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}
