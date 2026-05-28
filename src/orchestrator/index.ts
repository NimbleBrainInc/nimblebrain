/**
 * Public surface of `src/orchestrator/`.
 *
 * Stage 2 (cross-workspace refactor) routes every chat / `/mcp` tool
 * dispatch through this module. See `route.ts` for the routing rules
 * and `tool-list-aggregator.ts` for the per-identity aggregated tool
 * surface (watcher-backed cache).
 *
 * Internal helpers stay unexported — only the orchestrator's public
 * entry points and the structured error taxonomy escape.
 */

export { mapOrchestratorErrorToToolResult } from "./error-mapping.ts";
export type { OrchestratorRuntime, RoutedToolCall } from "./route.ts";
export {
  routeToolCall,
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  UnknownWorkspace,
  WorkspaceAccessDenied,
} from "./route.ts";

export type {
  AggregatorWorkspaceStore,
  NamespacedToolDescriptor,
  ToolListAggregator,
  ToolListAggregatorOptions,
  WorkspaceToolLister,
} from "./tool-list-aggregator.ts";
export { createToolListAggregator } from "./tool-list-aggregator.ts";

export type { ToolListCacheOptions } from "./tool-list-cache.ts";
export { ToolListCache } from "./tool-list-cache.ts";
