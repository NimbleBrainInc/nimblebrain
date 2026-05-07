import { deriveServerName } from "../bundles/paths.ts";
import type { BundleRef } from "../bundles/types.ts";
import { loadCatalog } from "../connectors/load-catalog.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { DirectoryAggregator } from "../registries/aggregator.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { FileCredentialStore } from "./credential-store.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { WorkspaceOAuthProvider } from "./workspace-oauth-provider.ts";

/**
 * `manage_connectors` tool — single surface for the Connectors UI
 * (catalog browse, list installed, install, disconnect). The platform's
 * MCP-tool-call surface is the canonical first-party API for the web
 * shell, and keeping one tool minimizes route bloat.
 *
 * Two scopes are routed in a single tool by inspecting the catalog
 * entry's `defaultScope` (or, for `list_installed` / `disconnect`,
 * looking up which store the bundle lives in):
 *
 *   - `defaultScope: "workspace"` → `WorkspaceStore.bundles[]` +
 *     `workspaces/<wsId>/credentials/...` for tokens.
 *   - `defaultScope: "user"`      → `UserConnectorStore.bundles[]` +
 *     `users/<userId>/credentials/...` for tokens. Available across
 *     every workspace the user is a member of.
 *
 * The `/v1/mcp-auth/{initiate,callback}` routes stay routes — the
 * initiate path sets a session-bound state cookie before redirecting,
 * and the callback IS a redirect target. Tool-call responses can't
 * deliver either.
 */

export interface ManageConnectorsContext {
  runtime: Runtime;
  /** Returns the requesting user's identity, or null in non-authed contexts. */
  getIdentity: () => UserIdentity | null;
  /** Returns the active workspace id for this call, or null if none. */
  getWorkspaceId: () => string | null;
}

export function createManageConnectorsTool(ctx: ManageConnectorsContext): InProcessTool {
  return {
    name: "manage_connectors",
    description:
      "List, install, and disconnect remote MCP connectors. Workspace connectors are shared by all members; user connectors are personal and follow you across workspaces.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "list_catalog",
            "list_directory",
            "list_installed",
            "list_tools",
            "install",
            "disconnect",
            "uninstall",
            "get_permissions",
            "set_permissions",
            "setup_operator",
            "remove_operator_setup",
          ],
          description: "Action to perform.",
        },
        catalogId: {
          type: "string",
          description:
            "Catalog entry id (required for install, setup_operator, remove_operator_setup).",
        },
        clientId: {
          type: "string",
          description: "OAuth client_id (setup_operator only).",
        },
        clientSecret: {
          type: "string",
          description: "OAuth client_secret (setup_operator only).",
        },
        serverName: {
          type: "string",
          description:
            "Bundle server name (required for disconnect, list_tools, get_permissions, set_permissions).",
        },
        scope: {
          type: "string",
          enum: ["workspace", "user", "all"],
          description:
            "For list_installed: which scope to return (default 'all'). For disconnect / list_tools / get_permissions / set_permissions: which scope's connector to target (auto-detected for disconnect / list_tools when omitted; required for get/set permissions).",
        },
        tools: {
          type: "object",
          description:
            'For set_permissions: map of tool name → "allow" | "disallow". Tools omitted are unchanged.',
          additionalProperties: { type: "string", enum: ["allow", "disallow"] },
        },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      const action = String(input.action ?? "");
      const wsId = ctx.getWorkspaceId();
      const identity = ctx.getIdentity();
      const callerId = identity?.id ?? null;

      switch (action) {
        case "list_catalog":
          return handleListCatalog(ctx, wsId);
        case "list_directory":
          return handleListDirectory(ctx, wsId);
        case "list_installed":
          return handleListInstalled(ctx, wsId, callerId, String(input.scope ?? "all"));
        case "list_tools":
          return handleListTools(
            ctx,
            wsId,
            callerId,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
          );
        case "install":
          return handleInstall(ctx, wsId, callerId, String(input.catalogId ?? ""));
        case "disconnect":
          return handleDisconnect(
            ctx,
            wsId,
            callerId,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
          );
        case "uninstall":
          return handleUninstall(
            ctx,
            wsId,
            callerId,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
          );
        case "get_permissions":
          return handleGetPermissions(
            ctx,
            wsId,
            callerId,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
          );
        case "set_permissions":
          return handleSetPermissions(
            ctx,
            wsId,
            callerId,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
            (input.tools as Record<string, unknown>) ?? {},
          );
        case "setup_operator":
          return handleSetupOperator(
            ctx,
            wsId,
            identity,
            String(input.catalogId ?? ""),
            String(input.clientId ?? ""),
            String(input.clientSecret ?? ""),
          );
        case "remove_operator_setup":
          return handleRemoveOperatorSetup(ctx, wsId, identity, String(input.catalogId ?? ""));
        default:
          return errResult(`Unknown action "${action}".`);
      }
    },
  };
}

