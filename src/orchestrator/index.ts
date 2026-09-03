/**
 * Public surface of `src/orchestrator/`.
 *
 * Every chat / `/mcp` tool dispatch routes through this module. See `route.ts`
 * for the routing rules: a session is walled to one workspace (or, for `/mcp`,
 * to identity tools only), and a call to any other workspace is denied.
 *
 * `dispatchUnattended` is the third door — one tool call from stored
 * configuration, with no session — and it composes `IdentityToolRouter`, which
 * imports this module's routing pieces. That router therefore imports
 * `./route.ts` and `./error-mapping.ts` directly rather than this barrel, so
 * the two do not close a cycle through it.
 *
 * Internal helpers stay unexported — only the orchestrator's public
 * entry points and the structured error taxonomy escape.
 */

export { mapOrchestratorErrorToToolResult } from "./error-mapping.ts";
export type { OrchestratorRuntime, RoutedToolCall } from "./route.ts";
export {
  ConnectorGrantDenied,
  routeToolCall,
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  WorkspaceAccessDenied,
  WorkspaceToolUnavailable,
} from "./route.ts";
export type {
  UnattendedDispatchClassification,
  UnattendedDispatchOptions,
  UnattendedDispatchOutcome,
  UnattendedDispatchResult,
  UnattendedDispatchRuntime,
} from "./unattended-dispatch.ts";
export {
  dispatchUnattended,
  UNATTENDED_DISPATCH_TIMEOUT_MS,
  UNATTENDED_REASON_MAX,
  UNATTENDED_RESULT_MAX_BYTES,
} from "./unattended-dispatch.ts";
