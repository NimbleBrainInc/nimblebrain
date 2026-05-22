/**
 * Public surface of `src/orchestrator/`.
 *
 * Stage 2 (delegation-model refactor) routes every chat / `/mcp` tool
 * dispatch through this module. See `route.ts` for the design rules,
 * failure modes, and Stage 1 lessons honored.
 *
 * Internal helpers (parse + authorization + context construction) stay
 * unexported — only the orchestrator's public entry point and its
 * structured error taxonomy escape.
 *
 * NOTE FOR GROUP B COORDINATION: T005 (tool-list aggregator + cache)
 * adds its own files under `src/orchestrator/` but is instructed not
 * to edit this index. Group B integration will fold T005's exports
 * into this surface; until then, those modules are imported directly
 * by their internal callers.
 */

export type { OrchestratorRuntime, RoutedToolCall } from "./route.ts";
export {
  routeToolCall,
  UnknownNamespacedToolName,
  UnknownToolSource,
  UnknownWorkspace,
  WorkspaceAccessDenied,
} from "./route.ts";