// ── Action handlers ──────────────────────────────────────────────────

async function handleListCatalog(
  ctx: ManageConnectorsContext,
  wsId: string | null,
): Promise<ToolResult> {
  const catalog = loadCatalog();
  const ws = wsId ? await ctx.runtime.getWorkspaceStore().get(wsId) : null;
  const allowList = ws?.connectorsAllowList;
  const filtered =
    allowList && Array.isArray(allowList) && allowList.length > 0
      ? catalog.filter((entry) => allowList.includes(entry.id))
      : catalog;
  return {
    content: textContent(`Catalog: ${filtered.length} entries.`),
    structuredContent: { catalog: filtered },
    isError: false,
  };
}

/**
 * Aggregate every enabled registry's entries into a single browseable
 * directory. Replaces the catalog-only `list_catalog` for the Browse
 * page — Browse needs the unified shape so mpak bundles and curated
 * remote services render side-by-side.
 *
 * Per-registry failures are isolated and surfaced in `errors` so the
 * UI can show partial results with a "missing X" hint. Workspace
 * `connectorsAllowList` filters apply only to curated entries today
 * (mpak hasn't shipped its scoping primitive yet).
 */
async function handleListDirectory(
  ctx: ManageConnectorsContext,
  wsId: string | null,
): Promise<ToolResult> {
  const aggregator = new DirectoryAggregator(ctx.runtime.getRegistryStore());

  // Hoist the workspace fetch + credential-store handle out of the
  // closure so the closure does at most one disk read per static-auth
  // catalog entry. With it inlined the Browse page would fan out to
  // ~10 sequential reads (one workspace.json + one credential probe
  // per static-auth entry) on every load — N+1 and growing with the
  // catalog.
  const ws = wsId ? await ctx.runtime.getWorkspaceStore().get(wsId) : null;
  const credStore = wsId ? new FileCredentialStore(ctx.runtime.getWorkDir()) : null;
  const isOperatorConfigured =
    wsId && ws && credStore
      ? async (catalogId: string, clientSecretKey: string): Promise<boolean> => {
          if (!ws.oauthOperatorApps?.[catalogId]?.clientId) return false;
          const secret = await credStore.get(wsId, clientSecretKey);
          return secret !== null;
        }
      : undefined;

  const result = await aggregator.list({
    ...(wsId ? { wsId } : {}),
    ...(isOperatorConfigured ? { isOperatorConfigured } : {}),
  });
  return {
    content: textContent(
      `Directory: ${result.entries.length} entries (${result.errors.length} registry errors).`,
    ),
    structuredContent: { entries: result.entries, errors: result.errors },
    isError: false,
  };
}

