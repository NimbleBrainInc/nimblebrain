import { createMiddleware } from "hono/factory";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import { resolveWorkspace, WorkspaceResolutionError } from "../auth-middleware.ts";
import { type AppEnv, apiError } from "../types.ts";

/**
 * Workspace resolution middleware. When identity exists, workspace MUST resolve
 * or the request is rejected. No silent pass-through without workspace.
 */
export function requireWorkspace(workspaceStore: WorkspaceStore) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const identity = c.var.identity;

    // No identity = dev mode — pass through (auth middleware handles enforcement)
    if (!identity) {
      await next();
      return;
    }

    // Identity exists — workspace resolution is mandatory
    try {
      const wsId = await resolveWorkspace(c.req.raw, identity, workspaceStore);
      c.set("workspaceId", wsId);
    } catch (e) {
      if (e instanceof WorkspaceResolutionError) {
        return apiError(e.statusCode, "workspace_error", e.message);
      }
      throw e;
    }

    await next();
  });
}
