import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import {
  type ComposioConnection,
  saveComposioConnection,
} from "../../bundles/composio-connection.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../bundles/connection.ts";
import { slugifyServerName } from "../../bundles/paths.ts";
import { log } from "../../cli/log.ts";
import {
  COMPOSIO_API_BASE,
  COMPOSIO_CALLBACK_PATH,
  composioCallbackUrl,
  composioSuccessRedirectUrl,
  composioUserId,
  findActiveComposioConnection,
  initiateComposioConnection,
  validateComposioConfig,
} from "../../composio/sdk.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/**
 * OAuth integration routes for connectors backed by Composio as a
 * remote OAuth aggregator. Composio holds the vendor's tokens and
 * exposes the toolkit's tools through its own MCP endpoint; the
 * platform only persists an opaque `connectedAccountId` per workspace
 * per connector.
 *
 * Three endpoints:
 *
 * - `POST /v1/composio-auth/initiate` (workspace-authed): asks
 *   Composio to begin a connection for this workspace, sets a session-
 *   bound `nb_composio_state` cookie, and returns the redirect URL the
 *   browser should navigate to. **POST-only** + `X-Workspace-Id` header
 *   forces a CORS preflight, killing simple-form CSRF — same posture
 *   as `/v1/mcp-auth/initiate`.
 *
 * - `GET /v1/composio-auth/callback` (unauthenticated): the return
 *   leg from Composio after the user consents at the vendor.
 *   Verifies the cookie nonce binds the calling browser session to
 *   (connectorId, workspaceId) so a leaked URL alone can't land
 *   tokens in someone else's workspace, then writes `connection.json`.
 *
 * - `GET /v1/composio-auth/proxy` (unauthenticated): white-label
 *   forwarder. Registered with the vendor as our OAuth client's
 *   redirect URI; 302s to Composio's real callback so the address bar
 *   shows our domain throughout the consent dance. Stateless — never
 *   sees tokens; only forwards browser navigation.
 */

/**
 * Inline CSS for the post-callback success page, sha256-pinned in the
 * CSP just like `/v1/mcp-auth/callback`. The page is visible for one
 * second before the meta-refresh fires; brevity is the point.
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
const SUCCESS_PAGE_CSP = `default-src 'none'; style-src 'sha256-${SUCCESS_PAGE_STYLE_SHA256}'; frame-ancestors 'none'; base-uri 'none'`;

/**
 * Slug allowed in the `cid` query param. Matches our catalog id form
 * (`<reverse-dns>/<name>`, e.g. `com.google/gmail`). Filesystem
 * traversal is already defeated downstream by `connectorSlug`'s
 * slash→dash replacement — this is defense-in-depth at the route
 * boundary.
 *
 * Explicit `..` and `//` substring rejection on top of the char-class
 * regex: no legitimate catalog id contains either, so rejecting them
 * here surfaces malformed input earlier than the slug step.
 */
const CID_RE = /^[A-Za-z0-9._/-]{1,128}$/;
function isValidConnectorId(cid: string): boolean {
  return CID_RE.test(cid) && !cid.includes("..") && !cid.includes("//");
}

