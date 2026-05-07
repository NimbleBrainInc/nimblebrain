import { deriveServerName } from "../bundles/paths.ts";
import type { BundleRef } from "../bundles/types.ts";
import { loadCatalog } from "../connections/load-catalog.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { FileCredentialStore } from "./credential-store.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { WorkspaceOAuthProvider } from "./workspace-oauth-provider.ts";

/**
 * `manage_connections` tool — single surface for the Connections UI
 * (catalog browse, list installed, install, disconnect). Replaces the
 * previous `/v1/connections/*` REST routes; the platform's MCP-tool-call
 * surface is the canonical first-party API for the web shell, and
 * keeping one tool minimizes route bloat.
 *
 * Two scopes are routed in a single tool by inspecting the catalog
 * entry's `defaultScope` (or, for `list_installed` / `disconnect`,
 * looking up which store the bundle lives in):
 *
 *   - `defaultScope: "workspace"` → `WorkspaceStore.bundles[]` +
 *     `workspaces/<wsId>/credentials/...` for tokens.
 *   - `defaultScope: "user"`      → `UserConnectionStore.bundles[]` +
 *     `users/<userId>/credentials/...` for tokens. Available across
 *     every workspace the user is a member of.
 *
 * The `/v1/mcp-auth/{initiate,callback}` routes stay routes — the
 * initiate path sets a session-bound state cookie before redirecting,
 * and the callback IS a redirect target. Tool-call responses can't
 * deliver either.
 */

export interface ManageConnectionsContext {
  runtime: Runtime;
  /** Returns the requesting user's identity, or null in non-authed contexts. */
  getIdentity: () => UserIdentity | null;
  /** Returns the active workspace id for this call, or null if none. */
  getWorkspaceId: () => string | null;
}

export function createManageConnectionsTool(ctx: ManageConnectionsContext): InProcessTool {
  return {
    name: "manage_connections",
    description:
      "List, install, and disconnect remote MCP connections. Workspace connections are shared by all members; user connections are personal and follow you across workspaces.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list_catalog", "list_installed", "install", "disconnect"],
          description: "Action to perform.",
        },
        catalogId: {
          type: "string",
          description: "Catalog entry id (required for install).",
        },
        serverName: {
          type: "string",
          description: "Bundle server name (required for disconnect).",
        },
        scope: {
          type: "string",
          enum: ["workspace", "user", "all"],
          description:
            "For list_installed: which scope to return (default 'all'). For disconnect: which scope's connection to revoke (auto-detected if omitted).",
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
        case "list_installed":
          return handleListInstalled(ctx, wsId, callerId, String(input.scope ?? "all"));
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
        default:
          return errResult(`Unknown action "${action}".`);
      }
    },
  };
}

// ── Action handlers ──────────────────────────────────────────────────

