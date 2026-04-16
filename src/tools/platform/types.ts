import type { Runtime } from "../../runtime/runtime.ts";

/**
 * Context passed to all platform tool handlers.
 * Provides workspace-scoped paths and runtime access.
 */
export interface PlatformToolContext {
  /** Workspace-scoped work directory (e.g., ~/.nimblebrain/workspaces/ws_default/) */
  workDir: string;
  /** Global work directory (e.g., ~/.nimblebrain/) — for shared config, skills */
  globalWorkDir: string;
  /** Active workspace ID, if any */
  workspaceId?: string;
  /** Runtime instance for cross-cutting access */
  runtime: Runtime;
}
