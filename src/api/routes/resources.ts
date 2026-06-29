import { Hono } from "hono";
import { handleReadResource, handleResourceProxy, handleResourceUpload } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { optionalWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function resourceRoutes(ctx: AppContext) {
  // maxTotalSize is snapshot at route construction; mirrors chat routes
  // (filesConfig is built once at startup and never mutated). Multipart
  // override lets uploads use the file-config cap; the JSON cap stays
  // small for resources/read.
  const uploadLimit = bodyLimit(1_048_576, {
    multipart: ctx.runtime.getFilesConfig().maxTotalSize,
  });
  // Workspace resolution is per-route, not global: reads/uploads are
  // workspace-scoped (requireWorkspace), but the app-resource GET also serves
  // identity apps (conversations, …) that have NO workspace — so it uses
  // optionalWorkspace, which validates an `X-Workspace-Id` if present but
  // doesn't demand one. `handleResourceProxy` routes identity apps to the
  // identity host and still requires a workspace for workspace apps.
  return (
    new Hono<AppEnv>()
      .use("*", requireAuth(ctx.authOptions))
      .use("*", errorLog(ctx))
      // optionalWorkspace: an identity source (conversations, files) has no
      // workspace, so a header isn't required — `handleReadResource` routes
      // identity sources to the identity host and still 400s a workspace source
      // read without a workspace.
      .post(
        "/v1/resources/read",
        optionalWorkspace(ctx.workspaceStore),
        bodyLimit(1_048_576),
        (c) =>
          handleReadResource(c.req.raw, ctx.runtime, {
            workspaceId: c.var.workspaceId,
            identity: c.var.identity,
          }),
      )
      // Uploads write to the focused workspace (the validated `X-Workspace-Id`, or
      // the caller's personal workspace when unfocused), under the owner partition —
      // files are workspace-owned. `optionalWorkspace` validates the header.
      .post("/v1/resources", optionalWorkspace(ctx.workspaceStore), uploadLimit, (c) =>
        handleResourceUpload(
          c.req.raw,
          ctx.runtime,
          ctx.features,
          c.var.identity,
          c.var.workspaceId,
        ),
      )
      .get("/v1/apps/:name/resources/*", optionalWorkspace(ctx.workspaceStore), (c) => {
        const name = decodeURIComponent(c.req.param("name"));
        // Extract the full resource path after /resources/
        const url = new URL(c.req.url);
        const prefix = `/v1/apps/${c.req.param("name")}/resources/`;
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