async function handleListInstalled(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  scope: string,
): Promise<ToolResult> {
  const lifecycle = ctx.runtime.getLifecycle();
  const workDir = ctx.runtime.getWorkDir();
  const credStore = new FileCredentialStore(workDir);
  const catalog = loadCatalog();
  const catalogByUrl = new Map(catalog.map((e) => [e.url, e]));

  type InstalledEntry = {
    serverName: string;
    bundleName: string;
    version: string;
    type: "remote" | "local";
    state: string;
    scope: "workspace" | "user";
    interactive: boolean;
    toolCount: number;
    trustScore: number | null;
    // Optional — only populated for URL bundles / catalog-matched entries
    url?: string;
    catalogId?: string | null;
    catalog?: (typeof catalog)[number];
    authorizationUrl?: string;
    identity?: { sub?: string; email?: string; name?: string };
    missingOperatorSetup?: boolean;
  };
  const installed: InstalledEntry[] = [];

  // Workspace-scope entries: walk every bundle visible in the workspace
  // registry (includes local stdio, local URL, Synapse apps, and remote
  // OAuth). This is the same view the About tab uses via list_apps.
  if ((scope === "all" || scope === "workspace") && wsId) {
    const registry = ctx.runtime.getRegistryForWorkspace(wsId);
    for (const instance of ctx.runtime.getBundleInstancesForWorkspace(wsId)) {
      // Skip user-scope URL bundles seeded into the workspace registry
      // via UserPoolSource — those belong to the user-scope view.
      if (instance.oauthScope === "user") continue;

      const ref = instance.ref;
      const isRemote = !!ref && "url" in ref;
      const url = isRemote ? (ref as { url: string }).url : undefined;
      const cat = url ? catalogByUrl.get(url) : undefined;

      // Tool count + interactive — best-effort (a stopped source returns []).
      let toolCount = 0;
      try {
        const src = registry.getSource(instance.serverName);
        if (src) toolCount = (await src.tools()).length;
      } catch {
        // ignore
      }
      const interactive =
        cat?.interactive === true ||
        (Array.isArray(instance.ui?.placements) && instance.ui.placements.length > 0);

      const entry: InstalledEntry = {
        serverName: instance.serverName,
        bundleName: instance.bundleName,
        version: instance.version,
        type: isRemote ? "remote" : "local",
        state: instance.state,
        scope: "workspace",
        interactive,
        toolCount,
        trustScore: instance.trustScore ?? null,
      };

      if (isRemote && url) {
        entry.url = url;
        entry.catalogId = cat?.id ?? null;
        if (cat) entry.catalog = cat;
        const conn = instance.connections?.get("_workspace") ?? null;
        if (conn?.authorizationUrl) entry.authorizationUrl = conn.authorizationUrl;
        // Static-auth missing-operator-setup probe.
        const oauthClient = (ref as { oauthClient?: { clientSecret?: { key: string } } })
          .oauthClient;
        if (oauthClient?.clientSecret) {
          const wrapped = await credStore.get(wsId, oauthClient.clientSecret.key);
          if (!wrapped) entry.missingOperatorSetup = true;
        }
      }
      installed.push(entry);
    }
  }

  // User-scope entries (caller's own personal connectors). User scope
  // doesn't have a "local" path today — every user-scope bundle is a
  // URL connector with OAuth.
  if ((scope === "all" || scope === "user") && callerId) {
    const userRecord = await ctx.runtime.getUserConnectorStore().get(callerId);
    if (userRecord) {
      for (const ref of userRecord.bundles) {
        if (!("url" in ref)) continue;
        const serverName = ref.serverName ?? deriveServerName(ref.url);
        const userInstance = lifecycle.getUserInstance?.(serverName, callerId) ?? null;
        const conn = userInstance?.connections?.get(callerId) ?? null;
        const cat = catalogByUrl.get(ref.url);

        const interactive =
          cat?.interactive === true ||
          (Array.isArray(ref.ui?.placements) && ref.ui.placements.length > 0);

        const entry: InstalledEntry = {
          serverName,
          bundleName: serverName,
          version: userInstance?.version ?? "remote",
          type: "remote",
          state: conn?.state ?? userInstance?.state ?? "not_authenticated",
          scope: "user",
          interactive,
          toolCount: 0,
          trustScore: userInstance?.trustScore ?? null,
          url: ref.url,
          catalogId: cat?.id ?? null,
          ...(cat ? { catalog: cat } : {}),
          ...(conn?.authorizationUrl ? { authorizationUrl: conn.authorizationUrl } : {}),
        };

        // Read OIDC identity for the user's own provider, best-effort.
        try {
          const provider = new WorkspaceOAuthProvider({
            owner: { type: "user", userId: callerId },
            serverName,
            workDir,
            callbackUrl: "http://_/",
          });
          const id = await provider.identity();
          if (id) entry.identity = id;
        } catch {
          // best-effort cosmetic data
        }
        installed.push(entry);
      }
    }
  }

  return {
    content: textContent(`Installed: ${installed.length} entries.`),
    structuredContent: { installed },
    isError: false,
  };
}

