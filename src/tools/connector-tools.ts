import { deriveServerName } from "../bundles/paths.ts";
import type { BundleRef } from "../bundles/types.ts";
import { loadCatalog } from "../connectors/load-catalog.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
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
            "list_installed",
            "list_tools",
            "install",
            "disconnect",
            "uninstall",
            "get_permissions",
            "set_permissions",
          ],
          description: "Action to perform.",
        },
        catalogId: {
          type: "string",
          description: "Catalog entry id (required for install).",
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
    return errResult("Authentication required to install personal connectors.");
  }
  const userStore = ctx.runtime.getUserConnectorStore();
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

  // User scope — for now equivalent to disconnectUser since there's no
  // separate "remove from user.json without revoke" flow today.
  if (!callerId) return errResult("Authentication required.");
  try {
    const result = await lifecycle.disconnectUser?.(serverName, callerId, {
      workDir: ctx.runtime.getWorkDir(),
      allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
    });
    if (!result) return errResult("User-scope uninstall not implemented.");
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

function errResult(msg: string): ToolResult {
  return { content: textContent(msg), isError: true };
}
