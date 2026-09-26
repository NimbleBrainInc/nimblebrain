import { Hono } from "hono";
import { handleReadResource, handleResourceProxy, handleResourceUpload } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requireWorkspace, WORKSPACE_ROUTE_PREFIX } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

/** Where an app's `ui://` resources are served, below the workspace prefix. */
const APP_RESOURCES_ROUTE = `${WORKSPACE_ROUTE_PREFIX}/apps/:name/resources/*`;

export function resourceRoutes(ctx: AppContext) {
  // maxTotalSize is snapshot at route construction; mirrors chat routes
  // (filesConfig is built once at startup and never mutated). Multipart
  // override lets uploads use the file-config cap; the JSON cap stays
  // small for resources/read.
  const uploadLimit = bodyLimit(1_048_576, {
    multipart: ctx.runtime.getFilesConfig().maxTotalSize,
  });
  // Every route here is workspace-scoped. A read or an upload that reaches an
  // identity source (conversations, files) still lands in the workspace in the
  // URL, because those sources' data is workspace-owned. An identity app's
  // `ui://` resource (conversations, …) is the same in every workspace and is
  // served from the identity host; the workspace in the URL decides nothing for
  // it, but the web shell renders every app inside a workspace, so one route
  // serves both.
  return (
    new Hono<AppEnv>()
      .use("*", requireAuth(ctx.authOptions))
      .use("*", errorLog(ctx))
      .post(
        `${WORKSPACE_ROUTE_PREFIX}/resources/read`,
        requireWorkspace(ctx),
        bodyLimit(1_048_576),
        (c) =>
          handleReadResource(c.req.raw, ctx.runtime, {
            workspaceId: c.var.workspaceId,
            identity: c.var.identity,
          }),
      )
      // Uploads write to the workspace in the URL, under the owner partition.
      .post(`${WORKSPACE_ROUTE_PREFIX}/resources`, requireWorkspace(ctx), uploadLimit, (c) =>
        handleResourceUpload(
          c.req.raw,
          ctx.runtime,
          ctx.features,
          c.var.identity,
          c.var.workspaceId,
        ),
      )
      .get(APP_RESOURCES_ROUTE, requireWorkspace(ctx), (c) => {
        const name = decodeURIComponent(c.req.param("name"));
        // Extract the full resource path after /resources/
        const url = new URL(c.req.url);
        const prefix = `/v1/workspaces/${c.req.param("wsId")}/apps/${c.req.param("name")}/resources/`;
        const resourcePath = decodeURIComponent(url.pathname.slice(prefix.length));
        return handleResourceProxy(
          name,
          resourcePath,
          ctx.runtime,
          c.var.workspaceId,
          c.var.identity,
        );
      })
  );
}
