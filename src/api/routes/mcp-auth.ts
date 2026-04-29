import { createHash } from "node:crypto";
import { Hono } from "hono";
import { resolveWithCode } from "../../tools/oauth-flow-registry.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

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
export function mcpAuthRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  // ── POST /v1/mcp-auth/initiate ────────────────────────────────────
  //
  // Workspace-authed. Body: { serverName, principalId? }. principalId
  // defaults to "_workspace" (the only mode in Step 1); Step 3 will let
  // member-scoped bundles pass a real member id.
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
      let body: { serverName?: unknown; principalId?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return apiError(400, "bad_request", "Body must be JSON.");
      }
      const serverName = typeof body.serverName === "string" ? body.serverName : "";
      if (!serverName) {
        return apiError(400, "bad_request", "serverName is required.");
      }
      const principalId =
        typeof body.principalId === "string" && body.principalId.length > 0
          ? body.principalId
          : "_workspace";

      const wsId = c.var.workspaceId;
      const lifecycle = ctx.runtime.getLifecycle();
      const authorizationUrl = lifecycle.getPendingAuthUrl(serverName, wsId, principalId);
      if (!authorizationUrl) {
        return apiError(
          404,
          "not_pending_auth",
          `No pending OAuth flow for serverName="${serverName}" in this workspace.`,
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

  // ── GET /v1/connections/pending ────────────────────────────────────
  //
  // Workspace-authed snapshot of Connections in pending_auth. The web
  // client fetches this once on workspace render to populate the banner
  // — connection.state_changed SSE events only fire from connect time
  // forward, so a client that connects after a bundle entered
  // pending_auth would otherwise miss the signal until reload.
  app.get(
    "/v1/connections/pending",
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx.workspaceStore),
    (c) => {
      const wsId = c.var.workspaceId;
      const lifecycle = ctx.runtime.getLifecycle();
      const pending = lifecycle.getPendingConnections(wsId);
      return c.json({ connections: pending });
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
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      return c.html(
        `<html><body><h3>Authorization failed</h3><pre>${escapeHtml(error)}</pre></body></html>`,
        400,
      );
    }
    if (!code || !state) {
      return c.text("missing code or state", 400);
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

    const matched = resolveWithCode(state, code);
    if (!matched) {
      return c.html(
        "<html><body><h3>Unknown or expired OAuth flow.</h3>" +
          "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
        404,
      );
    }

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

    return c.html(
      "<html><body><h3>Authorization complete.</h3>" +
        "<p>You can close this tab and return to NimbleBrain.</p></body></html>",
    );
  });

  return app;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time hex string comparison. Avoids leaking timing info that
 * a naive `===` would expose if an attacker can probe the callback. Both
 * inputs are expected to be sha256 hex (64 chars); a length mismatch is
 * treated as inequality without revealing where the divergence is.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