export function composioAuthRoutes(ctx: AppContext) {
  // Eager startup validation — same pattern as `getBouncerMode()` in
  // `mcpAuthRoutes`. Misconfigured `COMPOSIO_API_BASE_URL` or missing
  // `NB_TENANT_ID` in multi-tenant mode throws here, at server start,
  // not on the first user click.
  validateComposioConfig();

  const app = new Hono<AppEnv>();

  // ── POST /v1/composio-auth/initiate ───────────────────────────────
  app.post(
    "/v1/composio-auth/initiate",
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx.workspaceStore),
    async (c) => {
      let body: { connectorId?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return apiError(400, "bad_request", "Body must be JSON.");
      }
      const connectorId = typeof body.connectorId === "string" ? body.connectorId : "";
      if (!connectorId || !isValidConnectorId(connectorId)) {
        return apiError(400, "bad_request", "connectorId is required and must be a catalog id.");
      }

      const wsId = c.var.workspaceId;
      const directory = ctx.runtime.getConnectorDirectory();
      const entry = await directory.catalogById(connectorId);
      if (!entry) {
        return apiError(404, "connector_not_found", `Connector "${connectorId}" not in catalog.`);
      }
      if (entry.auth !== "composio" || !entry.composio) {
        return apiError(
          400,
          "wrong_auth_kind",
          `Connector "${connectorId}" is not Composio-backed (auth=${entry.auth}).`,
        );
      }

      // Platform-wide Composio API key. Single source for the whole
      // deployment; per-workspace isolation lives in `user_id`. A
      // missing key is operator config error — surface generic 500
      // and log specifics rather than telling the API caller which
      // env var to set (the API isn't operator-facing).
      const apiKey = process.env.COMPOSIO_API_KEY?.trim();
      if (!apiKey) {
        log.warn(
          "[composio-auth] COMPOSIO_API_KEY not set; cannot initiate connection " +
            `for ${connectorId} in ${wsId}`,
        );
        return apiError(500, "composio_unconfigured", "Composio integration not configured.");
      }

      // Per-connector Composio `auth_config_id`. Lives in the catalog
      // entry's `_meta.composio.authConfigEnv` as the name of the env
      // var holding the value; the actual id (e.g. `ac_xxx`) is
      // operator-supplied via 1Password → ExternalSecret → pod env.
      // The indirection keeps the catalog file free of deployment-
      // specific identifiers.
      const authConfigEnvName = entry.composio.authConfigEnv;
      const authConfigId = process.env[authConfigEnvName]?.trim();
      if (!authConfigId) {
        log.warn(
          `[composio-auth] ${authConfigEnvName} not set; cannot initiate ${connectorId} in ${wsId}`,
        );
        return apiError(
          500,
          "composio_unconfigured",
          `Composio auth config for "${connectorId}" not configured.`,
        );
      }

      const userId = composioUserId(wsId);

      // Short-circuit: if Composio already has an ACTIVE connected
      // account for this (userId, authConfigId), reuse it. The
      // chat-side `manageConnections` flow and an earlier explicit
      // click both create connected accounts here; without this
      // dedup we'd hit Composio's "Multiple connected accounts
      // found … use allowMultiple" error or pile up duplicates.
      // We adopt the existing account by writing our own
      // connection.json against its id, transitioning the bundle
      // state to `running`, and telling the SPA to navigate to the
      // success page — no second OAuth round-trip.
      try {
        const existing = await findActiveComposioConnection({
          apiKey,
          userId,
          authConfigId,
        });
        if (existing) {
          const connection: ComposioConnection = {
            connectedAccountId: existing.id,
            toolkit: entry.composio.toolkit,
            userId,
            connectedAt: new Date().toISOString(),
            status: existing.status,
          };
          await saveComposioConnection(ctx.runtime.getWorkDir(), wsId, connectorId, connection);
          try {
            const serverName = slugifyServerName(connectorId);
            ctx.runtime
              .getLifecycle()
              .recordConnectionStateChange(serverName, wsId, WORKSPACE_PRINCIPAL_ID, "running");
          } catch (err) {
            log.warn(
              `[composio-auth] adopt: state transition failed for ${connectorId} in ${wsId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          return c.json({
            authorizationUrl: composioSuccessRedirectUrl(c.req.url),
            pendingConnectedAccountId: existing.id,
            alreadyConnected: true,
          });
        }
      } catch (err) {
        // Lookup failures shouldn't block a fresh OAuth attempt —
        // fall through to initiate. Log so the operator can investigate.
        log.warn(
          `[composio-auth] connected-account lookup failed for ${connectorId} in ${wsId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const nonce = randomBytes(32).toString("hex");

      // Encode the binding parameters in the callback URL so the
      // callback handler (which has no workspace middleware — the
      // user comes back from Composio without our headers) can
      // reconstruct the (connectorId, wsId) tuple. The cookie hash
      // commits to all three values; tampering with any of them in
      // the URL fails the constant-time compare on return.
      const callbackBase = composioCallbackUrl();
      const callbackUrl = new URL(callbackBase);
      callbackUrl.searchParams.set("cid", connectorId);
      callbackUrl.searchParams.set("ws", wsId);
      callbackUrl.searchParams.set("n", nonce);

      let initiateResponse: { redirectUrl: string; connectedAccountId: string };
      try {
        initiateResponse = await initiateComposioConnection({
          apiKey,
          userId,
          authConfigId,
          callbackUrl: callbackUrl.toString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[composio-auth] initiate failed for ${connectorId} in ${wsId}: ${msg}`);
        return apiError(
          502,
          "composio_initiate_failed",
          "Composio rejected the connection initiate.",
        );
      }

      // Cookie binds (nonce, connectorId, wsId) to this browser
      // session. Scoped to /v1/composio-auth/callback so it's only
      // sent back on the return leg — never leaked to /initiate
      // calls on adjacent paths or to the SPA.
      const stateHash = sha256Hex(`${nonce}.${connectorId}.${wsId}`);
      const cookieParts = [
        `nb_composio_state=${stateHash}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/v1/composio-auth/callback",
        "Max-Age=900",
      ];
      if (!ctx.isLocalhost) cookieParts.push("Secure");
      c.header("Set-Cookie", cookieParts.join("; "));

      return c.json({
        authorizationUrl: initiateResponse.redirectUrl,
        pendingConnectedAccountId: initiateResponse.connectedAccountId,
      });
    },
  );

  // ── GET /v1/composio-auth/callback ────────────────────────────────
  app.get("/v1/composio-auth/callback", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");

    const connectedAccountId =
      c.req.query("connectedAccountId") ?? c.req.query("connected_account_id");
    const status = c.req.query("status") ?? "ACTIVE";
    const error = c.req.query("error");
    const cid = c.req.query("cid");
    const wsId = c.req.query("ws");
    const nonce = c.req.query("n");

    if (error) {
      return c.html(
        `<html><body><h3>Connection failed</h3><pre>${escapeHtml(error)}</pre></body></html>`,
        400,
      );
    }
    if (!cid || !wsId || !nonce) {
      return c.text("missing cid, ws, or nonce", 400);
    }
    if (!isValidConnectorId(cid)) {
      return c.text("invalid cid", 400);
    }
    if (!connectedAccountId) {
      return c.text("missing connectedAccountId", 400);
    }

    const expected = sha256Hex(`${nonce}.${cid}.${wsId}`);
    const cookieValue = readCookie(c.req.header("cookie"), "nb_composio_state");
    if (!cookieValue || !timingSafeEqualHex(cookieValue, expected)) {
      return c.html(
        "<html><body><h3>Authorization session mismatch.</h3>" +
          "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
        400,
      );
    }

    const directory = ctx.runtime.getConnectorDirectory();
    const entry = await directory.catalogById(cid);
    if (!entry || entry.auth !== "composio" || !entry.composio) {
      return c.text(`connector "${cid}" is not Composio-backed`, 400);
    }

    const userId = composioUserId(wsId);
    const connection: ComposioConnection = {
      connectedAccountId,
      toolkit: entry.composio.toolkit,
      userId,
      connectedAt: new Date().toISOString(),
      status,
    };

    try {
      await saveComposioConnection(ctx.runtime.getWorkDir(), wsId, cid, connection);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[composio-auth] failed to persist connection for ${cid} in ${wsId}: ${msg}`);
      return c.text("internal_error", 500);
    }

    // Transition the lifecycle state from `not_authenticated` (set
    // at boot when connection.json was absent) to `running`. Without
    // this the UI would keep showing "Sign-in required" until the
    // next platform restart, even though tools were already callable.
    // The bundle's McpSource started successfully at install via
    // static-auth (x-api-key) — what just landed is the user-presence
    // signal, not the transport handshake.
    try {
      const serverName = slugifyServerName(cid);
      ctx.runtime
        .getLifecycle()
        .recordConnectionStateChange(serverName, wsId, WORKSPACE_PRINCIPAL_ID, "running");
    } catch (err) {
      // Non-fatal — the next boot will derive `running` from
      // connection.json. Log and continue to the success page.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        `[composio-auth] state transition failed for ${cid} in ${wsId} (will recover on restart): ${msg}`,
      );
    }

    // One-shot cookie — clear on success so a refresh of this page
    // can't be used as a replay vector.
    const expireParts = [
      "nb_composio_state=",
      "HttpOnly",
      "SameSite=Lax",
      "Path=/v1/composio-auth/callback",
      "Max-Age=0",
    ];
    if (!ctx.isLocalhost) expireParts.push("Secure");
    c.header("Set-Cookie", expireParts.join("; "));

    const fallbackOrigin = (() => {
      try {
        return new URL(c.req.url).origin;
      } catch {
        return "";
      }
    })();
    const webBase = process.env.NB_WEB_URL ?? process.env.NB_API_URL ?? fallbackOrigin;
    let returnUrl = `${webBase.replace(/\/+$/, "")}/settings/workspace/connectors`;
    try {
      const parsed = new URL(returnUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        returnUrl = "/settings/workspace/connectors";
      }
    } catch {
      returnUrl = "/settings/workspace/connectors";
    }
    const safeReturnUrl = escapeHtml(returnUrl);
    c.header("Content-Security-Policy", SUCCESS_PAGE_CSP);
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connection complete</title>
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

  // ── GET /v1/composio-auth/proxy ───────────────────────────────────
  //
  // White-label forwarder. The vendor's OAuth client redirect URI is
  // registered as this endpoint; we 302 to Composio's real callback
  // so the browser address bar never shows `backend.composio.dev`
  // during the consent dance. Stateless — passes query params
  // verbatim, holds no secrets, sees no tokens. Browser-side only:
  // the response body is empty, only the Location header matters.
  app.get("/v1/composio-auth/proxy", (c) => {
    c.header("Cache-Control", "no-store");
    const apiBase = process.env.COMPOSIO_API_BASE_URL ?? COMPOSIO_API_BASE;
    const url = new URL(c.req.url);
    const target = `${apiBase.replace(/\/+$/, "")}${COMPOSIO_CALLBACK_PATH}${url.search}`;
    return c.redirect(target, 302);
  });

  return app;
}

// ── Helpers shared with mcp-auth.ts in shape (kept inline to avoid
// cross-route coupling — these are stock building blocks). ─────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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
