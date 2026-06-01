import { getBouncerMode } from "./bouncer-config.ts";

/**
 * The single source of truth for the MCP OAuth callback URL — the
 * `redirect_uri` registered with each vendor's authorization server via DCR.
 *
 * In bouncer mode every vendor's OAuth client is registered against the
 * bouncer's single URL (`NB_OAUTH_BOUNCER_CALLBACK_URL`); the bouncer
 * verifies the signed state envelope on the callback leg and 302s back to
 * this tenant. Outside bouncer mode it's this tenant's own
 * `${NB_API_URL}/v1/mcp-auth/callback`.
 *
 * **Every code path that constructs a `WorkspaceOAuthProvider` MUST resolve
 * the callback through here** — the interactive `initiate` flow, boot-time
 * auto-start, AND token revocation. The provider's DCR drift check discards
 * `client.json` whenever the registered `redirect_uri` ≠ the provider's
 * `callbackUrl`, so a path that computes the callback differently
 * (raw `NB_API_URL`, a `http://_/` placeholder, …) makes the drift check
 * fire on our *own* inconsistency: the client gets re-registered, mints a
 * new `client_id`, and orphans the stored refresh token — after which
 * silent refresh fails and the bundle falls into an interactive flow that
 * times out headlessly at boot. Resolving every path here keeps the
 * registered redirect_uri identical across paths, so the drift check only
 * fires on a genuine operator change (its intended purpose).
 */
export function mcpAuthCallbackUrl(): string {
  const bouncer = getBouncerMode();
  if (bouncer) return bouncer.callbackUrl;

  const apiBase = process.env.NB_API_URL ?? "http://localhost:27247";
  return `${apiBase.replace(/\/+$/, "")}/v1/mcp-auth/callback`;
}
