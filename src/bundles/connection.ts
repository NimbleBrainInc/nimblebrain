import type { McpSource } from "../tools/mcp-source.ts";
import type { BundleState } from "./types.ts";

/**
 * Special principal id meaning "the workspace itself" — used when a bundle
 * is `oauthScope: "workspace"` (the only mode in Step 1). Member-scoped
 * bundles use the actual member id as the principal.
 *
 * Picked with a leading underscore so it can never collide with a real
 * user id. The underscore-prefix convention is enforced where principal
 * ids are derived from user input.
 */
export const WORKSPACE_PRINCIPAL_ID = "_workspace";

/**
 * State machine for a single Connection. A Connection is one
 * (bundle, principal) tuple — the operational unit that owns an MCP
 * Client + Transport + auth provider.
 *
 * Transitions:
 *   (init)              → not_authenticated   (URL bundle installed, no tokens)
 *   (init)              → starting            (URL bundle has persisted tokens; attempting boot)
 *   not_authenticated   → pending_auth        (user clicked Connect; OAuth flow in progress)
 *   reauth_required     → pending_auth        (user clicked Reconnect after RT failure)
 *   pending_auth        → running             (callback succeeded; tokens stored)
 *   pending_auth        → dead                (callback failed or 15s timeout)
 *   starting            → running             (boot succeeded with persisted tokens)
 *   starting            → reauth_required     (boot failed; refresh token rejected)
 *   starting            → dead                (other transport / network failure)
 *   running             → reauth_required     (refresh failed mid-session)
 *   running             → crashed             (transport error; HealthMonitor may recover)
 *   running             → not_authenticated   (user clicked Disconnect)
 *   crashed             → running             (HealthMonitor recovered)
 *   crashed             → dead                (give up after retries)
 *   *                   → stopped             (explicit uninstall — bundle removed)
 *
 * UI contract:
 *   - `not_authenticated`: silent. Connections card shows "Connect" button.
 *   - `pending_auth`: silent during normal flow (browser is being redirected). If we render anything, "Connecting…" + spinner.
 *   - `running`: green pill, "Disconnect" button.
 *   - `reauth_required`: amber pill "Reconnection needed", "Reconnect" button.
 *   - `dead`: red pill "Failed", "Reconnect" button.
 *   - `starting` / `crashed` / `stopped`: transient or end states; surfaced as needed.
 *
 * No global banner — surface state on the Connections page card and inline
 * in chat when a tool call hits an unauthenticated bundle.
 */
export type ConnectionState = BundleState;

/**
 * Operational state for one (bundle, principal) tuple. Owns the McpSource
 * that holds the Client, Transport, and auth provider for this principal.
 *
 * The Connection is the unit that transitions through OAuth states
 * (starting → pending_auth → running). The BundleInstance.state is a
 * summary derived from the connection map — for workspace-scoped bundles
 * (only mode in Step 1) it equals the single Connection's state.
 */
export interface Connection {
  /** Principal id this Connection authenticates as. WORKSPACE_PRINCIPAL_ID for workspace-scope. */
  principalId: string;
  /** Current state. Updated by lifecycle, never directly by the McpSource. */
  state: ConnectionState;
  /** The MCP Client/Transport for this principal. Null while uninitialized. */
  source: McpSource | null;
  /**
   * Authorization URL to send the user's browser to. Populated only while
   * `state === "pending_auth"`. Read by `/v1/mcp-auth/initiate` to issue
   * the redirect; cleared when the connection transitions away from
   * pending_auth.
   */
  authorizationUrl?: string;
  /** Last error that caused a transition to `crashed` / `dead`. Diagnostic only. */
  lastError?: string;
}

/**
 * Compute a `BundleState` summary from a connection map. The map has one
 * entry for workspace-scope and N entries for member-scope (one per active
 * member). Summary rules — most-functional state wins:
 *
 *   - Empty map → "stopped" (bundle exists but no principals have any state yet)
 *   - Any "running" → "running" (at least one principal can use the bundle)
 *   - Else any "pending_auth" → "pending_auth"
 *   - Else any "starting" → "starting"
 *   - Else any "reauth_required" → "reauth_required"
 *   - Else any "not_authenticated" → "not_authenticated"
 *   - Else any "crashed" → "crashed"
 *   - Else (all "dead" or "stopped") → first state encountered
 *
 * The "any running wins" rule reflects the user-facing intent: if at
 * least one principal can use this bundle, the bundle is functional.
 */
export function summarizeConnectionState(connections: Map<string, Connection>): BundleState {
  if (connections.size === 0) return "stopped";

  const states: ConnectionState[] = [];
  for (const c of connections.values()) states.push(c.state);

  if (states.includes("running")) return "running";
  if (states.includes("pending_auth")) return "pending_auth";
  if (states.includes("starting")) return "starting";
  if (states.includes("reauth_required")) return "reauth_required";
  if (states.includes("not_authenticated")) return "not_authenticated";
  if (states.includes("crashed")) return "crashed";
  return states[0]!;
}