async function handleListCatalog(
  ctx: ManageConnectionsContext,
  wsId: string | null,
): Promise<ToolResult> {
  const catalog = loadCatalog();
  const ws = wsId ? await ctx.runtime.getWorkspaceStore().get(wsId) : null;
  const allowList = ws?.connectionsAllowList;
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

async function handleListInstalled(
  ctx: ManageConnectionsContext,
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
    catalogId: string | null;
    serverName: string;
    url: string;
    scope: "workspace" | "user";
    catalog?: (typeof catalog)[number];
    state: string;
    authorizationUrl?: string;
    identity?: { sub?: string; email?: string; name?: string };
    missingOperatorSetup?: boolean;
  };
  const installed: InstalledEntry[] = [];

  // Workspace-scope entries
  if ((scope === "all" || scope === "workspace") && wsId) {
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    if (ws) {
      for (const ref of ws.bundles) {
        if (!("url" in ref)) continue;
        const declared = ref.oauthScope ?? "workspace";
        if (declared !== "workspace") continue;
        const serverName = ref.serverName ?? deriveServerName(ref.url);
        const entry = await buildInstalledEntry({
          ref,
          serverName,
          scope: "workspace",
          catalogByUrl,
          conn: lifecycle.getInstance(serverName, wsId)?.connections?.get("_workspace") ?? null,
          credStore,
          ownerIdForCreds: wsId,
        });
        installed.push(entry);
      }
    }
  }

  // User-scope entries (caller's own personal connections)
  if ((scope === "all" || scope === "user") && callerId) {
    const userRecord = await ctx.runtime.getUserConnectionStore().get(callerId);
    if (userRecord) {
      for (const ref of userRecord.bundles) {
        if (!("url" in ref)) continue;
        const serverName = ref.serverName ?? deriveServerName(ref.url);
        // For user-scope, BundleInstance lives in lifecycle keyed by
        // (serverName, userId) — see lifecycle for the parallel map.
        const userInstance = lifecycle.getUserInstance?.(serverName, callerId) ?? null;
        const conn = userInstance?.connections?.get(callerId) ?? null;
        const entry = await buildInstalledEntry({
          ref,
          serverName,
          scope: "user",
          catalogByUrl,
          conn,
          credStore,
          // Static-auth user-scope still resolves operator setup via
          // workspace credential store (per-workspace operator app).
          // For now, skip the operator-setup check for user scope.
          ownerIdForCreds: null,
        });
        // Read OIDC identity for the user's own provider, best-effort.
        try {
          const provider = new WorkspaceOAuthProvider({
            owner: { type: "user", userId: callerId },
            serverName,
            workDir,
            callbackUrl: "http://_/", // placeholder — only reading files
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

async function buildInstalledEntry(args: {
  ref: BundleRef & { url: string };
  serverName: string;
  scope: "workspace" | "user";
  catalogByUrl: Map<string, ReturnType<typeof loadCatalog>[number]>;
  conn: { state: string; authorizationUrl?: string } | null;
  credStore: FileCredentialStore;
  ownerIdForCreds: string | null;
}): Promise<{
  catalogId: string | null;
  serverName: string;
  url: string;
  scope: "workspace" | "user";
  catalog?: ReturnType<typeof loadCatalog>[number];
  state: string;
  authorizationUrl?: string;
  identity?: { sub?: string; email?: string; name?: string };
  missingOperatorSetup?: boolean;
}> {
  const cat = args.catalogByUrl.get(args.ref.url);
  const entry: ReturnType<typeof buildInstalledEntry> extends Promise<infer R> ? R : never = {
    catalogId: cat?.id ?? null,
    serverName: args.serverName,
    url: args.ref.url,
    scope: args.scope,
    ...(cat ? { catalog: cat } : {}),
    state: args.conn?.state ?? "not_authenticated",
    ...(args.conn?.authorizationUrl ? { authorizationUrl: args.conn.authorizationUrl } : {}),
  };
  // Static-auth missingOperatorSetup probe (workspace scope only — user
  // scope doesn't currently use static client secrets at the per-user level).
  // The ref is the URL variant by way of the caller's `"url" in ref` guard,
  // but the BundleRef union doesn't narrow that far automatically.
  const urlRef = args.ref as { url: string; oauthClient?: { clientSecret?: { key: string } } };
  if (args.scope === "workspace" && args.ownerIdForCreds && urlRef.oauthClient?.clientSecret) {
    const wrapped = await args.credStore.get(
      args.ownerIdForCreds,
      urlRef.oauthClient.clientSecret.key,
    );
    if (!wrapped) entry.missingOperatorSetup = true;
  }
  return entry;
}

async function handleInstall(
  ctx: ManageConnectionsContext,
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
    const allowList = ws?.connectionsAllowList;
    if (allowList && Array.isArray(allowList) && allowList.length > 0) {
      if (!allowList.includes(entry.id)) {
        return errResult(`Catalog entry "${catalogId}" not visible in this workspace.`);
      }
    }
  }

  // Static-auth catalog entries can't be installed from the UI in v1 —
  // operator setup (clientId + clientSecret in a developer portal) is
  // required first. Surface clearly so the UI can render the "Configure"
  // affordance instead of clicking through to a 409.
  if (entry.auth === "static") {
    return errResult(
      `"${entry.name}" requires operator setup. Configure ${entry.operatorSetup?.portalUrl ?? "the OAuth app"} and seed the credential before install.`,
    );
  }

  const ref: BundleRef = {
    url: entry.url,
    serverName: entry.id,
    oauthScope: entry.defaultScope,
    ...(entry.requiredScopes ? { scopes: entry.requiredScopes } : {}),
    ...(entry.additionalAuthorizationParams
      ? { additionalAuthorizationParams: entry.additionalAuthorizationParams }
      : {}),
  };

  const lifecycle = ctx.runtime.getLifecycle();

  if (entry.defaultScope === "workspace") {
    if (!wsId) return errResult("Workspace context required for workspace-scope install.");
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    if (!ws) return errResult(`Workspace "${wsId}" not found.`);

    const dup = ws.bundles.find((b) => "url" in b && b.url === entry.url);
    if (dup) {
      return {
        content: textContent(`"${entry.name}" already installed.`),
        structuredContent: {
          ok: true,
          alreadyInstalled: true,
          serverName: "serverName" in dup ? (dup.serverName ?? entry.id) : entry.id,
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
    return errResult("Authentication required to install personal connections.");
  }
  const userStore = ctx.runtime.getUserConnectionStore();
  const existing = await userStore.get(callerId);
  const dup = existing?.bundles.find((b) => "url" in b && b.url === entry.url);
  if (dup) {
    return {
      content: textContent(`"${entry.name}" already installed for your account.`),
      structuredContent: {
        ok: true,
        alreadyInstalled: true,
        serverName: "serverName" in dup ? (dup.serverName ?? entry.id) : entry.id,
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
  ctx: ManageConnectionsContext,
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

function errResult(msg: string): ToolResult {
  return { content: textContent(msg), isError: true };
}