async function handleInstall(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  catalogId: string,
): Promise<ToolResult> {
  if (!catalogId) return errResult("catalogId is required.");

  // Catalog-driven scope dispatch. Every catalog entry has a defaultScope;
  // we don't currently support overriding at install time (a possible
  // future feature: admin promotes a default-user entry to workspace).
  const catalog = loadCatalog();
  const entry = catalog.find((e) => e.id === catalogId);
  if (!entry) return errResult(`Catalog entry "${catalogId}" not found.`);

  // Workspace allow-list applies regardless of scope — the workspace
  // operator can constrain what services are even visible.
  if (wsId) {
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    const allowList = ws?.connectorsAllowList;
    if (allowList && Array.isArray(allowList) && allowList.length > 0) {
      if (!allowList.includes(entry.id)) {
        return errResult(`Catalog entry "${catalogId}" not visible in this workspace.`);
      }
    }
  }

  // Static-auth: must have operator setup (workspace.json#oauthOperatorApps
  // for the public clientId + credential store for the secret) before any
  // user can install. We resolve the operator config here and refuse early
  // with a clear next-step message if either piece is missing — same
  // shape as the missingOperatorSetup signal Browse uses to gate its
  // affordance.
  let staticOAuthClient: { clientId: string; clientSecretKey: string } | undefined;
  if (entry.auth === "static") {
    const setup = entry.operatorSetup;
    if (!setup) {
      return errResult(
        `Catalog entry "${catalogId}" is malformed: static auth requires operatorSetup.`,
      );
    }
    if (!wsId) return errResult("Workspace context required for static-auth install.");
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    if (!ws) return errResult(`Workspace "${wsId}" not found.`);
    const operatorApp = ws.oauthOperatorApps?.[entry.id];
    if (!operatorApp?.clientId) {
      return errResult(
        `"${entry.name}" needs operator setup before install. Configure the OAuth app at ${setup.portalUrl} and use Set up.`,
      );
    }
    const credStore = new FileCredentialStore(ctx.runtime.getWorkDir());
    const secret = await credStore.get(wsId, setup.clientSecretKey);
    if (!secret) {
      return errResult(
        `Operator client_secret for "${entry.name}" is missing — re-run Set up to seed it.`,
      );
    }
    staticOAuthClient = {
      clientId: operatorApp.clientId,
      clientSecretKey: setup.clientSecretKey,
    };
  }

  const ref: BundleRef = {
    url: entry.url,
    serverName: entry.id,
    oauthScope: entry.defaultScope,
    ...(entry.requiredScopes ? { scopes: entry.requiredScopes } : {}),
    ...(entry.additionalAuthorizationParams
      ? { additionalAuthorizationParams: entry.additionalAuthorizationParams }
      : {}),
    ...(staticOAuthClient
      ? {
          oauthClient: {
            clientId: staticOAuthClient.clientId,
            clientSecret: { ref: "credential", key: staticOAuthClient.clientSecretKey },
          },
        }
      : {}),
  };

  const lifecycle = ctx.runtime.getLifecycle();

  if (entry.defaultScope === "workspace") {
    if (!wsId) return errResult("Workspace context required for workspace-scope install.");
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    if (!ws) return errResult(`Workspace "${wsId}" not found.`);

    const dup = ws.bundles.find((b) => "url" in b && b.url === entry.url);
    if (dup) {
      const dupServerName = "serverName" in dup ? (dup.serverName ?? entry.id) : entry.id;
      // Self-heal: if workspace.json has the entry but lifecycle lost
      // track of the instance (e.g., a prior uninstall that didn't
      // clean workspace.json), re-seed instead of reporting it as
      // already-installed. Returning alreadyInstalled in that state
      // would skip seedInstance and fail the next OAuth initiate.
      if (!lifecycle.getInstance(dupServerName, wsId)) {
        const wsRegistry = ctx.runtime.getRegistryForWorkspace(wsId);
        lifecycle.seedInstance(
          dupServerName,
          entry.url,
          dup,
          undefined,
          wsId,
          undefined,
          wsRegistry,
        );
        return {
          content: textContent(`Reattached "${entry.name}" (recovered orphan entry).`),
          structuredContent: {
            ok: true,
            alreadyInstalled: false,
            serverName: dupServerName,
            scope: "workspace",
          },
          isError: false,
        };
      }
      return {
        content: textContent(`"${entry.name}" already installed.`),
        structuredContent: {
          ok: true,
          alreadyInstalled: true,
          serverName: dupServerName,
          scope: "workspace",
        },
        isError: false,
      };
    }
    await ctx.runtime.getWorkspaceStore().update(wsId, { bundles: [...ws.bundles, ref] });
    const wsRegistry = ctx.runtime.getRegistryForWorkspace(wsId);
    lifecycle.seedInstance(entry.id, entry.url, ref, undefined, wsId, undefined, wsRegistry);
    return {
      content: textContent(`Installed "${entry.name}" for this workspace.`),
      structuredContent: {
        ok: true,
        alreadyInstalled: false,
        serverName: entry.id,
        scope: "workspace",
      },
      isError: false,
    };
  }

  // User scope
  if (!callerId) {
    return errResult("Authentication required to install personal connectors.");
  }
  const userStore = ctx.runtime.getUserConnectorStore();
  const existing = await userStore.get(callerId);
  const dup = existing?.bundles.find((b) => "url" in b && b.url === entry.url);
  if (dup) {
    const dupServerName = "serverName" in dup ? (dup.serverName ?? entry.id) : entry.id;
    // Self-heal symmetric to workspace scope: if user.json has the
    // entry but lifecycle has no userInstance, re-seed.
    if (!lifecycle.getUserInstance?.(dupServerName, callerId)) {
      await lifecycle.seedUserInstance?.(dupServerName, dup, callerId);
      return {
        content: textContent(`Reattached "${entry.name}" (recovered orphan entry).`),
        structuredContent: {
          ok: true,
          alreadyInstalled: false,
          serverName: dupServerName,
          scope: "user",
        },
        isError: false,
      };
    }
    return {
      content: textContent(`"${entry.name}" already installed for your account.`),
      structuredContent: {
        ok: true,
        alreadyInstalled: true,
        serverName: dupServerName,
        scope: "user",
      },
      isError: false,
    };
  }
  await userStore.addBundle(callerId, ref);
  // Seed the user-scope BundleInstance + register with every workspace
  // registry the user is a member of. Done by lifecycle so the boot-time
  // path (where we discover personal bundles for active members) and the
  // install-time path (where we wire one new bundle in) share code.
  await lifecycle.seedUserInstance?.(entry.id, ref, callerId);
  return {
    content: textContent(
      `Installed "${entry.name}" for your account. Available in every workspace you're in.`,
    ),
    structuredContent: {
      ok: true,
      alreadyInstalled: false,
      serverName: entry.id,
      scope: "user",
    },
    isError: false,
  };
}

