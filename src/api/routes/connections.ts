import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ConnectionCatalogEntry } from "../../connections/catalog.ts";
import { loadCatalog } from "../../connections/load-catalog.ts";
import { FileCredentialStore } from "../../tools/credential-store.ts";
import { WorkspaceOAuthProvider } from "../../tools/workspace-oauth-provider.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/**
 * Connections page routes — Track C of REMOTE_MCP_CONNECTIONS.md.
 *
 * Three endpoints:
 *
 *   GET  /v1/connections/catalog      catalog filtered by workspace allow-list
 *   GET  /v1/connections/installed    installed bundles + per-principal status
 *   POST /v1/connections/disconnect   revoke + clear tokens (RFC 7009)
 *
 * All workspace-authed via per-handler middleware (sub-app `.use("*")`
 * gated /callback in earlier work; we use the same pattern here).
 */
export function connectionsRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  // ── GET /v1/connections/catalog ────────────────────────────────────
  app.get(
    "/v1/connections/catalog",
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx.workspaceStore),
    async (c) => {
      const wsId = c.var.workspaceId;
      // Catalog loaded once at process start would be nicer, but loadCatalog
      // is cheap (in-memory + optional one-shot file read) and the call
      // count is bounded by user clicks. Lazy is fine.
      const catalog = loadCatalog();
      const ws = await ctx.workspaceStore.get(wsId);
      const allowList = ws?.connectionsAllowList;
      const filtered =
        allowList && Array.isArray(allowList) && allowList.length > 0
          ? catalog.filter((entry) => allowList.includes(entry.id))
          : catalog;
      return c.json({ catalog: filtered });
    },
  );

  // ── GET /v1/connections/installed ──────────────────────────────────
  //
  // Joins:
  //   - workspace.json `bundles[]` (URL bundles only) — what's installed
  //   - the loaded catalog — for display metadata (name, icon, description)
  //   - lifecycle's BundleInstance.connections — per-principal state
  //   - the credential store — to flag missingOperatorSetup for static-auth
  //
  // Returns one entry per installed URL bundle, with both `myConnection`
  // (the caller's per-principal state for member-scope bundles) and
  // `workspaceConnection` (the shared state for workspace-scope) where
  // applicable.
  app.get(
    "/v1/connections/installed",
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx.workspaceStore),
    async (c) => {
      const wsId = c.var.workspaceId;
      const callerId = c.var.identity?.id;
      const ws = await ctx.workspaceStore.get(wsId);
      if (!ws) return c.json({ installed: [] });
      const catalog = loadCatalog();
      const catalogById = new Map(catalog.map((e) => [e.id, e]));
      const lifecycle = ctx.runtime.getLifecycle();

      // Resolve credential store once; we'll check per-static-bundle whether
      // the secret is seeded.
      const workDir = ctx.runtime.getWorkDir();
      const credStore = new FileCredentialStore(workDir);

      const installed: Array<{
        catalogId: string | null;
        serverName: string;
        url: string;
        oauthScope: "workspace" | "member";
        catalog?: ConnectionCatalogEntry;
        myConnection?: {
          state: string;
          authorizationUrl?: string;
          identity?: { sub?: string; email?: string; name?: string };
        };
        workspaceConnection?: {
          state: string;
          authorizationUrl?: string;
        };
        missingOperatorSetup?: boolean;
      }> = [];

      for (const ref of ws.bundles) {
        if (!("url" in ref)) continue;
        const serverName = ref.serverName ?? deriveServerName(ref.url);
        const oauthScope: "workspace" | "member" = ref.oauthScope ?? "workspace";
        // Match catalog by url (id mapping by URL is the cleanest tie —
        // catalog id → url is 1:1; bundle entries don't carry the catalog
        // id directly). Fallback: try matching by serverName (id == serverName).
        const cat =
          catalog.find((e) => e.url === ref.url) ?? catalogById.get(serverName) ?? undefined;

        // Per-principal state lookup via lifecycle.
        const instance = lifecycle.getInstance(serverName, wsId);
        const conns = instance?.connections;

        const entry: (typeof installed)[number] = {
          catalogId: cat?.id ?? null,
          serverName,
          url: ref.url,
          oauthScope,
          ...(cat ? { catalog: cat } : {}),
        };

        if (oauthScope === "member") {
          if (callerId) {
            const conn = conns?.get(callerId);
            if (conn) {
              const myConn: NonNullable<typeof entry.myConnection> = { state: conn.state };
              if (conn.authorizationUrl) myConn.authorizationUrl = conn.authorizationUrl;
              // OIDC identity is per-principal — read from the per-member token dir.
              try {
                const provider = new WorkspaceOAuthProvider({
                  wsId,
                  serverName,
                  workDir,
                  callbackUrl: "http://_/", // placeholder — only reading files
                  memberId: callerId,
                });
                const id = await provider.identity();
                if (id) myConn.identity = id;
              } catch {
                // identity is best-effort cosmetic data
              }
              entry.myConnection = myConn;
            } else {
              entry.myConnection = { state: "not_connected" as const };
            }
          }
        } else {
          const conn = conns?.get("_workspace");
          if (conn) {
            const wsConn: NonNullable<typeof entry.workspaceConnection> = { state: conn.state };
            if (conn.authorizationUrl) wsConn.authorizationUrl = conn.authorizationUrl;
            entry.workspaceConnection = wsConn;
          } else {
            entry.workspaceConnection = { state: "not_connected" as const };
          }
        }

        // Static-auth bundles: check whether the operator has seeded the
        // client_secret. Surfaces the "Configure" affordance to admins.
        if (ref.oauthClient?.clientSecret) {
          const wrapped = await credStore.get(wsId, ref.oauthClient.clientSecret.key);
          if (!wrapped) entry.missingOperatorSetup = true;
        }

        installed.push(entry);
      }

      return c.json({ installed });
    },
  );

  // ── POST /v1/connections/disconnect ────────────────────────────────
  //
  // Body: { serverName, principalId? }
  //   - principalId defaults to the caller's user id for member-scope
  //   - admins can pass "_workspace" to disconnect a workspace-shared bundle
  //
  // Calls WorkspaceOAuthProvider.revokeAndDeleteTokens — best-effort
  // upstream revoke (RFC 7009) + always-delete-locally. Then removes
  // the per-member entry from the MemberPoolSource so the next tool
  // call returns pending_auth.
  app.post(
    "/v1/connections/disconnect",
    requireAuth(ctx.authOptions),
    requireWorkspace(ctx.workspaceStore),
    async (c) => {
      let body: { serverName?: unknown; principalId?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return apiError(400, "bad_request", "Body must be JSON.");
      }
      const serverName = typeof body.serverName === "string" ? body.serverName : "";
      if (!serverName) return apiError(400, "bad_request", "serverName is required.");
      const wsId = c.var.workspaceId;
      const callerId = c.var.identity?.id;

      const lifecycle = ctx.runtime.getLifecycle();
      const instance = lifecycle.getInstance(serverName, wsId);
      if (!instance) {
        return apiError(404, "bundle_not_found", `Bundle "${serverName}" not installed.`);
      }

      const oauthScope = instance.oauthScope ?? "workspace";
      const principalId =
        typeof body.principalId === "string" && body.principalId.length > 0
          ? body.principalId
          : oauthScope === "member"
            ? (callerId ?? "")
            : "_workspace";
      if (oauthScope === "member" && !principalId) {
        return apiError(
          400,
          "bad_request",
          "principalId required for member-scoped bundle (or call as an authenticated member).",
        );
      }

      const ref = instance.ref;
      if (!ref || !("url" in ref)) {
        return apiError(500, "internal_error", "Bundle ref missing — cannot determine OAuth URL.");
      }

      // Disconnect: revoke at AS + delete locally.
      const provider = new WorkspaceOAuthProvider({
        wsId,
        serverName,
        workDir: ctx.runtime.getWorkDir(),
        callbackUrl: "http://_/", // unused for revocation path
        memberId: oauthScope === "member" ? principalId : undefined,
        allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
      });
      const result = await provider.revokeAndDeleteTokens({ bundleUrl: ref.url });

      // Tear down the per-principal source from the pool (member-scope only;
      // workspace-scope bundles need a different teardown — out of scope
      // for this Track C minimum: a future PR can add workspace-disconnect
      // by stopping the McpSource and re-running the boot path).
      if (oauthScope === "member") {
        const pool = lifecycle.getMemberPool(serverName, wsId);
        await pool?.removeMember(principalId);
      }

      // Emit a connection.state_changed so the UI updates immediately.
      lifecycle.recordConnectionStateChange(serverName, wsId, principalId, "stopped");

      return c.json({
        ok: true,
        revoked: result.revoked,
        deletedLocal: result.deletedLocal,
        ...(result.error ? { revokeError: result.error } : {}),
      });
    },
  );

  return app;
}

/** Mirror of `deriveServerName` from src/bundles/paths.ts to avoid a
 *  cross-module dependency. The shape is "host-with-dashes-only". */
function deriveServerName(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  } catch {
    return url;
  }
}

// Silence unused-import warning when no helper is needed.
void homedir;
void join;
