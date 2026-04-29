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
 *   starting   → running             (auth complete, client connected)
 *   starting   → pending_auth        (interactive OAuth required)
 *   pending_auth → running           (user completed auth, retry succeeded)
 *   pending_auth → dead              (auth timed out or refresh failed)
 *   running    → crashed             (transport error, may auto-recover)
 *   running    → pending_auth        (refresh failed mid-session)
 *   crashed    → running             (HealthMonitor recovered)
 *   crashed    → dead                (give up after retries)
 *   *          → stopped             (explicit stop / uninstall)
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
 * Compute a `BundleState` summary from a connection map. For Step 1
 * (workspace-scope only) the map has one entry and we return its state
 * directly. For Step 3 (member-scope), apply summary rules:
 *
 *   - Empty map → "stopped" (no principals have ever connected)
 *   - Any "running" → "running"
 *   - Else any "pending_auth" → "pending_auth"
 *   - Else any "starting" → "starting"
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
  if (states.includes("crashed")) return "crashed";
  return states[0]!;
}