async function handleDisconnect(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const lifecycle = ctx.runtime.getLifecycle();

  // Auto-detect scope unless caller specified. Workspace-scope wins on
  // ambiguity (same serverName installed both places — extremely rare;
  // the catalog naming convention prevents it in practice).
  let scope: "workspace" | "user" | undefined;
  if (scopeHint === "workspace" || scopeHint === "user") {
    scope = scopeHint;
  } else if (wsId && lifecycle.getInstance(serverName, wsId)) {
    scope = "workspace";
  } else if (callerId && lifecycle.getUserInstance?.(serverName, callerId)) {
    scope = "user";
  }
  if (!scope) {
    return errResult(`Bundle "${serverName}" not installed.`);
  }

  if (scope === "workspace") {
    if (!wsId) return errResult("Workspace context required.");
    try {
      const result = await lifecycle.disconnect(serverName, wsId, "_workspace", {
        workDir: ctx.runtime.getWorkDir(),
        allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
      });
      return {
        content: textContent(`Disconnected "${serverName}" from workspace.`),
        structuredContent: { ok: true, scope: "workspace", ...result },
        isError: false,
      };
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err));
    }
  }

  // User scope
  if (!callerId) return errResult("Authentication required.");
  try {
    const result = await lifecycle.disconnectUser?.(serverName, callerId, {
      workDir: ctx.runtime.getWorkDir(),
      allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
    });
    if (!result) return errResult("User-scope disconnect not implemented.");
    return {
      content: textContent(`Disconnected "${serverName}" from your account.`),
      structuredContent: { ok: true, scope: "user", ...result },
      isError: false,
    };
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Uninstall a connector — full removal. For OAuth-protected URL bundles
 * we revoke tokens upstream first (so the user's grant in the vendor
 * portal is cleaned up), then `lifecycle.uninstall` stops the source,
 * removes the entry from `workspace.json`, clears credentials, and
 * unregisters placements. For local bundles (stdio / non-OAuth URL),
 * just `lifecycle.uninstall`.
 *
 * User-scope: disconnectUser revokes + tears down. There is no user
 * equivalent of `lifecycle.uninstall` because user-scope bundles live
 * in `users/<id>/user.json`, not workspace.json — disconnect is the
 * uninstall.
 */
async function handleUninstall(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const lifecycle = ctx.runtime.getLifecycle();

  let scope: "workspace" | "user" | undefined;
  if (scopeHint === "workspace" || scopeHint === "user") {
    scope = scopeHint;
  } else if (wsId && lifecycle.getInstance(serverName, wsId)) {
    scope = "workspace";
  } else if (callerId && lifecycle.getUserInstance?.(serverName, callerId)) {
    scope = "user";
  }
  if (!scope) {
    return errResult(`Bundle "${serverName}" not installed.`);
  }

  if (scope === "workspace") {
    if (!wsId) return errResult("Workspace context required.");
    const instance = lifecycle.getInstance(serverName, wsId);
    const ref = instance?.ref;
    const isUrlBundle = !!ref && "url" in ref;
    let revokeResult: { revoked?: { access?: boolean; refresh?: boolean }; revokeError?: string } =
      {};

    // Revoke OAuth tokens upstream first when applicable. Best-effort —
    // a 4xx from the provider shouldn't block local cleanup, since the
    // user's intent is "I want this gone."
    if (isUrlBundle) {
      try {
        const r = await lifecycle.disconnect(serverName, wsId, "_workspace", {
          workDir: ctx.runtime.getWorkDir(),
          allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
        });
        revokeResult = {
          revoked: r.revoked,
          ...(r.revokeError ? { revokeError: r.revokeError } : {}),
        };
      } catch (err) {
        revokeResult = { revokeError: err instanceof Error ? err.message : String(err) };
      }
    }

    try {
      const registry = ctx.runtime.getRegistryForWorkspace(wsId);
      await lifecycle.uninstall(serverName, registry, wsId);
      // lifecycle.uninstall clears its own `instances` map and removes
      // from the legacy global `nimblebrain.json`, but it does NOT
      // touch `workspace.json#bundles[]` — that array was added later
      // for catalog-installed connectors. Without this cleanup, a
      // re-install attempt sees the leftover bundle, treats it as
      // already-installed, skips seedInstance, and the next OAuth
      // initiate fails with "Bundle X not installed."
      const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
      if (ws) {
        const filtered = ws.bundles.filter((b) => {
          if (!("url" in b)) return true;
          const sn = b.serverName ?? deriveServerName(b.url);
          return sn !== serverName;
        });
        if (filtered.length !== ws.bundles.length) {
          await ctx.runtime.getWorkspaceStore().update(wsId, { bundles: filtered });
        }
      }
      // Drop tool permissions for this connector — they have no meaning
      // once the bundle is gone.
      await ctx.runtime
        .getPermissionStore()
        .deleteConnector({ scope: "workspace", wsId }, serverName);
      return {
        content: textContent(`Uninstalled "${serverName}" from workspace.`),
        structuredContent: { ok: true, scope: "workspace", serverName, ...revokeResult },
        isError: false,
      };
    } catch (err) {
      return errResult(err instanceof Error ? err.message : String(err));
    }
  }

  // User scope — symmetric to workspace. disconnectUser revokes
  // tokens upstream and removes the per-user McpSource from every
  // workspace pool. Then we have to remove the entry from
  // `users/<id>/user.json` ourselves; lifecycle.disconnectUser doesn't
  // touch that file (parallel to the workspace.json gap above), so
  // skipping this leaves a stale ref that breaks reinstall.
  if (!callerId) return errResult("Authentication required.");
  try {
    const result = await lifecycle.disconnectUser?.(serverName, callerId, {
      workDir: ctx.runtime.getWorkDir(),
      allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
    });
    if (!result) return errResult("User-scope uninstall not implemented.");

    const userStore = ctx.runtime.getUserConnectorStore();
    const record = await userStore.get(callerId);
    if (record) {
      const filtered = record.bundles.filter((b) => {
        if (!("url" in b)) return true;
        const sn = b.serverName ?? deriveServerName(b.url);
        return sn !== serverName;
      });
      if (filtered.length !== record.bundles.length) {
        await userStore.update(callerId, { bundles: filtered });
      }
    }

    await ctx.runtime
      .getPermissionStore()
      .deleteConnector({ scope: "user", userId: callerId }, serverName);
    return {
      content: textContent(`Uninstalled "${serverName}" from your account.`),
      structuredContent: { ok: true, scope: "user", serverName, ...result },
      isError: false,
    };
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read the live tools/list for an installed connector. Used by the
 * Configure detail page to render the per-tool permission table —
 * tool descriptors come from `tools/list` on the live MCP source, not
 * from the catalog (catalog has no tool-level metadata).
 *
 * Workspace-scope routes through the workspace's principal connection;
 * user-scope through the caller's own user-scope instance. Cross-user
 * inspection is not supported (a user can't list someone else's
 * connector tools).
 */
async function handleListTools(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const lifecycle = ctx.runtime.getLifecycle();

  let scope: "workspace" | "user" | undefined;
  if (scopeHint === "workspace" || scopeHint === "user") {
    scope = scopeHint;
  } else if (wsId && lifecycle.getInstance(serverName, wsId)) {
    scope = "workspace";
  } else if (callerId && lifecycle.getUserInstance?.(serverName, callerId)) {
    scope = "user";
  }
  if (!scope) {
    return errResult(`Bundle "${serverName}" not installed.`);
  }

  // Resolve the live source from the workspace registry. The registry
  // owns the actual McpSource — workspace-scope bundles add it via
  // startBundleSource at boot; user-scope bundles register a
  // UserPoolSource at boot and per-user McpSources lazily. The
  // connections map's `source` field is only populated on the user
  // flow path (startAuth) and stays null for boot-restored bundles
  // even though the bundle is fully running.
  if (!wsId) return errResult("Workspace context required.");
  const registry = ctx.runtime.getRegistryForWorkspace(wsId);
  const source = registry.getSource(serverName);
  if (!source) {
    const instance =
      scope === "workspace"
        ? lifecycle.getInstance(serverName, wsId)
        : (lifecycle.getUserInstance?.(serverName, callerId ?? "") ?? null);
    return errResult(
      `Connector "${serverName}" not registered (state: ${instance?.state ?? "unknown"}).`,
    );
  }

  try {
    // For user-scope (UserPoolSource), tools() needs to resolve a per-
    // user source. Fall through naturally: UserPoolSource.tools() picks
    // any registered user's source as a representative.
    const tools = await source.tools();
    // Strip the connector prefix from tool names. McpSource adds it
    // (`<serverName>__<bareName>`) for the registry's dispatch surface,
    // but the Configure page only handles tools within one connector
    // and the permission store keys on bare names. Normalize at the API
    // boundary so consumers don't see a leak of the internal prefixing.
    const prefix = `${serverName}__`;
    return {
      content: textContent(`Tools: ${tools.length}`),
      structuredContent: {
        tools: tools.map((t) => ({
          name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
      isError: false,
    };
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve a scope+owner pair for permission read/write. User scope reads
 * the caller's own permissions; workspace scope reads the active
 * workspace's. Returns null on missing context.
 */
function resolvePermissionOwner(
  wsId: string | null,
  callerId: string | null,
  scopeHint: string | undefined,
): { scope: "workspace"; wsId: string } | { scope: "user"; userId: string } | null {
  const scope: "workspace" | "user" =
    scopeHint === "workspace" || scopeHint === "user" ? scopeHint : "workspace";
  if (scope === "workspace") {
    return wsId ? { scope: "workspace", wsId } : null;
  }
  return callerId ? { scope: "user", userId: callerId } : null;
}

async function handleGetPermissions(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const owner = resolvePermissionOwner(wsId, callerId, scopeHint);
  if (!owner) return errResult("Could not resolve permission owner — sign in or pick a workspace.");

  const tools = await ctx.runtime.getPermissionStore().getConnector(owner, serverName);
  return {
    content: textContent(`Permissions: ${Object.keys(tools).length} non-default entries.`),
    structuredContent: { scope: owner.scope, serverName, tools },
    isError: false,
  };
}

async function handleSetPermissions(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
  scopeHint: string | undefined,
  toolsInput: Record<string, unknown>,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const owner = resolvePermissionOwner(wsId, callerId, scopeHint);
  if (!owner) return errResult("Could not resolve permission owner — sign in or pick a workspace.");

  // Reject unknown serverName up front. Permission entries for a
  // non-existent connector would sit unused (the runtime gate keys on
  // installed-source dispatch); failing fast here surfaces typos at
  // write time instead of letting them rot in the store.
  const lifecycle = ctx.runtime.getLifecycle();
  const installedHere =
    owner.scope === "workspace"
      ? lifecycle.getInstance(serverName, owner.wsId) != null
      : (lifecycle.getUserInstance?.(serverName, owner.userId) ?? null) != null;
  if (!installedHere) {
    return errResult(`Connector "${serverName}" is not installed in ${owner.scope} scope.`);
  }

  const tools: Record<string, "allow" | "disallow"> = {};
  for (const [name, raw] of Object.entries(toolsInput)) {
    if (raw === "allow" || raw === "disallow") {
      tools[name] = raw;
    } else {
      return errResult(`Invalid policy for "${name}": must be "allow" or "disallow".`);
    }
  }
  await ctx.runtime.getPermissionStore().setConnector(owner, serverName, tools);
  return {
    content: textContent(`Updated ${Object.keys(tools).length} tool policies.`),
    structuredContent: { ok: true, scope: owner.scope, serverName },
    isError: false,
  };
}

/**
 * Configure (or rotate) the OAuth app credentials a workspace will use
 * to authenticate against a static-auth catalog connector. Two stores
 * write together so the next install of this connector finds both
 * pieces:
 *
 *   - workspace.json#oauthOperatorApps[catalogId] gets the public
 *     `client_id` plus an audit trail (who configured it, when).
 *   - The credential store gets the `client_secret` under the catalog
 *     entry's declared `clientSecretKey`.
 *
 * Upsert semantics — calling this on an already-configured catalog
 * entry rotates both credentials. The clientId can change (e.g.,
 * operator rebuilt the OAuth app); the secret always rotates whenever
 * the modal is submitted (the modal pre-fills the clientId for ease,
 * but never the secret — security posture: don't echo secrets).
 *
 * Gated to workspace-admin and above. Workspace admins are the right
 * principal because OAuth app config is workspace-level (each
 * workspace creates its own OAuth app at the vendor's portal).
 */
async function handleSetupOperator(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  catalogId: string,
  clientId: string,
  clientSecret: string,
): Promise<ToolResult> {
  if (!wsId) return errResult("Workspace context required.");
  if (!catalogId) return errResult("catalogId is required.");
  if (!clientId.trim()) return errResult("clientId is required.");
  if (!clientSecret.trim()) return errResult("clientSecret is required.");

  if (!identity) return errResult("Authentication required.");

  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return errResult(`Workspace "${wsId}" not found.`);
  if (!isWorkspaceAdmin(ws, identity)) {
    return {
      content: textContent("Workspace admin role required to configure OAuth apps."),
      structuredContent: { error: "permission_denied" },
      isError: true,
    };
  }

  const catalog = loadCatalog();
  const entry = catalog.find((e) => e.id === catalogId);
  if (!entry) return errResult(`Catalog entry "${catalogId}" not found.`);
  if (entry.auth !== "static") {
    return errResult(`"${entry.name}" is a DCR connector — operator setup not required.`);
  }
  const clientSecretKey = entry.operatorSetup?.clientSecretKey;
  if (!clientSecretKey) {
    return errResult(
      `Catalog entry "${catalogId}" is malformed: missing operatorSetup.clientSecretKey.`,
    );
  }

  // Persist secret first — if the credential store write fails, we
  // haven't touched workspace.json yet, so there's nothing to roll back.
  const credStore = new FileCredentialStore(ctx.runtime.getWorkDir());
  await credStore.put(wsId, clientSecretKey, clientSecret.trim());

  // Stamp the public clientId + audit trail into workspace.json.
  const apps = { ...(ws.oauthOperatorApps ?? {}) };
  apps[catalogId] = {
    clientId: clientId.trim(),
    configuredAt: new Date().toISOString(),
    configuredBy: identity.id,
  };
  await ctx.runtime.getWorkspaceStore().update(wsId, { oauthOperatorApps: apps });

  return {
    content: textContent(`Configured OAuth app for "${entry.name}".`),
    structuredContent: { ok: true, catalogId, clientId: apps[catalogId]?.clientId },
    isError: false,
  };
}

/**
 * Drop a workspace's operator OAuth app config. Both halves removed in
 * lockstep — workspace.json entry deleted and the credential store's
 * client_secret cleared.
 *
 * Refuses to run while the connector is currently installed. The right
 * mental model: operator setup is a *prerequisite* for install, not a
 * peer of it. Removing setup while the bundle is live would orphan the
 * BundleRef's credential pointer — the next OAuth round-trip would 404
 * mid-flow. Caller uninstalls first, then removes setup.
 */
async function handleRemoveOperatorSetup(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  catalogId: string,
): Promise<ToolResult> {
  if (!wsId) return errResult("Workspace context required.");
  if (!catalogId) return errResult("catalogId is required.");
  if (!identity) return errResult("Authentication required.");

  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return errResult(`Workspace "${wsId}" not found.`);
  if (!isWorkspaceAdmin(ws, identity)) {
    return {
      content: textContent("Workspace admin role required to remove OAuth app config."),
      structuredContent: { error: "permission_denied" },
      isError: true,
    };
  }

  const catalog = loadCatalog();
  const entry = catalog.find((e) => e.id === catalogId);
  if (!entry) return errResult(`Catalog entry "${catalogId}" not found.`);

  // Guard: refuse if the connector is currently installed. Removing
  // operator config out from under a live bundle leaves a dangling
  // credential reference; force the operator through the explicit
  // uninstall path first.
  const installed = ws.bundles.some((b) => "url" in b && b.url === entry.url);
  if (installed) {
    return errResult(
      `"${entry.name}" is installed — uninstall it first, then remove the OAuth app config.`,
    );
  }

  const apps = { ...(ws.oauthOperatorApps ?? {}) };
  if (!apps[catalogId]) {
    return errResult(`No operator setup configured for "${entry.name}".`);
  }
  delete apps[catalogId];
  await ctx.runtime.getWorkspaceStore().update(wsId, { oauthOperatorApps: apps });

  const clientSecretKey = entry.operatorSetup?.clientSecretKey;
  if (clientSecretKey) {
    const credStore = new FileCredentialStore(ctx.runtime.getWorkDir());
    await credStore.delete(wsId, clientSecretKey).catch(() => {});
  }

  return {
    content: textContent(`Removed OAuth app config for "${entry.name}".`),
    structuredContent: { ok: true, catalogId },
    isError: false,
  };
}

/**
 * Workspace admin gate. Returns true if the identity is a workspace
 * admin — explicitly via `members[].role === "admin"`, or implicitly
 * because their org role (admin / owner) outranks any per-workspace
 * gate. Workspace member without an admin role gets denied.
 *
 * Defensive against a malformed workspace record (missing `members`
 * array): an org admin / owner still gets through; otherwise we
 * deny rather than throwing. The right "fail closed" posture for an
 * authorization helper.
 */
function isWorkspaceAdmin(
  ws: { members?: Array<{ userId: string; role: string }> },
  identity: UserIdentity,
): boolean {
  if (identity.orgRole === "admin" || identity.orgRole === "owner") return true;
  const members = Array.isArray(ws.members) ? ws.members : [];
  const member = members.find((m) => m.userId === identity.id);
  return member?.role === "admin";
}

function errResult(msg: string): ToolResult {
  return { content: textContent(msg), isError: true };
}
