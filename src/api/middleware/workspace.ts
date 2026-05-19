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

/**
 * Workspace resolution middleware for routes where the workspace is
 * **optional**. Post-Stage-1 conversation read routes need this: the
 * conversation itself is user-owned (located by `findConversation`), so
 * an `X-Workspace-Id` header isn't required to authorize the read. But
 * if a client sends one — typically the chat UI does so callers don't
 * have to special-case which routes drop it — we still validate it so
 * malformed values 400 instead of silently passing.
 *
 * Semantics:
 *  - Header absent → pass through (no `workspaceId` set on context).
 *  - Header present + valid + caller is a member → set `workspaceId`,
 *    pass through.
 *  - Header present + malformed / unknown / non-member → 400/403, same
 *    shape as `requireWorkspace` (don't silently ignore a bad header).
 */
export function optionalWorkspace(workspaceStore: WorkspaceStore) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const identity = c.var.identity;
    if (!identity) {
      await next();
      return;
    }
    // Absent header → fine. Distinguish "absent" from "present but
    // malformed" so we don't 400 every unauthenticated drive-by.
    if (!c.req.raw.headers.get("x-workspace-id")) {
      await next();
      return;
    }
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
