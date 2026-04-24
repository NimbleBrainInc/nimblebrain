import { Hono } from "hono";
import { resolveWithCode } from "../../tools/oauth-flow-registry.ts";
import type { AppContext } from "../types.ts";

/**
 * Callback endpoint for outbound OAuth flows where NimbleBrain is acting as
 * the client against a remote MCP server's authorization server. Pairs with
 * `WorkspaceOAuthProvider`: when the provider's flow requires a real browser
 * round-trip, the remote authorization server redirects the user's browser
 * here with `?code=<code>&state=<state>`.
 *
 * The route looks up the pending flow by `state` via the process-local
 * `oauth-flow-registry`, resolves it with the code, and shows a minimal
 * "done" page so the user can close the tab.
 *
 * Unauthenticated by design — it's the return leg of an OAuth flow the user
 * explicitly initiated by adding a remote bundle. State param prevents
 * unsolicited code injection; unknown states 400 cleanly.
 *
 * MVP note: Reboot's `Anonymous` dev OAuth is handled entirely inside
 * `WorkspaceOAuthProvider.redirectToAuthorization` (headless) — the
 * authorization URL self-targets this route with the code already embedded,
 * and the provider resolves the deferred in-process without making an HTTP
 * request. This route is kept in place as the extension point for real
 * interactive providers (follow-up iteration).
 */
export function mcpAuthRoutes(_ctx: AppContext) {
  const app = new Hono();

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

    const matched = resolveWithCode(state, code);
    if (!matched) {
      return c.html(
        "<html><body><h3>Unknown or expired OAuth flow.</h3>" +
          "<p>Re-initiate the connection from NimbleBrain.</p></body></html>",
        404,
      );
    }

    return c.html(
      "<html><body><h3>Authorization complete.</h3>" +
        "<p>You can close this tab and return to NimbleBrain.</p></body></html>",
    );
  });

  return app;
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
