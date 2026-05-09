import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpAuthCallbackUrl } from "../api/routes/mcp-auth.ts";
import { getMpak } from "../bundles/mpak.ts";
import { deriveServerName } from "../bundles/paths.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type { BundleManifest, BundleRef } from "../bundles/types.ts";
import { installBundleInWorkspace } from "../bundles/workspace-ops.ts";
import {
  clearAllWorkspaceCredentials,
  clearWorkspaceCredential,
  getWorkspaceCredentials,
  saveWorkspaceCredential,
  type UserConfigFieldDef,
} from "../config/workspace-credentials.ts";
import { loadStaticConnectorEntries } from "../connectors/static-source.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { DirectoryAggregator } from "../registries/aggregator.ts";
import type { DirectoryEntry } from "../registries/types.ts";
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

/** Inputs to {@link deriveConnectorStatus}. Subset of InstalledEntry's
 *  shape so the helper has a small, testable surface. */
export interface StatusInputs {
  /** BundleState as exposed by the lifecycle. */
  state: string;
  /** True when a static-auth catalog entry has no operator OAuth client configured. */
  missingOperatorSetup?: boolean;
  /** Stdio bundle's user_config probe — present only when the manifest declares one. */
  userConfig?: {
    schema: Record<string, UserConfigFieldDef>;
    populated: Record<string, boolean>;
  };
  /** Last connection error from the principal Connection (crashed / dead / reauth_required). */
  lastError?: string;
}

/**
 * Collapse a connector's underlying flags into a generic, type-agnostic
 * status for the UI. Six values:
 *
 *   ready          — works
 *   needs_setup    — admin must configure something (operator OAuth client OR
 *                     stdio user_config) before this is usable
 *   needs_auth     — workspace member must (re)authenticate (Connect / Reconnect)
 *   connecting     — OAuth flow in flight
 *   failed         — bundle crashed / dead with no actionable next step
 *   starting       — subprocess booting up
 *
 * Priority — setup blocks auth blocks usage. A stdio bundle that crashed
 * because its api_key wasn't set surfaces as `needs_setup` (the actionable
 * cause), never as `failed`. Same for static-auth bundles whose OAuth
 * never succeeded because the operator clientSecret is missing.
 *
 * The connector-type detail — *which* credentials missing, *what* button
 * label — is left to the UI, derived from the other InstalledConnector
 * fields. This helper's job is the discriminator + a human-readable
 * reason string for tooltips / banners.
 */
/**
 * Resolve a bundle's manifest from whichever path it actually lives at.
 *
 * Two install shapes coexist in the platform:
 *
 *   - Name-installed (`{ name: "@scope/bundle" }`): mpak fetches and
 *     extracts the bundle into `<mpakHome>/cache/<safeName>/`. Manifest
 *     reads via `mpak.bundleCache.getBundleManifest(name)`.
 *
 *   - Path-installed (`{ path: "/abs/path/to/bundle" }`): bundle lives
 *     wherever the operator points to (e.g. `synapse-apps/synapse-db-query`
 *     during local development). The manifest is at `<path>/manifest.json`.
 *     The mpak cache has no entry; reading via `getBundleManifest` returns
 *     null and any caller relying solely on the cache silently misses
 *     `user_config`.
 *
 * `BundleInstance.configKey` carries the original ref's identity — the
 * path string for path installs, the name string for name installs.
 * That's the key we fall back to when the cache misses. Wrap both in
 * try/catch so a stale config (path no longer exists, manifest moved)
 * gracefully degrades to a missing-userConfig response instead of
 * throwing.
 */
async function readBundleManifest(
  mpak: ReturnType<typeof getMpak>,
  instance: { bundleName: string; configKey?: string },
): Promise<BundleManifest | null> {
  try {
    const cached = mpak.bundleCache.getBundleManifest(instance.bundleName) as BundleManifest | null;
    if (cached) return cached;
  } catch {
    // Corrupt-cache errors fall through to the disk-read fallback.
  }
  // Path-install fallback. configKey can be either a name or a path;
  // attempt the disk read regardless and let the file-not-found case
  // settle to null.
  if (instance.configKey) {
    try {
      const raw = await readFile(join(instance.configKey, "manifest.json"), "utf-8");
      return JSON.parse(raw) as BundleManifest;
    } catch {
      // Not a valid path or file missing — manifest unavailable.
    }
  }
  return null;
}

