/**
 * Public surface of `src/orchestrator/`.
 *
 * Every chat / `/mcp` tool dispatch routes through this module. See `route.ts`
 * for the routing rules: a session is walled to one workspace (or, for `/mcp`,
 * to identity tools only), and a call to any other workspace is denied.
 *
 * Internal helpers stay unexported — only the orchestrator's public
 * entry points and the structured error taxonomy escape.
 */

export { mapOrchestratorErrorToToolResult } from "./error-mapping.ts";
export type { OrchestratorRuntime, RoutedToolCall } from "./route.ts";
export {
  ConnectorGrantDenied,
  CrossWorkspaceReachDenied,
  routeToolCall,
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  WorkspaceAccessDenied,
  WorkspaceToolUnavailable,
} from "./route.ts";