export function deriveConnectorStatus(input: StatusInputs): {
  status: "ready" | "needs_setup" | "needs_auth" | "connecting" | "failed" | "starting";
  statusReason?: string;
} {
  // 1. Setup gates everything. Operator OAuth missing → admin acts first.
  if (input.missingOperatorSetup) {
    return { status: "needs_setup", statusReason: "OAuth app not configured for this workspace." };
  }
  // 2. Required user_config field unpopulated → admin sets credentials.
  if (input.userConfig) {
    const missing = Object.entries(input.userConfig.schema)
      .filter(([key, def]) => def.required && !input.userConfig?.populated[key])
      .map(([key, def]) => def.title ?? key);
    if (missing.length > 0) {
      return {
        status: "needs_setup",
        statusReason: `Missing required configuration: ${missing.join(", ")}.`,
      };
    }
  }
  // 3. Auth lifecycle. Reconnect outranks first-time connect (a token
  //    that just expired is more disruptive than one never used).
  if (input.state === "reauth_required") {
    return {
      status: "needs_auth",
      statusReason: input.lastError ?? "Sign in again to continue using this connector.",
    };
  }
  if (input.state === "not_authenticated") {
    return { status: "needs_auth", statusReason: "Connect to use this connector." };
  }
  // 4. Transient flows.
  if (input.state === "pending_auth") {
    return { status: "connecting" };
  }
  if (input.state === "starting") {
    return { status: "starting" };
  }
  // 5. Terminal failures with no clear recovery path.
  if (input.state === "crashed" || input.state === "dead" || input.state === "stopped") {
    return {
      status: "failed",
      ...(input.lastError ? { statusReason: input.lastError } : {}),
    };
  }
  // 6. Default — running, no missing config, no failed connection.
  return { status: "ready" };
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
            "get_installed",
            "list_tools",
            "list_tools_with_permissions",
            "install",
            "disconnect",
            "uninstall",
            "get_permissions",
            "set_permissions",
            "setup_operator",
            "remove_operator_setup",
            "set_user_config",
            "clear_user_config",
            "get_redirect_uri",
          ],
          description: "Action to perform.",
        },
        catalogId: {
          type: "string",
          description: "Catalog entry id (required for setup_operator, remove_operator_setup).",
        },
        entry: {
          type: "object",
          description:
            "DirectoryEntry to install (required for `install`). The same shape returned by list_directory — server dispatches by entry.install.kind. No id-to-action lookup; the registry that produced the entry is the source of truth for the install payload.",
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
        fields: {
          type: "object",
          description:
            "For set_user_config: map of bundle user_config field name → string value. Empty string clears that field. Omitted fields are unchanged. Unknown field names are rejected (default-deny).",
          additionalProperties: { type: "string" },
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
        case "get_installed":
          return handleGetInstalled(ctx, wsId, callerId, String(input.serverName ?? ""));
        case "list_tools":
          return handleListTools(
            ctx,
            wsId,
            callerId,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
          );
        case "list_tools_with_permissions":
          return handleListToolsWithPermissions(
            ctx,
            wsId,
            callerId,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
          );
        case "install":
          return handleInstall(ctx, wsId, identity, input.entry as unknown);
        case "disconnect":
          return handleDisconnect(
            ctx,
            wsId,
            identity,
            String(input.serverName ?? ""),
            input.scope ? String(input.scope) : undefined,
          );
        case "uninstall":
          return handleUninstall(
            ctx,
            wsId,
            identity,
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
        case "set_user_config":
          return handleSetUserConfig(
            ctx,
            wsId,
            identity,
            String(input.serverName ?? ""),
            (input.fields as Record<string, unknown>) ?? {},
          );
        case "clear_user_config":
          return handleClearUserConfig(ctx, wsId, identity, String(input.serverName ?? ""));
        case "get_redirect_uri":
          // The URL itself is effectively public (it's surfaced in
          // every OAuth flow), so this gate is convention rather than
          // confidentiality — every other action on this tool requires
          // an authenticated identity and the unauthenticated outlier
          // here was a maintenance trip-wire flagged in PR review.
          if (!identity) {
            return errResult("Authentication required.");
          }
          return {
            content: textContent("OAuth callback URL."),
            structuredContent: { redirectUri: mcpAuthCallbackUrl() },
            isError: false,
          };
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
  const catalog = await loadStaticConnectorEntries(ctx.runtime.getRegistryStore());
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
  /**
   * When set, only build the entry for this specific serverName.
   * Used by `handleGetInstalled` to avoid running source.tools() and
   * the manifest+credential probes for every other connector when
   * the caller only needs one. Non-matching instances are skipped
   * before any per-instance IO.
   */
  onlyServerName?: string,
): Promise<ToolResult> {
  const lifecycle = ctx.runtime.getLifecycle();
  const workDir = ctx.runtime.getWorkDir();
  const credStore = new FileCredentialStore(workDir);
  const catalog = await loadStaticConnectorEntries(ctx.runtime.getRegistryStore());
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
    /**
     * Last connection error for crashed / dead / reauth_required states.
     * Pulled from the principal Connection — only present when the
     * underlying OAuth or transport actually failed and recorded the
     * error. UI uses this to render a red "Failed: <reason>" line on
     * the OAuth connection section.
     */
    lastError?: string;
    /**
     * Per-workspace operator OAuth client config — present only for
     * static-auth catalog entries the workspace has configured. Carries
     * the public clientId, audit metadata, and a best-effort display
     * label so the Configure page can render "Configured by Sarah" without
     * a second API round-trip. Secret is never echoed.
     */
    operatorOAuth?: {
      clientId: string;
      configuredAt: string;
      configuredBy: string;
      configuredByLabel?: string;
    };
    /**
     * Stdio bundle credential schema + per-field configured-state probe.
     * Populated only when the bundle's manifest declares `user_config`.
     * `populated[k]` is `true` when a non-empty value is currently
     * stored — never the value itself. The Configure page's bundle-config
     * section reads schema for field metadata and populated for
     * configured/not-configured indicators.
     */
    userConfig?: {
      schema: Record<string, UserConfigFieldDef>;
      populated: Record<string, boolean>;
    };
    /**
     * Generic, type-agnostic status the UI renders without re-deriving
     * from the underlying BundleState + credential probes. Six values
     * collapse what would otherwise be ~10 specific failure modes —
     * the connector-type detail (which credentials missing, which
     * action label) is derived in the UI from the other fields.
     *
     * Priority when multiple flags apply: setup blocks auth blocks
     * usage. needs_setup > needs_auth > failed > connecting/starting >
     * ready. A bundle that crashed because of missing user_config
     * surfaces as `needs_setup` (the actionable cause), not `failed`.
     */
    status: "ready" | "needs_setup" | "needs_auth" | "connecting" | "failed" | "starting";
    /** Human-readable detail for status. Surfaces in tooltips / banners. */
    statusReason?: string;
  };
  const installed: InstalledEntry[] = [];

  // Resolve operator OAuth audit labels and bundle credential schemas
  // lazily so the most common installed-list shape (no static-auth
  // connectors, no stdio bundles with user_config) does no extra IO.
  const userStore = ctx.runtime.getUserStore();
  const userLabelCache = new Map<string, string | undefined>();
  const resolveUserLabel = async (userId: string): Promise<string | undefined> => {
    if (userLabelCache.has(userId)) return userLabelCache.get(userId);
    let label: string | undefined;
    try {
      const u = await userStore.get(userId);
      label = u?.displayName?.trim() || u?.email?.trim() || undefined;
    } catch {
      // best-effort; fall back to bare userId at the call site
    }
    userLabelCache.set(userId, label);
    return label;
  };
  // Use `<workDir>/apps` — same path BundleLifecycleManager is
  // constructed with in runtime.ts. Dev's local nimblebrain.json
  // sets `workDir: ".nimblebrain"` so this resolves to the cwd-local
  // cache; production's default workDir is `~/.nimblebrain`. Matching
  // the lifecycle's mpakHome means we read from the same singleton
  // mpak cache the install path populated.
  const mpak = getMpak(join(workDir, "apps"));

  // Workspace-scope entries: walk every bundle visible in the workspace
  // registry (includes local stdio, local URL, Synapse apps, and remote
  // OAuth). This is the same view the About tab uses via list_apps.
  if ((scope === "all" || scope === "workspace") && wsId) {
    const registry = ctx.runtime.getRegistryForWorkspace(wsId);
    // One workspace fetch covers oauthOperatorApps lookups for every
    // static-auth catalog match in this loop. Hoist out of the per-
    // instance closure so a workspace with N installed connectors does
    // one disk read for the workspace record, not N.
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    // Read directly from the lifecycle's instance map. The shorthand
    // `getBundleInstancesForWorkspace` additionally filters by
    // `wsRegistry.sourceNames()` — appropriate for the agent's app
    // list (disconnected bundle = unusable for tool calls), wrong for
    // the management UI. After Disconnect we tear down the McpSource
    // intentionally; the bundle is still INSTALLED and the user
    // needs to see it on this page to click Connect again.
    for (const instance of lifecycle.getInstances()) {
      if (instance.wsId !== wsId) continue;
      // Skip user-scope URL bundles seeded into the workspace registry
      // via UserPoolSource — those belong to the user-scope view.
      if (instance.oauthScope === "user") continue;
      // Single-connector path: skip every non-matching instance
      // before doing any per-instance IO (tools() round-trip,
      // manifest probe, credential read).
      if (onlyServerName && instance.serverName !== onlyServerName) continue;

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
        // Provisional — overwritten by deriveConnectorStatus below
        // once every probe (operatorOAuth, userConfig, lastError) has
        // been resolved on the entry. Initial value satisfies the
        // public InstalledConnector contract that `status` is required.
        status: "ready",
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
        if (conn?.lastError) entry.lastError = conn.lastError;
        // Static-auth missing-operator-setup probe.
        const oauthClient = (ref as { oauthClient?: { clientSecret?: { key: string } } })
          .oauthClient;
        if (oauthClient?.clientSecret) {
          const wrapped = await credStore.get(wsId, oauthClient.clientSecret.key);
          if (!wrapped) entry.missingOperatorSetup = true;
        }
        // Operator OAuth client config (static-auth only). The Configure
        // page reads this to render the "Configured by ... on ..." audit
        // line + Edit affordance. clientId is public; the secret never
        // leaves the credential store.
        const op = cat?.auth === "static" ? ws?.oauthOperatorApps?.[cat.id] : undefined;
        if (op) {
          const label = await resolveUserLabel(op.configuredBy);
          entry.operatorOAuth = {
            clientId: op.clientId,
            configuredAt: op.configuredAt,
            configuredBy: op.configuredBy,
            ...(label ? { configuredByLabel: label } : {}),
          };
        }
      }

      // Stdio bundle credential schema + per-field configured probe.
      // Driven by the bundle's manifest `user_config` block. Manifest
      // resolution handles both name-installed (mpak cache) and
      // path-installed (read from disk) bundles — the latter is how
      // every Synapse app under local-dev install ends up registered.
      if (!isRemote) {
        try {
          const manifest = await readBundleManifest(mpak, instance);
          const schema = manifest?.user_config;
          if (schema && Object.keys(schema).length > 0) {
            const stored =
              (await getWorkspaceCredentials(wsId, instance.bundleName, workDir)) ?? {};
            const populated: Record<string, boolean> = {};
            for (const key of Object.keys(schema)) {
              const v = stored[key];
              populated[key] = typeof v === "string" && v.length > 0;
            }
            entry.userConfig = { schema, populated };
          }
        } catch {
          // Read errors are best-effort cosmetic data — surface the
          // connector without the bundle-config section rather than
          // failing the whole list_installed call.
        }
      }

      // Derive the generic UI status last so it sees every populated
      // probe (operatorOAuth gate, userConfig populated map, lastError).
      const derived = deriveConnectorStatus(entry);
      entry.status = derived.status;
      if (derived.statusReason) entry.statusReason = derived.statusReason;

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
        if (onlyServerName && serverName !== onlyServerName) continue;
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
          // Provisional — overwritten by deriveConnectorStatus below.
          status: "ready",
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

        // Same derivation as the workspace branch — keeps the two
        // scopes producing the same shape for the UI.
        const derived = deriveConnectorStatus(entry);
        entry.status = derived.status;
        if (derived.statusReason) entry.statusReason = derived.statusReason;

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

/**
 * Single-connector counterpart to `list_installed`. Returns the same
 * shape as one entry from that array, or `null` when the bundle
 * isn't installed in the caller's scope. Used by the Configure
 * detail page so it doesn't fetch all 15+ installed connectors just
 * to render one.
 *
 * Internally reuses `handleListInstalled` with the `onlyServerName`
 * filter so per-instance IO (tools() round-trips, manifest probes)
 * is skipped for every non-matching connector.
 */
async function handleGetInstalled(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");

  const result = await handleListInstalled(ctx, wsId, callerId, "all", serverName);
  if (result.isError) return result;
  const sc = result.structuredContent as { installed?: unknown[] } | undefined;
  const entries = sc?.installed ?? [];
  const installed = entries[0] ?? null;
  return {
    content: textContent(installed ? `Installed: ${serverName}` : `Not installed: ${serverName}`),
    structuredContent: { installed },
    isError: false,
  };
}

/**
 * Install a connector. Takes the full `DirectoryEntry` the UI was
 * already showing the user — server dispatches by `entry.install.kind`.
 *
 * No id-to-action lookup. The registry that produced the entry IS the
 * source of truth for what to install; the install handler just runs
 * the action. This means:
 *
 *   - Adding a new connector kind = add a case to the switch below
 *     and a registry that emits it.
 *   - No name-collision bugs between catalogs (the "Catalog entry not
 *     found" class of error doesn't exist in this design).
 *   - Forward-compat: when MpakRegistry's real implementation lands
 *     and emits live mpak-bundle entries, they install on day one
 *     without any change here.
 *
 * Cross-cutting checks (admin allow-list) apply to every install
 * kind and live above the dispatch.
 */
async function handleInstall(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  rawEntry: unknown,
): Promise<ToolResult> {
  const entry = parseDirectoryEntry(rawEntry);
  if (!entry) return errResult("entry with install action is required.");
  const callerId = identity?.id ?? null;

  // Workspace allow-list — the workspace operator can scope which
  // catalog ids are installable. Applies to every install kind.
  // Workspace-scope installs additionally require admin role: the
  // bundle joins the shared workspace surface (placements, tools,
  // credentials inheritance), so a non-admin should not be able to
  // unilaterally widen the workspace's tool/credential exposure.
  // User-scope installs are self-targeted (per-user OAuth) and only
  // require an authenticated identity, which the user-scope branches
  // enforce inline.
  const isWorkspaceScope =
    entry.install.kind === "mpak-bundle" ||
    (entry.install.kind === "remote-oauth" && entry.defaultScope === "workspace");
  if (isWorkspaceScope) {
    if (!wsId) return errResult("Workspace context required for workspace-scope install.");
    if (!identity) return errResult("Authentication required.");
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    if (!ws) return errResult(`Workspace "${wsId}" not found.`);
    if (!isWorkspaceAdmin(ws, identity)) {
      return {
        content: textContent("Workspace admin role required to install connectors."),
        structuredContent: { error: "permission_denied" },
        isError: true,
      };
    }
    const allowList = ws.connectorsAllowList;
    if (allowList && Array.isArray(allowList) && allowList.length > 0) {
      if (!allowList.includes(entry.id)) {
        return errResult(`Connector "${entry.id}" not visible in this workspace.`);
      }
    }
  } else if (wsId) {
    // User-scope path running with a workspace context still respects
    // the allow-list — keeps the operator's curated set authoritative
    // even for personal accounts.
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    const allowList = ws?.connectorsAllowList;
    if (allowList && Array.isArray(allowList) && allowList.length > 0) {
      if (!allowList.includes(entry.id)) {
        return errResult(`Connector "${entry.id}" not visible in this workspace.`);
      }
    }
  }

  switch (entry.install.kind) {
    case "remote-oauth":
      return handleInstallRemoteOAuth(ctx, wsId, callerId, entry);
    case "mpak-bundle":
      return handleInstallMpak(ctx, wsId, entry);
    case "direct-url":
      return errResult("direct-url install is not yet supported.");
  }
}

/**
 * Validate the wire payload as a `DirectoryEntry`. Tools/JSON arrive
 * as `unknown` from the dispatcher and the entry came from a client,
 * not the registry — anyone with API access can construct a payload.
 * Same threat model as the catalog `iconUrl` allowlist (a malicious
 * entry attempting to coerce the install path into an attacker-
 * controlled package name or URL).
 *
 * Per-kind shape:
 *   - mpak-bundle: `package` must be a scoped npm-style name
 *     `@scope/name` (lowercase kebab on each segment) — the same
 *     shape mpak's registry accepts.
 *   - remote-oauth: `url` must parse as `http(s):` — protocol
 *     allowlist mirrors the catalog's `iconUrl` rules so a malformed
 *     entry can't slip a `javascript:` / `data:` / `file:` URL into
 *     the bundle creation path.
 *   - direct-url: parked behind an errResult in handleInstall today,
 *     so no value-shape check yet.
 *
 * Workspace `connectorsAllowList` (when set) further narrows the
 * accepted ids — but it's optional, so this is the always-on gate.
 */
const SCOPED_PACKAGE_RE = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

function parseDirectoryEntry(input: unknown): DirectoryEntry | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.name !== "string") return null;
  const install = e.install as { kind?: unknown; package?: unknown; url?: unknown } | undefined;
  if (!install || typeof install !== "object") return null;
  if (
    install.kind !== "remote-oauth" &&
    install.kind !== "mpak-bundle" &&
    install.kind !== "direct-url"
  ) {
    return null;
  }
  if (install.kind === "mpak-bundle") {
    if (typeof install.package !== "string" || !SCOPED_PACKAGE_RE.test(install.package)) {
      return null;
    }
  }
  if (install.kind === "remote-oauth") {
    if (typeof install.url !== "string" || !isHttpUrl(install.url)) {
      return null;
    }
  }
  return input as DirectoryEntry;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Remote OAuth install — workspace-scope or user-scope based on
 * `entry.defaultScope`. For static-auth (Asana, HubSpot, etc.) the
 * workspace must have operator OAuth client config persisted under
 * `workspace.json#oauthOperatorApps[entry.id]` + the matching
 * client_secret in the credential store before this can proceed.
 */
async function handleInstallRemoteOAuth(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  entry: DirectoryEntry,
): Promise<ToolResult> {
  if (entry.install.kind !== "remote-oauth") {
    return errResult("invariant violated: handleInstallRemoteOAuth requires remote-oauth entry");
  }
  const action = entry.install;

  // Static-auth gating: operator clientId + secret must exist.
  let staticOAuthClient: { clientId: string; clientSecretKey: string } | undefined;
  if (action.auth === "static") {
    const setup = action.operatorSetup;
    if (!setup) {
      return errResult(`"${entry.name}" is static-auth but missing operatorSetup config.`);
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
    url: action.url,
    serverName: entry.id,
    oauthScope: entry.defaultScope,
    ...(action.requiredScopes ? { scopes: action.requiredScopes } : {}),
    ...(action.additionalAuthorizationParams
      ? { additionalAuthorizationParams: action.additionalAuthorizationParams }
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

    const dup = ws.bundles.find((b) => "url" in b && b.url === action.url);
    if (dup) {
      const dupServerName = "serverName" in dup ? (dup.serverName ?? entry.id) : entry.id;
      // Self-heal: workspace.json says yes but lifecycle lost the
      // instance (prior uninstall that didn't clean workspace.json).
      // Re-seed instead of reporting alreadyInstalled — the latter
      // would skip seedInstance and fail the next OAuth initiate.
      if (!lifecycle.getInstance(dupServerName, wsId)) {
        const wsRegistry = ctx.runtime.getRegistryForWorkspace(wsId);
        lifecycle.seedInstance(
          dupServerName,
          action.url,
          dup,
          undefined,
          wsId,
          undefined,
          wsRegistry,
        );
        lifecycle.notifyInstalled(dupServerName, wsId);
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
    lifecycle.seedInstance(entry.id, action.url, ref, undefined, wsId, undefined, wsRegistry);
    lifecycle.notifyInstalled(entry.id, wsId);
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
  const dup = existing?.bundles.find((b) => "url" in b && b.url === action.url);
  if (dup) {
    const dupServerName = "serverName" in dup ? (dup.serverName ?? entry.id) : entry.id;
    // Self-heal symmetric to workspace scope.
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

/**
 * Mpak (stdio) install. The bundle is fetched from whichever mpak
 * registry the SDK is pointed at, spawned as a subprocess, and
 * registered in the workspace registry. Same mechanics as the chat
 * agent's `bundleManagement.install` so both UI surfaces produce
 * identical state.
 *
 * Workspace-scope only — every stdio bundle is workspace-shared
 * today. A future per-user mpak install would need its own
 * dispatcher branch.
 */
async function handleInstallMpak(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  entry: DirectoryEntry,
): Promise<ToolResult> {
  if (!wsId) return errResult("Workspace context required for stdio install.");
  if (entry.install.kind !== "mpak-bundle") {
    return errResult("invariant violated: handleInstallMpak requires mpak-bundle entry");
  }
  const bundleName = entry.install.package;

  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return errResult(`Workspace "${wsId}" not found.`);

  const lifecycle = ctx.runtime.getLifecycle();
  const registry = ctx.runtime.getRegistryForWorkspace(wsId);

  // Idempotency: workspace.json already has this bundle. If the
  // lifecycle still tracks it, surface alreadyInstalled. If not,
  // fall through and let installBundleInWorkspace re-register —
  // this self-heals the case where uninstall left a stale entry.
  const already = ws.bundles.find((b) => "name" in b && b.name === bundleName);
  if (already) {
    const existingServerName = deriveServerName(bundleName);
    if (lifecycle.getInstance(existingServerName, wsId)) {
      return {
        content: textContent(`"${entry.name}" already installed.`),
        structuredContent: {
          ok: true,
          alreadyInstalled: true,
          serverName: existingServerName,
          scope: "workspace",
        },
        isError: false,
      };
    }
  }

  const ref: BundleRef = { name: bundleName };
  let inventoryEntry: Awaited<ReturnType<typeof installBundleInWorkspace>>;
  try {
    inventoryEntry = await installBundleInWorkspace(
      wsId,
      ref,
      registry,
      ctx.runtime.getEventSink(),
      ctx.runtime.getConfigPath(),
      {
        allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
        workDir: ctx.runtime.getWorkDir(),
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errResult(`Failed to install "${entry.name}": ${msg}`);
  }

  lifecycle.seedInstance(
    inventoryEntry.serverName,
    bundleName,
    ref,
    inventoryEntry.meta ?? undefined,
    wsId,
    inventoryEntry.dataDir,
    registry,
  );
  // Register placements + emit bundle.installed so the web shell's
  // sidebar refreshes without a reboot. seedInstance is intentionally
  // state-only; the side effects live here.
  lifecycle.notifyInstalled(inventoryEntry.serverName, wsId);

  if (!already) {
    await ctx.runtime.getWorkspaceStore().update(wsId, { bundles: [...ws.bundles, ref] });
  }

  return {
    content: textContent(`Installed "${entry.name}" in this workspace.`),
    structuredContent: {
      ok: true,
      alreadyInstalled: false,
      serverName: inventoryEntry.serverName,
      scope: "workspace",
    },
    isError: false,
  };
}

async function handleDisconnect(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const callerId = identity?.id ?? null;
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
    if (!identity) return errResult("Authentication required.");
    // Workspace-scope disconnect revokes OAuth tokens used by every
    // member of the workspace. A non-admin shouldn't be able to log
    // the whole workspace out of a shared connector.
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    if (!ws) return errResult(`Workspace "${wsId}" not found.`);
    if (!isWorkspaceAdmin(ws, identity)) {
      return {
        content: textContent("Workspace admin role required to disconnect shared connectors."),
        structuredContent: { error: "permission_denied" },
        isError: true,
      };
    }
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
  identity: UserIdentity | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const callerId = identity?.id ?? null;
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
    if (!identity) return errResult("Authentication required.");
    // Workspace-scope uninstall removes a connector for every member
    // of the workspace and clears the credential file. A non-admin
    // shouldn't be able to remove a shared bundle other members rely on.
    const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
    if (!ws) return errResult(`Workspace "${wsId}" not found.`);
    if (!isWorkspaceAdmin(ws, identity)) {
      return {
        content: textContent("Workspace admin role required to uninstall shared connectors."),
        structuredContent: { error: "permission_denied" },
        isError: true,
      };
    }
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
      // Capture the manifest name BEFORE lifecycle.uninstall — the
      // instance reference is still valid afterwards but the lifecycle
      // map drops it, and we need the name to strip the matching
      // workspace.json entry.
      const installedBundleName = instance?.bundleName;
      await lifecycle.uninstall(serverName, registry, wsId);
      // lifecycle.uninstall clears its own `instances` map and removes
      // from the legacy global `nimblebrain.json`, but it does NOT
      // touch `workspace.json#bundles[]` — that array was added later
      // for catalog-installed connectors. Without this cleanup, a
      // re-install attempt sees the leftover bundle, treats it as
      // already-installed, skips seedInstance, and the next OAuth
      // initiate fails with "Bundle X not installed." For stdio entries
      // (`{ name: "@org/bundle" }`), missing this cleanup means the
      // bundle reseeds at next boot — looking uninstalled in the UI but
      // back in the registry after restart.
      const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
      if (ws) {
        const filtered = ws.bundles.filter((b) => {
          if ("url" in b) {
            const sn = b.serverName ?? deriveServerName(b.url);
            return sn !== serverName;
          }
          if ("name" in b) {
            // Match named entries by manifest name; the install path
            // writes `{ name: bundleName }` so the same key is the
            // authoritative match. Fall back to the install-time
            // `{ name: serverName }` shape just in case.
            return b.name !== installedBundleName && b.name !== serverName;
          }
          return true;
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
    // Bundle is installed but not currently running (e.g. URL bundle
    // in `not_authenticated` after disconnect, stdio bundle whose
    // respawn failed). No tools to enumerate. Return empty tools
    // instead of throwing — this is a normal state, not an error.
    // The hero already conveys the "needs auth / needs setup" prompt.
    return {
      content: textContent("Tools: 0 (connector not running)."),
      structuredContent: { tools: [] },
      isError: false,
    };
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
 * Combined list_tools + get_permissions read. The Configure page's
 * tool-permissions table needs both: the tool list (for descriptions
 * and rendering) AND the policy map (for which switch is active).
 * Two REST calls per page load was wasteful — they share scope
 * resolution, instance lookup, and ownership checks. Merging them
 * into one server-side action halves the round-trips.
 *
 * The two reads themselves run in parallel (`Promise.all`); a slow
 * `tools/list` can't gate the permission read.
 */
async function handleListToolsWithPermissions(
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
  if (!wsId) return errResult("Workspace context required.");

  const owner = resolvePermissionOwner(wsId, callerId, scope);
  if (!owner) return errResult("Could not resolve permission owner — sign in or pick a workspace.");

  const registry = ctx.runtime.getRegistryForWorkspace(wsId);
  const source = registry.getSource(serverName);
  if (!source) {
    // Bundle installed but not running. Permissions still readable
    // (they're persisted independently of the source); return them
    // alongside an empty tools list so the UI can render the
    // permissions surface as "no tools currently available" without
    // a hard error.
    const permissions = await ctx.runtime.getPermissionStore().getConnector(owner, serverName);
    return {
      content: textContent("Tools: 0 (connector not running)."),
      structuredContent: { scope: owner.scope, serverName, tools: [], permissions },
      isError: false,
    };
  }

  try {
    // Run the two reads in parallel — they don't depend on each
    // other and the permission store hits disk while tools/list may
    // round-trip to the bundle subprocess.
    const [tools, permissions] = await Promise.all([
      source.tools(),
      ctx.runtime.getPermissionStore().getConnector(owner, serverName),
    ]);
    const prefix = `${serverName}__`;
    return {
      content: textContent(`Tools: ${tools.length}, ${Object.keys(permissions).length} overrides.`),
      structuredContent: {
        scope: owner.scope,
        serverName,
        tools: tools.map((t) => ({
          name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        permissions,
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

  const catalog = await loadStaticConnectorEntries(ctx.runtime.getRegistryStore());
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
  // haven't touched workspace.json yet, so there's nothing to roll
  // back. The reverse case (workspace.json fails after the credential
  // landed) needs explicit rollback so we don't leave an orphan
  // secret pointing at a clientId that was never recorded.
  const credStore = new FileCredentialStore(ctx.runtime.getWorkDir());
  const hadPriorSecret = (await credStore.get(wsId, clientSecretKey)) !== null;
  await credStore.put(wsId, clientSecretKey, clientSecret.trim());

  // Stamp the public clientId + audit trail into workspace.json.
  const apps = { ...(ws.oauthOperatorApps ?? {}) };
  apps[catalogId] = {
    clientId: clientId.trim(),
    configuredAt: new Date().toISOString(),
    configuredBy: identity.id,
  };
  try {
    await ctx.runtime.getWorkspaceStore().update(wsId, { oauthOperatorApps: apps });
  } catch (err) {
    // Roll back the credential write so the two stores stay in
    // lockstep. Best-effort: if the rollback itself fails (rare —
    // same disk, same UID), the original write error wins. Skip
    // rollback when an existing secret was already there for this
    // key; clobbering a working credential on a workspace.json
    // hiccup is a worse outcome than leaving a stale-but-valid one.
    if (!hadPriorSecret) {
      try {
        await credStore.delete(wsId, clientSecretKey);
      } catch {
        // best-effort
      }
    }
    throw err;
  }

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

  const catalog = await loadStaticConnectorEntries(ctx.runtime.getRegistryStore());
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
 * Resolve the bundle manifest's `user_config` schema for a workspace-
 * installed stdio bundle, with admin-gating built in. Returns the
 * BundleInstance + schema on success, or a `ToolResult` error to forward.
 *
 * Centralizes the four checks every credential-write action must do
 * (auth, ws context, admin role, bundle installed + schema present) so
 * `set_user_config` / `clear_user_config` stay focused on their write
 * step and don't drift in their guards.
 */
async function resolveBundleSchema(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  serverName: string,
): Promise<
  | { ok: true; bundleName: string; schema: Record<string, UserConfigFieldDef> }
  | { ok: false; result: ToolResult }
> {
  if (!wsId) return { ok: false, result: errResult("Workspace context required.") };
  if (!serverName) return { ok: false, result: errResult("serverName is required.") };
  if (!identity) return { ok: false, result: errResult("Authentication required.") };

  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return { ok: false, result: errResult(`Workspace "${wsId}" not found.`) };
  if (!isWorkspaceAdmin(ws, identity)) {
    return {
      ok: false,
      result: {
        content: textContent("Workspace admin role required to manage bundle credentials."),
        structuredContent: { error: "permission_denied" },
        isError: true,
      },
    };
  }

  const lifecycle = ctx.runtime.getLifecycle();
  const instance = lifecycle.getInstance(serverName, wsId);
  if (!instance) {
    return { ok: false, result: errResult(`Bundle "${serverName}" not installed in workspace.`) };
  }

  const mpakHome = join(ctx.runtime.getWorkDir(), "apps");
  const mpak = getMpak(mpakHome);
  // Same manifest-resolution rules as handleListInstalled — name-
  // installed bundles read from the mpak cache, path-installed
  // (Synapse apps in local dev) read from `<configKey>/manifest.json`.
  const manifest = await readBundleManifest(mpak, instance);
  const schema = manifest?.user_config;
  if (!schema || Object.keys(schema).length === 0) {
    return {
      ok: false,
      result: errResult(`Bundle "${serverName}" declares no user_config fields.`),
    };
  }
  return { ok: true, bundleName: instance.bundleName, schema };
}

/**
 * Probe the workspace credential file for which `user_config` fields
 * currently have non-empty stored values. Returns `{ key: boolean }`
 * keyed on the schema's field names — never the values themselves.
 */
async function probeUserConfigPopulated(
  wsId: string,
  bundleName: string,
  workDir: string,
  schema: Record<string, UserConfigFieldDef>,
): Promise<Record<string, boolean>> {
  const stored = (await getWorkspaceCredentials(wsId, bundleName, workDir)) ?? {};
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(schema)) {
    const v = stored[key];
    out[key] = typeof v === "string" && v.length > 0;
  }
  return out;
}

/**
 * Write or clear individual `user_config` fields on a stdio bundle's
 * workspace credential file. Per-field semantics:
 *
 *   - Field present in `fields`, value non-empty → save.
 *   - Field present in `fields`, value empty string → clear that one field.
 *   - Field absent from `fields` → leave existing value untouched.
 *
 * Unknown field names (anything not in the manifest's `user_config`)
 * are rejected up front (default-deny). Each individual save/clear is
 * already atomic via `withFileLock`; running them in sequence within a
 * single tool call is the simplest "no half-applied state" we can offer
 * without restructuring the credential primitive's API. Sequential is
 * safe because the lock serializes per-file.
 *
 * Admin-gated. Returns the post-write `populated` map so the UI can
 * reflect new state without a follow-up list_installed round-trip.
 */
async function handleSetUserConfig(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  serverName: string,
  fieldsInput: Record<string, unknown>,
): Promise<ToolResult> {
  const resolved = await resolveBundleSchema(ctx, wsId, identity, serverName);
  if (!resolved.ok) return resolved.result;
  const { bundleName, schema } = resolved;
  // Unsafe to assert inside the closure result type guard, but wsId is
  // checked in resolveBundleSchema — re-narrow for the rest of the body.
  if (!wsId) return errResult("Workspace context required.");

  // Default-deny on unknown keys. Reject the whole batch — partial
  // success on a typo would leave the writer guessing which fields took.
  const unknown = Object.keys(fieldsInput).filter((k) => !(k in schema));
  if (unknown.length > 0) {
    return errResult(
      `Unknown user_config field(s) for "${serverName}": ${unknown.join(", ")}. ` +
        `Allowed: ${Object.keys(schema).join(", ")}.`,
    );
  }

  // Type-coerce values. The JSON schema declares `string`, but defend
  // against a misbehaving caller passing other primitives — anything
  // non-string gets rejected explicitly rather than coerced silently.
  const writes: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of Object.entries(fieldsInput)) {
    if (typeof raw !== "string") {
      return errResult(`Field "${key}" must be a string (got ${typeof raw}).`);
    }
    writes.push({ key, value: raw });
  }

  const workDir = ctx.runtime.getWorkDir();
  for (const { key, value } of writes) {
    if (value.length === 0) {
      // Empty string = clear that single field. Use the dedicated
      // primitive so the key is removed from the credential file
      // (rather than persisted as `{ "key": "" }` which would still
      // resolve as "configured" in shape probes that check
      // key-presence).
      await clearWorkspaceCredential(wsId, bundleName, key, workDir);
    } else {
      await saveWorkspaceCredential(wsId, bundleName, key, value, workDir);
    }
  }

  // Mode 1 (env_inject) bundles only read user_config at spawn — env
  // vars are baked in at fork time. Saving to the credential file is
  // necessary but not sufficient; without a respawn the running
  // subprocess keeps using whatever it was launched with. Mirror the
  // chat agent's `configureBundle` pattern so both the chat path and
  // the UI path produce identical post-write state.
  const respawn = await respawnBundleAfterCredentialChange(ctx, wsId, bundleName, serverName);

  const populated = await probeUserConfigPopulated(wsId, bundleName, workDir, schema);
  return {
    content: textContent(`Updated ${writes.length} field(s) for "${serverName}".`),
    structuredContent: { ok: true, serverName, populated, respawn },
    isError: false,
  };
}

/**
 * Drop the entire workspace credential file for a stdio bundle. After
 * this returns, every field in the bundle's `user_config` schema reads
 * as not-configured. Admin-gated.
 *
 * Intentionally does NOT respawn the bundle subprocess. A respawn
 * after clear would fail at `prepareServer` for any bundle with
 * required fields, which leaves the workspace registry with no source
 * — and `getBundleInstancesForWorkspace` filters the installed list
 * by `wsRegistry.sourceNames()`. The connector would silently
 * disappear from the UI (404 on the Configure page, gone from the
 * Connectors list), with no way for the user to re-add credentials
 * short of uninstall + reinstall.
 *
 * The behavior here is pragmatic: the credential file on disk is
 * gone (next platform start spawns the bundle without those values),
 * but the running subprocess keeps its launched env until restart.
 * That's a small soundness gap for the rare "revoke without
 * uninstall" case; users wanting full revocation should uninstall.
 * Keep `respawn: { ok: true }` in the response so the UI surface is
 * consistent with `set_user_config`.
 */
async function handleClearUserConfig(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  serverName: string,
): Promise<ToolResult> {
  const resolved = await resolveBundleSchema(ctx, wsId, identity, serverName);
  if (!resolved.ok) return resolved.result;
  if (!wsId) return errResult("Workspace context required.");
  const { bundleName, schema } = resolved;

  const workDir = ctx.runtime.getWorkDir();
  await clearAllWorkspaceCredentials(wsId, bundleName, workDir);

  // After clearAll, every field reads as unpopulated. Build the map
  // directly rather than re-probing — saves one filesystem stat that
  // would always return null/empty here.
  const populated: Record<string, boolean> = {};
  for (const key of Object.keys(schema)) populated[key] = false;
  return {
    content: textContent(`Cleared all credentials for "${serverName}".`),
    structuredContent: { ok: true, serverName, populated, respawn: { ok: true } },
    isError: false,
  };
}

/**
 * Tear down + restart a stdio bundle's McpSource so a fresh subprocess
 * picks up the just-written credentials from the workspace credential
 * store. Called after `set_user_config` and `clear_user_config`.
 *
 * Why not just leave the bundle running? Mode 1 bundles read
 * `user_config` once, at spawn, via `${user_config.foo}` placeholders
 * resolved into env vars. The subprocess has no way to re-read after
 * launch. Without this respawn the user updates a key in the UI,
 * sees "✓ configured," then watches the next tool call fail with the
 * old key — the bug the user hit before this fix.
 *
 * Best-effort by design: a respawn failure (e.g., required field still
 * missing after a partial save) shouldn't roll back the credential
 * write. The caller's structured response carries `{ respawn: { ok,
 * error? } }` so the UI can surface the failure separately.
 */
async function respawnBundleAfterCredentialChange(
  ctx: ManageConnectorsContext,
  wsId: string,
  bundleName: string,
  serverName: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const registry = ctx.runtime.getRegistryForWorkspace(wsId);
    if (registry.hasSource(serverName)) {
      await registry.removeSource(serverName);
    }
    // Pass `name` (the scoped manifest name) so startBundleSource hits
    // the named-bundle path that resolves user_config from the
    // workspace credential store. configDir is undefined — same as
    // configureBundle's call site; named-bundle path doesn't need it.
    await startBundleSource({ name: bundleName }, registry, ctx.runtime.getEventSink(), undefined, {
      wsId,
      workDir: ctx.runtime.getWorkDir(),
      allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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
