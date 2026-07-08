import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpAuthCallbackUrl } from "../api/routes/mcp-auth.ts";
import {
  type ComposioConnection,
  readComposioConnection,
  saveComposioConnection,
} from "../bundles/composio-connection.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../bundles/connection.ts";
import { sanitizePlacements } from "../bundles/defaults.ts";
import { getMpak } from "../bundles/mpak.ts";
import { deriveServerName, slugifyServerName } from "../bundles/paths.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type {
  BundleInstance,
  BundleManifest,
  BundleRef,
  RemoteTransportConfig,
} from "../bundles/types.ts";
import { installBundleInWorkspace } from "../bundles/workspace-ops.ts";
import {
  composioUserId,
  connectComposioApiKey,
  createComposioSession,
  deleteComposioConnectedAccount,
} from "../composio/sdk.ts";
import type { UserConfigFieldDef } from "../config/workspace-credentials.ts";
import { connectorSkillIdentityFrom } from "../connectors/server-detail.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { log } from "../observability/log.ts";
import type { ConnectorCatalogEntry } from "../registries/projection.ts";
import type { DirectoryEntry, RemoteOAuthInstall } from "../registries/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { validateAdditionalAuthorizationParams } from "../util/oauth-params.ts";
import { isHttpUrl } from "../util/url.ts";
import { canWriteWorkspaceScoped } from "../workspace/authz.ts";
import type { Workspace } from "../workspace/types.ts";
import { personalWorkspaceIdFor } from "../workspace/workspace-store.ts";
import { FileCredentialStore } from "./credential-store.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { McpSource } from "./mcp-source.ts";

/**
 * `manage_connectors` tool — single surface for the Connectors UI
 * (catalog browse, list installed, install, disconnect). The platform's
 * MCP-tool-call surface is the canonical first-party API for the web
 * shell, and keeping one tool minimizes route bloat.
 *
 * Stage 2: every install is workspace-scoped. The `install` action
 * targets the request's active workspace (`ctx.getWorkspaceId()`, set
 * from the `/w/<slug>` route); an explicit `wsId` arg overrides it for
 * direct API callers. Any workspace — personal or shared — is a valid
 * target; the tool never special-cases the target's `isPersonal` flag.
 * The bundle ref's `oauthScope` is always `"workspace"`.
 *
 * Persistence: `WorkspaceStore.bundles[]` +
 * `workspaces/<wsId>/credentials/...` for tokens.
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
            "connect_api_key",
            "disconnect",
            "uninstall",
            "get_permissions",
            "set_permissions",
            "setup_operator",
            "remove_operator_setup",
            "set_user_config",
            "clear_user_config",
            "get_redirect_uri",
            "list_bound_skills",
            "list_personal_connectors",
            "grant_connector",
            "revoke_connector",
          ],
          description: "Action to perform.",
        },
        catalogId: {
          type: "string",
          description:
            "Catalog entry id (required for setup_operator, remove_operator_setup, connect_api_key).",
        },
        entry: {
          type: "object",
          description:
            "DirectoryEntry to install (required for `install`). The same shape returned by list_directory — server dispatches by entry.install.kind. No id-to-action lookup; the registry that produced the entry is the source of truth for the install payload.",
        },
        wsId: {
          type: "string",
          description:
            "Target workspace. For `install`: defaults to the request's workspace (X-Workspace-Id), so the web shell installs into the workspace it's viewing without passing this; supply it only to install elsewhere. For `grant_connector` / `revoke_connector`: the shared workspace to grant/revoke the caller's personal connector to — REQUIRED and explicit (no header fallback). There is no default-to-personal fallback.",
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
            "Bundle server name (required for disconnect, list_tools, get_permissions, set_permissions, grant_connector, revoke_connector).",
        },
        scope: {
          type: "string",
          enum: ["workspace"],
          description:
            "Stage 2: only `workspace` is accepted (legacy `user` scope was removed). Reserved for forward compatibility; defaults to `workspace`.",
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
            "For set_user_config: map of bundle user_config field name → string value. Empty string clears that field. Omitted fields are unchanged. Unknown field names are rejected (default-deny). For connect_api_key: map of the connector's declared Composio field key → value (e.g. api_key, subdomain); handed to Composio and never persisted by the platform.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      const args = resolveDispatchArgs(ctx, input);
      switch (args.action) {
        case "list_catalog":
          return handleListCatalog(ctx, args.wsId);
        case "list_directory":
          return handleListDirectory(ctx, args.wsId);
        case "list_installed":
          return handleListInstalled(ctx, args.wsId, args.callerId, args.listInstalledScope);
        case "get_installed":
          return handleGetInstalled(ctx, args.wsId, args.callerId, args.serverName);
        case "list_tools":
          return handleListTools(ctx, args.wsId, args.callerId, args.serverName, args.scope);
        case "list_tools_with_permissions":
          return handleListToolsWithPermissions(
            ctx,
            args.wsId,
            args.callerId,
            args.serverName,
            args.scope,
          );
        case "install":
          return handleInstall(ctx, args.identity, args.entry, args.installWsId);
        case "connect_api_key":
          return handleConnectApiKey(ctx, args.wsId, args.identity, args.catalogId, args.fields);
        case "disconnect":
          return handleDisconnect(ctx, args.wsId, args.identity, args.serverName, args.scope);
        case "uninstall":
          return handleUninstall(ctx, args.wsId, args.identity, args.serverName, args.scope);
        case "get_permissions":
          return handleGetPermissions(ctx, args.wsId, args.callerId, args.serverName, args.scope);
        case "set_permissions":
          return handleSetPermissions(
            ctx,
            args.wsId,
            args.callerId,
            args.serverName,
            args.scope,
            args.tools,
          );
        case "setup_operator":
          return handleSetupOperator(
            ctx,
            args.wsId,
            args.identity,
            args.catalogId,
            args.clientId,
            args.clientSecret,
          );
        case "remove_operator_setup":
          return handleRemoveOperatorSetup(ctx, args.wsId, args.identity, args.catalogId);
        case "set_user_config":
          return handleSetUserConfig(ctx, args.wsId, args.identity, args.serverName, args.fields);
        case "clear_user_config":
          return handleClearUserConfig(ctx, args.wsId, args.identity, args.serverName);
        case "get_redirect_uri":
          return handleGetRedirectUri(args.identity);
        case "list_bound_skills":
          return handleListBoundSkills(ctx, args.wsId);
        case "list_personal_connectors":
          return handleListPersonalConnectors(ctx, args.callerId);
        case "grant_connector":
          return handleGrantConnector(ctx, args.callerId, args.serverName, args.grantTargetWsId);
        case "revoke_connector":
          return handleRevokeConnector(ctx, args.callerId, args.serverName, args.grantTargetWsId);
        default:
          return errResult(`Unknown action "${args.action}".`);
      }
    },
  };
}

/** Coerce an optional tool-input field to a string, empty when absent. */
function str(v: unknown): string {
  return String(v ?? "");
}

/**
 * Coerced dispatch arguments for `manage_connectors`, resolved once so the
 * action switch stays a pure, branch-free dispatch.
 */
interface DispatchArgs {
  action: string;
  wsId: string | null;
  identity: UserIdentity | null;
  callerId: string | null;
  serverName: string;
  scope: string | undefined;
  listInstalledScope: string;
  catalogId: string;
  clientId: string;
  clientSecret: string;
  fields: Record<string, unknown>;
  tools: Record<string, unknown>;
  entry: unknown;
  installWsId: string | undefined;
  /** Explicit grant/revoke target workspace (input `wsId`, no header fallback). */
  grantTargetWsId: string | null;
}

/** Coerce the raw tool input + request context into typed dispatch args. */
function resolveDispatchArgs(
  ctx: ManageConnectorsContext,
  input: Record<string, unknown>,
): DispatchArgs {
  const wsId = ctx.getWorkspaceId();
  const identity = ctx.getIdentity();
  return {
    action: str(input.action),
    wsId,
    identity,
    callerId: identity?.id ?? null,
    serverName: str(input.serverName),
    scope: input.scope ? String(input.scope) : undefined,
    listInstalledScope: String(input.scope ?? "all"),
    catalogId: str(input.catalogId),
    clientId: str(input.clientId),
    clientSecret: str(input.clientSecret),
    fields: (input.fields as Record<string, unknown>) ?? {},
    tools: (input.tools as Record<string, unknown>) ?? {},
    entry: input.entry as unknown,
    // Default the install target to the request's workspace — the same
    // `ctx.getWorkspaceId()` (X-Workspace-Id, set from the `/w/<slug>` route)
    // every other action on this tool uses. The web shell installs into the
    // workspace the user is viewing; it no longer carries a separately-picked
    // target. An explicit `wsId` arg still wins for direct API callers. Keeping
    // install on the same workspace selector as connect / list / status is what
    // closes the "Bundle not installed" scope mismatch (an install seeded under
    // one workspace, then read under another).
    installWsId: input.wsId === undefined ? (wsId ?? undefined) : String(input.wsId),
    // Grant/revoke target is explicit only — never the ambient X-Workspace-Id
    // (the profile page has no workspace focus, and a stale header must not
    // silently become the grant target). Trimmed like `installWsId` so a
    // whitespace-only value fails the clean "wsId is required" check.
    grantTargetWsId:
      input.wsId !== undefined && String(input.wsId).trim() !== ""
        ? String(input.wsId).trim()
        : null,
  };
}

/**
 * `get_redirect_uri` — the OAuth callback URL. The URL itself is effectively
 * public (surfaced in every OAuth flow), so this identity gate is convention
 * rather than confidentiality: every other action on this tool requires an
 * authenticated identity, and the unauthenticated outlier here was a
 * maintenance trip-wire flagged in PR review.
 */
function handleGetRedirectUri(identity: UserIdentity | null): ToolResult {
  if (!identity) {
    return errResult("Authentication required.");
  }
  return {
    content: textContent("OAuth callback URL."),
    structuredContent: { redirectUri: mcpAuthCallbackUrl() },
    isError: false,
  };
}

// ── Action handlers ──────────────────────────────────────────────────

async function handleListCatalog(
  ctx: ManageConnectorsContext,
  wsId: string | null,
): Promise<ToolResult> {
  const catalog = await ctx.runtime.getConnectorDirectory().catalogEntries();
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
  const directory = ctx.runtime.getConnectorDirectory();

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

  const result = await directory.list({
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

/**
 * `list_bound_skills` — the curated connector-skill overlays materialized
 * in this workspace, with their bound server + provenance source. These are
 * surface-once-into-history candidates, not authored skills, so they don't
 * appear in `skills__list`; this is how an operator sees what's bound.
 */
function handleListBoundSkills(ctx: ManageConnectorsContext, wsId: string | null): ToolResult {
  if (!wsId) {
    return errResult("No workspace in scope — pass `wsId` or call from a workspace.");
  }
  const overlays = ctx.runtime.listConnectorOverlays(wsId);
  const summary = overlays.length
    ? overlays.map((o) => `- ${o.server}: ${o.name}${o.source ? ` (${o.source})` : ""}`).join("\n")
    : "No connector-skill overlays bound in this workspace.";
  return {
    content: textContent(summary),
    structuredContent: { wsId, overlays },
    isError: false,
  };
}

/**
 * One entry of `list_installed`'s response: a connector's install state plus
 * the live probes the Connectors UI renders. `status` is derived last, from
 * every populated flag, by {@link deriveConnectorStatus}.
 */
type InstalledEntry = {
  serverName: string;
  bundleName: string;
  version: string;
  /**
   * The version the running server reports in its MCP `initialize` handshake
   * (serverInfo.version), sanitized. Distinct from `version`, which is the
   * catalog/manifest's *declared* version: this is what's actually connected.
   * Untrusted (the server sets it) and display-only. Absent when the source is
   * stopped or the server reports none.
   */
  handshakeVersion?: string;
  type: "remote" | "local";
  state: string;
  // Stage 2: only workspace-scope connectors exist. Personal connectors
  // live in the caller's personal workspace; the legacy `"user"` arm was
  // removed in T008/T009 — every population site below emits `"workspace"`.
  scope: "workspace";
  interactive: boolean;
  toolCount: number;
  trustScore: number | null;
  /**
   * Brand icon URL. One field for both remote (catalog.iconUrl) and
   * stdio bundles (mpak ServerDetail.icons[0].src by package name) so
   * the UI doesn't fan out across two sources to render the same
   * thing. Falls through to the deterministic letter avatar when
   * unset (e.g. the bundle isn't in any active mpak registry, or
   * the mpak fetch failed).
   */
  iconUrl?: string;
  // Optional — only populated for URL bundles / catalog-matched entries
  url?: string;
  catalogId?: string | null;
  catalog?: ConnectorCatalogEntry;
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

/** Request-scoped inputs shared across every {@link buildInstalledEntry} call. */
interface InstalledEntryDeps {
  ctx: ManageConnectorsContext;
  wsId: string;
  /** One workspace fetch covers oauthOperatorApps lookups for every static-auth
   *  catalog match, rather than one disk read per installed connector. */
  ws: Workspace | null;
  registry: ReturnType<Runtime["getRegistryForWorkspace"]>;
  credStore: FileCredentialStore;
  catalogByUrl: Map<string, ConnectorCatalogEntry>;
  catalogById: Map<string, ConnectorCatalogEntry>;
  mpakIcons: Map<string, string>;
  mpak: ReturnType<typeof getMpak>;
  resolveUserLabel: (userId: string) => Promise<string | undefined>;
  /** When set, `buildInstalledEntry` skips every instance except this one
   *  before any per-instance IO. */
  onlyServerName?: string;
}

/**
 * Match a bundle instance's ref to its catalog entry. Prefers a URL match;
 * composio-backed bundles store a per-install session URL that misses
 * `catalogByUrl`, so they fall back to the catalog id carried on
 * `ref.composio.connectorId` (stamped by the install path alongside the URL).
 */
function resolveInstanceCatalog(
  instance: BundleInstance,
  catalogByUrl: Map<string, ConnectorCatalogEntry>,
  catalogById: Map<string, ConnectorCatalogEntry>,
): { isRemote: boolean; url: string | undefined; cat: ConnectorCatalogEntry | undefined } {
  const ref = instance.ref;
  const isRemote = !!ref && "url" in ref;
  const url = isRemote ? (ref as { url: string }).url : undefined;
  const composioConnectorId =
    isRemote && "composio" in (ref as Record<string, unknown>)
      ? (ref as { composio?: { connectorId?: string } }).composio?.connectorId
      : undefined;
  let cat = url ? catalogByUrl.get(url) : undefined;
  if (!cat && composioConnectorId) {
    cat = catalogById.get(composioConnectorId);
  }
  return { isRemote, url, cat };
}

/**
 * Tool count + reported version from the live source — best-effort (a stopped
 * source returns [] and has no version). `getReportedVersion` is McpSource-
 * specific (not on the ToolSource interface), reached by the same `instanceof`
 * narrowing the system-prompt composer uses for instructions.
 */
async function probeToolCountAndVersion(
  registry: ReturnType<Runtime["getRegistryForWorkspace"]>,
  serverName: string,
): Promise<{ toolCount: number; handshakeVersion: string | undefined }> {
  let toolCount = 0;
  let handshakeVersion: string | undefined;
  try {
    const src = registry.getSource(serverName);
    if (src) {
      toolCount = (await src.tools()).length;
      if (src instanceof McpSource) handshakeVersion = src.getReportedVersion();
    }
  } catch {
    // ignore
  }
  return { toolCount, handshakeVersion };
}

/**
 * Enrich a remote entry with its live OAuth connection state (authorizationUrl,
 * lastError) and the static-auth missing-operator-setup probe.
 */
async function applyRemoteConnectionState(
  entry: InstalledEntry,
  instance: BundleInstance,
  ref: BundleRef,
  url: string,
  cat: ConnectorCatalogEntry | undefined,
  credStore: FileCredentialStore,
  wsId: string,
): Promise<void> {
  entry.url = url;
  entry.catalogId = cat?.id ?? null;
  if (cat) entry.catalog = cat;
  const conn = instance.connections?.get("_workspace") ?? null;
  if (conn?.authorizationUrl) entry.authorizationUrl = conn.authorizationUrl;
  if (conn?.lastError) entry.lastError = conn.lastError;
  const oauthClient = (ref as { oauthClient?: { clientSecret?: { key: string } } }).oauthClient;
  if (oauthClient?.clientSecret) {
    const wrapped = await credStore.get(wsId, oauthClient.clientSecret.key);
    if (!wrapped) entry.missingOperatorSetup = true;
  }
}

/**
 * Attach the workspace's operator OAuth client config (static-auth only). The
 * Configure page reads this to render the "Configured by ... on ..." audit line
 * + Edit affordance. clientId is public; the secret never leaves the store.
 */
async function applyOperatorOAuth(
  entry: InstalledEntry,
  cat: ConnectorCatalogEntry | undefined,
  ws: Workspace | null,
  resolveUserLabel: (userId: string) => Promise<string | undefined>,
): Promise<void> {
  const op = cat?.auth === "static" ? ws?.oauthOperatorApps?.[cat.id] : undefined;
  if (!op) return;
  const label = await resolveUserLabel(op.configuredBy);
  entry.operatorOAuth = {
    clientId: op.clientId,
    configuredAt: op.configuredAt,
    configuredBy: op.configuredBy,
    ...(label ? { configuredByLabel: label } : {}),
  };
}

/**
 * Stdio bundle credential schema + per-field configured probe, driven by the
 * bundle's manifest `user_config` block. Manifest resolution handles both
 * name-installed (mpak cache) and path-installed (read from disk) bundles — the
 * latter is how every Synapse app under local-dev install ends up registered.
 * Best-effort cosmetic data: on a read error the connector surfaces without the
 * bundle-config section rather than failing the whole list_installed call.
 */
async function probeStdioUserConfig(
  ctx: ManageConnectorsContext,
  wsId: string,
  mpak: ReturnType<typeof getMpak>,
  instance: BundleInstance,
): Promise<
  { schema: Record<string, UserConfigFieldDef>; populated: Record<string, boolean> } | undefined
> {
  try {
    const manifest = await readBundleManifest(mpak, instance);
    const schema = manifest?.user_config;
    if (schema && Object.keys(schema).length > 0) {
      const stored =
        (await ctx.runtime.getWorkspaceContext(wsId).getCredentials(instance.bundleName)) ?? {};
      const populated: Record<string, boolean> = {};
      for (const key of Object.keys(schema)) {
        const v = stored[key];
        populated[key] = typeof v === "string" && v.length > 0;
      }
      return { schema, populated };
    }
  } catch {
    // Read errors are best-effort cosmetic data — see the doc comment.
  }
  return undefined;
}

/**
 * Apply the probes appropriate to the entry's transport: remote bundles get
 * their live OAuth connection state + operator OAuth audit config; stdio bundles
 * get the manifest `user_config` schema + configured-state probe.
 */
async function applyTransportSpecificProbes(
  entry: InstalledEntry,
  deps: InstalledEntryDeps,
  instance: BundleInstance,
  isRemote: boolean,
  url: string | undefined,
  cat: ConnectorCatalogEntry | undefined,
): Promise<void> {
  if (isRemote && url) {
    await applyRemoteConnectionState(
      entry,
      instance,
      instance.ref as BundleRef,
      url,
      cat,
      deps.credStore,
      deps.wsId,
    );
    await applyOperatorOAuth(entry, cat, deps.ws, deps.resolveUserLabel);
  }
  if (!isRemote) {
    const userConfig = await probeStdioUserConfig(deps.ctx, deps.wsId, deps.mpak, instance);
    if (userConfig) entry.userConfig = userConfig;
  }
}

/**
 * Build one InstalledEntry for a bundle instance, or null to skip it (wrong
 * workspace, or filtered out by `onlyServerName`). All per-instance IO
 * (tools() round-trip, manifest probe, credential reads) happens here so the
 * single-connector path skips it for every non-matching instance.
 */
async function buildInstalledEntry(
  deps: InstalledEntryDeps,
  instance: BundleInstance,
): Promise<InstalledEntry | null> {
  if (instance.wsId !== deps.wsId) return null;
  if (deps.onlyServerName && instance.serverName !== deps.onlyServerName) return null;

  const { isRemote, url, cat } = resolveInstanceCatalog(
    instance,
    deps.catalogByUrl,
    deps.catalogById,
  );
  const { toolCount, handshakeVersion } = await probeToolCountAndVersion(
    deps.registry,
    instance.serverName,
  );
  // Derive from SANITIZED placements (consistent with the catalog projection),
  // so a sole spoofed placement doesn't light the chip while rendering nothing.
  const interactive =
    cat?.interactive === true || sanitizePlacements(instance.ui?.placements).length > 0;
  // Resolve brand icon once: prefer the static catalog match (remote bundles),
  // fall back to the mpak-by-package-name lookup (stdio). Either may be
  // undefined; the UI handles the missing case with a deterministic letter avatar.
  const iconUrl = cat?.iconUrl ?? deps.mpakIcons.get(instance.bundleName);

  const entry: InstalledEntry = {
    serverName: instance.serverName,
    bundleName: instance.bundleName,
    version: instance.version,
    ...(handshakeVersion ? { handshakeVersion } : {}),
    type: isRemote ? "remote" : "local",
    state: instance.state,
    // Provisional — overwritten by deriveConnectorStatus below once every probe
    // (operatorOAuth, userConfig, lastError) has been resolved on the entry.
    // Initial value satisfies the public InstalledConnector contract that
    // `status` is required.
    status: "ready",
    scope: "workspace",
    interactive,
    toolCount,
    trustScore: instance.trustScore ?? null,
    ...(iconUrl ? { iconUrl } : {}),
  };

  await applyTransportSpecificProbes(entry, deps, instance, isRemote, url, cat);

  // Derive the generic UI status last so it sees every populated probe
  // (operatorOAuth gate, userConfig populated map, lastError).
  const derived = deriveConnectorStatus(entry);
  entry.status = derived.status;
  if (derived.statusReason) entry.statusReason = derived.statusReason;

  return entry;
}

async function handleListInstalled(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  // Stage 2: callerId no longer disambiguates between workspace-scope
  // and user-scope views (the latter was removed). Kept for signature
  // stability across `handleGetInstalled`; ignored.
  _callerId: string | null,
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
  // One directory instance per request — its memoized `servers()`
  // means catalogByUrl + iconByPackage share a single fetch even
  // though they're called separately. Reaching for the lookup tables
  // (rather than the raw catalog list + manual map-build) keeps the
  // construction concern inside the facade.
  const directory = ctx.runtime.getConnectorDirectory();
  const catalogByUrl = await directory.catalogByUrl();
  // O(1) catalog lookups for composio-backed bundles whose persisted
  // `ref.url` is a per-install Composio session URL and therefore
  // misses `catalogByUrl`. Built once per request.
  const catalogById = await directory.catalogByIdMap();
  // Stdio bundles aren't keyable by URL — they're matched to their
  // mpak `ServerDetail` by the package identifier on the bundle
  // instance (`@scope/name`). Best-effort: a down mpak registry just
  // means stdio cards fall back to the deterministic letter avatar.
  const mpakIcons = await directory.iconByPackage();

  const installed: InstalledEntry[] = [];

  // Resolve operator OAuth audit labels lazily so the most common
  // installed-list shape (no static-auth connectors) does no extra IO.
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
  // Resolved mpak home — the SAME (absolute) string the lifecycle is
  // constructed with, so `getMpak()`'s singleton is shared rather than
  // thrashed. Don't hand-build `join(workDir, "apps")`: `getWorkDir()` isn't
  // pre-resolved, so under a relative dev `workDir` it would key a second SDK
  // instance on a relative string for the same dir.
  const mpak = getMpak(ctx.runtime.getMpakHome());

  // Workspace-scope entries: walk every bundle visible in the workspace
  // registry (includes local stdio, local URL, Synapse apps, and remote
  // OAuth). The `list_apps` tool surfaces the same registry-installed set.
  //
  // Read directly from the lifecycle's instance map. The shorthand
  // `getBundleInstancesForWorkspace` additionally filters by
  // `wsRegistry.sourceNames()` — appropriate for the agent's app list
  // (disconnected bundle = unusable for tool calls), wrong for the
  // management UI. After Disconnect we tear down the McpSource
  // intentionally; the bundle is still INSTALLED and the user needs to see
  // it on this page to click Connect again.
  if ((scope === "all" || scope === "workspace") && wsId) {
    const deps: InstalledEntryDeps = {
      ctx,
      wsId,
      ws: await ctx.runtime.getWorkspaceStore().get(wsId),
      registry: ctx.runtime.getRegistryForWorkspace(wsId),
      credStore,
      catalogByUrl,
      catalogById,
      mpakIcons,
      mpak,
      resolveUserLabel,
      ...(onlyServerName ? { onlyServerName } : {}),
    };
    for (const instance of lifecycle.getInstances()) {
      const entry = await buildInstalledEntry(deps, instance);
      if (entry) installed.push(entry);
    }
  }

  // Stage 2: user-scope walk removed. Personal connectors now appear
  // under the user's personal workspace at `ws_user_<userId>` — same
  // workspace-scope rendering path as any other workspace.

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
 *
 * Defense-in-depth on the wire payload: `parseDirectoryEntry` re-runs
 * the value-shape gate (`SCOPED_PACKAGE_RE` for mpak packages,
 * `isHttpUrl` for remote URLs, reserved-OAuth-params for the install
 * action). The entry came from a client over the tool surface, not
 * directly from a trusted source instance, so trust-but-verify at the
 * dispatch boundary catches a tampered payload regardless of which
 * registry a well-formed analog originally came from.
 *
 * Cross-cutting checks (admin allow-list) apply to every install
 * kind and live above the dispatch.
 */
async function handleInstall(
  ctx: ManageConnectorsContext,
  identity: UserIdentity | null,
  rawEntry: unknown,
  wsIdArg: string | undefined,
): Promise<ToolResult> {
  const entry = parseDirectoryEntry(rawEntry);
  if (!entry) return errResult("entry with install action is required.");
  if (!identity) return errResult("Authentication required.");

  // `wsId` is REQUIRED for every install, but it resolves to the request's
  // workspace by default (X-Workspace-Id, set from the `/w/<slug>` route the
  // web shell is on) — the dispatcher passes `ctx.getWorkspaceId()` when no
  // explicit arg is given. There is still no default-to-personal fallback
  // (Stage 1 precedent: `startBundleSource` hard-errors on missing wsId;
  // pooling credentials across tenants via a silent default is the failure
  // mode this guard forecloses). A client that calls this action with
  // neither a workspace header nor a `wsId` arg hits the guard below.
  const wsId = wsIdArg?.trim() ? wsIdArg.trim() : null;
  if (!wsId) {
    return errResult(
      "wsId is required for install. The web shell installs into the " +
        "workspace named by the request (X-Workspace-Id / the /w/<slug> " +
        "route); clients calling this action directly must supply a " +
        "workspace via that header or an explicit wsId argument. There is " +
        "no default-to-personal fallback inside this tool.",
    );
  }
  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return errResult(`Workspace "${wsId}" not found.`);

  // Admin role gates every install — workspace-shared connectors widen
  // the workspace's tool / credential surface for every member, and
  // personal workspaces invariably have the owner as admin (Stage 1
  // invariant), so this gate also covers the personal-install path
  // uniformly.
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

  // A personal workspace is a CONNECTOR space: it holds the user's own remote
  // MCP connections (Gmail/Granola/Composio/…), which they can grant into shared
  // rooms. Only `remote-oauth` (a remote MCP connection) is admitted; `mpak-bundle`
  // / local installs belong in a shared workspace. This keeps "a bundle in your
  // personal workspace" == "a grantable personal connector" TRUE BY CONSTRUCTION,
  // so grant / surfacing / dispatch need no per-bundle connector check — and it
  // avoids the legacy `upjack` app/connector flag entirely (the discriminator is
  // the install kind, i.e. whether it's a remote MCP connection).
  if (ws.isPersonal === true && entry.install.kind !== "remote-oauth") {
    return errResult(
      `Your personal workspace is for connectors — remote MCP connections. ` +
        `"${entry.id}" installs as a "${entry.install.kind}" bundle; install it into a shared workspace instead.`,
    );
  }

  switch (entry.install.kind) {
    case "remote-oauth":
      return handleInstallRemoteOAuth(ctx, wsId, ws, entry);
    case "mpak-bundle":
      return handleInstallMpak(ctx, wsId, entry);
    case "direct-url":
      return errResult("direct-url install is not yet supported.");
  }
}

/**
 * `connect_api_key` — authenticate an already-installed Composio connector
 * whose toolkit uses a non-redirect (API-key) auth scheme. The API-key sibling
 * of the OAuth `/v1/composio-auth/initiate` route: there is no browser
 * redirect, so it's a tool action, not a route (no state cookie, no callback —
 * the two reasons that path stays a route). The web shell renders a form from
 * the connector's declared `composio.fields` and submits the values here.
 *
 * Trust posture (mirrors the OAuth path):
 *  - The connector, its field declarations, and its auth-config env all come
 *    from the SERVER-trusted catalog (`catalogById`), never the caller. The
 *    only caller input is the connectorId and the field *values*.
 *  - Field values are handed to Composio and NEVER persisted by the platform —
 *    `connection.json` keeps only the opaque `connectedAccountId`, exactly like
 *    the OAuth path. We don't custody the user's key.
 *  - Membership-gated: the workspace-scoped tool routing already authorized the
 *    caller as a member of `wsId` (the same level as the OAuth connect route's
 *    `requireWorkspace`). Install — which widens the workspace surface — is
 *    admin-gated; completing auth on an installed connector is member-level.
 */
async function handleConnectApiKey(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  catalogId: string,
  rawFields: Record<string, unknown>,
): Promise<ToolResult> {
  if (!identity) return errResult("Authentication required.");
  if (!wsId) return errResult("wsId is required for connect_api_key.");
  if (!catalogId) return errResult("catalogId is required for connect_api_key.");

  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return errResult(`Workspace "${wsId}" not found.`);

  const connector = await loadComposioApiKeyConnector(ctx, catalogId);
  if ("error" in connector) return errResult(connector.error);
  const { entry, composio } = connector;

  // Validate submitted values against the declared fields: every required field
  // present and non-empty; unknown keys rejected (default-deny, same posture as
  // set_user_config). Only declared keys are forwarded to Composio.
  const collected = collectApiKeyFields(composio, catalogId, rawFields);
  if ("error" in collected) return errResult(collected.error);
  const { values } = collected;

  const env = resolveComposioApiKeyEnv(entry.name, composio.authConfigEnv);
  if ("error" in env) return errResult(env.error);
  const { apiKey, authConfigId } = env;

  const serverName = slugifyServerName(catalogId);
  const userId = composioUserId(wsId);
  const lifecycle = ctx.runtime.getLifecycle();
  const workDir = ctx.runtime.getWorkDir();

  // Capture any prior connected account up front: it both gates the rotation
  // case below and is the id we revoke after a successful replace. We can't
  // adopt-existing like the OAuth path — an API-key re-submit may carry a
  // rotated key, so the old account is REPLACED, not reused.
  const prior = await readComposioConnection(workDir, wsId, catalogId);

  // Authz: a FIRST connect (no prior) is member-level, matching the OAuth
  // connect route. But a RE-CONNECT/rotation replaces and revokes the shared
  // credential every member's agent runs under — destructive like `disconnect`,
  // which is admin-gated. So gate only the rotation case on workspace admin.
  if (prior?.connectedAccountId && !isWorkspaceAdmin(ws, identity)) {
    return {
      content: textContent(
        "Workspace admin role required to replace an already-connected connector's credential.",
      ),
      structuredContent: { error: "permission_denied" },
      isError: true,
    };
  }

  const regError = await registerApiKeySource(lifecycle, serverName, wsId, workDir, ws, catalogId);
  if (regError) return errResult(regError);

  const connected = await performComposioApiKeyConnect(
    { apiKey, userId, authConfigId, fields: values },
    catalogId,
    wsId,
  );
  if ("error" in connected) return errResult(connected.error);

  const connection: ComposioConnection = {
    connectedAccountId: connected.connectedAccountId,
    toolkit: composio.toolkit,
    userId,
    connectedAt: new Date().toISOString(),
    status: connected.status,
  };
  await saveComposioConnection(workDir, wsId, catalogId, connection);
  lifecycle.recordConnectionStateChange(serverName, wsId, WORKSPACE_PRINCIPAL_ID, "running");

  await revokeReplacedComposioAccount(apiKey, prior, connected.connectedAccountId, catalogId, wsId);

  return {
    content: textContent(`Connected ${entry.name}.`),
    structuredContent: { connected: true, serverName, status: connected.status },
    isError: false,
  };
}

type ComposioConfig = NonNullable<ConnectorCatalogEntry["composio"]>;
type ComposioApiKeyFields = NonNullable<ComposioConfig["fields"]>;

/**
 * Fetch + validate the catalog entry named by `connect_api_key`: it must be a
 * Composio-backed connector whose toolkit uses the non-redirect API-key auth
 * scheme. Returns the narrowed composio block on success.
 */
async function loadComposioApiKeyConnector(
  ctx: ManageConnectorsContext,
  catalogId: string,
): Promise<{ entry: ConnectorCatalogEntry; composio: ComposioConfig } | { error: string }> {
  const entry = await ctx.runtime.getConnectorDirectory().catalogById(catalogId);
  if (!entry) return { error: `Connector "${catalogId}" not in catalog.` };
  if (entry.auth !== "composio" || !entry.composio) {
    return { error: `Connector "${catalogId}" is not Composio-backed (auth=${entry.auth}).` };
  }
  if (entry.composio.authScheme !== "API_KEY") {
    return {
      error: `Connector "${catalogId}" does not use API-key auth (authScheme=${
        entry.composio.authScheme ?? "OAUTH2"
      }). Use the OAuth connect flow instead.`,
    };
  }
  return { entry, composio: entry.composio };
}

/**
 * Coerce declared API-key fields to trimmed string values. Every required field
 * must be present and non-empty; blank optional fields are skipped.
 */
function coerceApiKeyValues(
  declared: ComposioApiKeyFields,
  rawFields: Record<string, unknown>,
): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (const field of declared) {
    const raw = rawFields[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      if (field.required !== false) {
        return { error: `Field "${field.key}" (${field.title}) is required.` };
      }
      continue;
    }
    values[field.key] = value;
  }
  return { values };
}

/**
 * Validate submitted API-key values against the connector's declared fields: at
 * least one field declared, unknown keys rejected (default-deny), required
 * fields present. Only declared keys are forwarded to Composio.
 */
function collectApiKeyFields(
  composio: ComposioConfig,
  catalogId: string,
  rawFields: Record<string, unknown>,
): { values: Record<string, string> } | { error: string } {
  const declared = composio.fields ?? [];
  if (declared.length === 0) {
    return { error: `Connector "${catalogId}" declares no API-key fields to collect.` };
  }
  const declaredKeys = new Set(declared.map((f) => f.key));
  for (const key of Object.keys(rawFields)) {
    if (!declaredKeys.has(key)) {
      return { error: `Unknown field "${key}" for connector "${catalogId}".` };
    }
  }
  return coerceApiKeyValues(declared, rawFields);
}

/**
 * Resolve the platform-env Composio credentials for an API-key connect. Missing
 * keys are a deploy-time error; surface a clear (non-secret) message.
 */
function resolveComposioApiKeyEnv(
  entryName: string,
  authConfigEnv: string,
): { apiKey: string; authConfigId: string } | { error: string } {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    return {
      error:
        `"${entryName}" requires COMPOSIO_API_KEY in the platform env. ` +
        "Set the platform-wide Composio API key and restart the API.",
    };
  }
  const authConfigId = process.env[authConfigEnv]?.trim();
  if (!authConfigId) {
    return {
      error:
        `"${entryName}" requires ${authConfigEnv} in the platform env. ` +
        "Create the API_KEY auth config in the Composio dashboard and set the env var.",
    };
  }
  return { apiKey, authConfigId };
}

/**
 * Bring the MCP source online before connection.json is persisted (the OAuth
 * adopt path's ordering invariant, so boot-state derivation stays honest). A
 * connector with no ref yet has never been installed, so this doubles as the
 * "install first" guard. Returns an error string, or null on success.
 */
async function registerApiKeySource(
  lifecycle: ReturnType<Runtime["getLifecycle"]>,
  serverName: string,
  wsId: string,
  workDir: string,
  ws: Workspace,
  catalogId: string,
): Promise<string | null> {
  try {
    await lifecycle.ensureSourceRegistered(serverName, wsId, workDir);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[connect_api_key] source registration failed for ${catalogId} in ${wsId}: ${msg}`);
    // Two distinct causes share this branch: the connector isn't installed (no
    // ref) vs. it IS installed but the MCP source transiently failed to start.
    // Distinguish on whether a ref exists so the message points at the right
    // fix (mirrors the OAuth adopt path's two messages).
    const isInstalled =
      Array.isArray(ws.bundles) && ws.bundles.some((b) => b.serverName === serverName);
    return isInstalled
      ? `Connector "${catalogId}" is installed but its MCP source could not start. ` +
          "Try Disconnect, then Connect again."
      : `Connector "${catalogId}" must be installed before connecting. ` +
          "Install it, then submit the API key.";
  }
}

/**
 * Hand the key(s) to Composio and verify the connection reaches ACTIVE. On
 * failure the SDK helper deletes the half-created account; surface a generic
 * message and never echo the submitted values.
 */
async function performComposioApiKeyConnect(
  params: { apiKey: string; userId: string; authConfigId: string; fields: Record<string, string> },
  catalogId: string,
  wsId: string,
): Promise<{ connectedAccountId: string; status: string } | { error: string }> {
  try {
    return await connectComposioApiKey(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[connect_api_key] Composio connect failed for ${catalogId} in ${wsId}: ${msg}`);
    return {
      error:
        "Could not connect with the provided credentials. Check the key (and any " +
        "region / subdomain) and try again.",
    };
  }
}

/**
 * Rotation cleanup: revoke the account just replaced so a rotated-away key stops
 * being authorized at Composio and orphans don't accumulate. Runs after the new
 * account is persisted. Best-effort — deleteComposioConnectedAccount never
 * throws; on failure the prior key may linger at Composio until removed there.
 */
async function revokeReplacedComposioAccount(
  apiKey: string,
  prior: ComposioConnection | null,
  newAccountId: string,
  catalogId: string,
  wsId: string,
): Promise<void> {
  if (!prior?.connectedAccountId || prior.connectedAccountId === newAccountId) return;
  const revoked = await deleteComposioConnectedAccount({
    apiKey,
    connectedAccountId: prior.connectedAccountId,
  });
  if (!revoked) {
    log.warn(
      `[connect_api_key] could not revoke the replaced Composio account for ${catalogId} ` +
        `in ${wsId}; the prior key may remain authorized until removed at Composio`,
    );
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
  if (!isValidInstallKind(install.kind)) return null;
  if (!isInstallPayloadValid(install)) return null;
  // additionalAuthorizationParams live at `install.additionalAuthorizationParams`
  // per RemoteOAuthInstall (src/registries/types.ts), NOT on the top-level entry.
  const additionalParams = (install as { additionalAuthorizationParams?: unknown })
    .additionalAuthorizationParams;
  if (!areAdditionalAuthParamsValid(additionalParams)) return null;
  return input as DirectoryEntry;
}

/** The closed set of install action kinds the dispatch understands. */
function isValidInstallKind(kind: unknown): boolean {
  return kind === "remote-oauth" || kind === "mpak-bundle" || kind === "direct-url";
}

/**
 * Per-kind value-shape gate: mpak packages must be a scoped npm-style name
 * (`@scope/name`, the shape mpak's registry accepts); remote-oauth URLs must
 * parse as `http(s):` (the protocol allowlist that keeps a malformed entry from
 * slipping a `javascript:` / `data:` / `file:` URL into bundle creation).
 * direct-url has no value-shape check yet (parked behind an errResult).
 */
function isInstallPayloadValid(install: {
  kind?: unknown;
  package?: unknown;
  url?: unknown;
}): boolean {
  if (install.kind === "mpak-bundle") {
    return typeof install.package === "string" && SCOPED_PACKAGE_RE.test(install.package);
  }
  if (install.kind === "remote-oauth") {
    return typeof install.url === "string" && isHttpUrl(install.url);
  }
  return true;
}

/**
 * Gate `install.additionalAuthorizationParams`: absent is fine, otherwise it
 * must be a plain string→string map with no reserved OAuth keys (`client_id`,
 * `redirect_uri`, `state`, ...). Rejecting them here at the parse boundary
 * (rather than only at install) gives a source-tagged warning that names the
 * offending entry rather than a generic install-time error.
 */
function areAdditionalAuthParamsValid(additionalParams: unknown): boolean {
  if (additionalParams === undefined) return true;
  if (
    !additionalParams ||
    typeof additionalParams !== "object" ||
    Array.isArray(additionalParams) ||
    !Object.values(additionalParams as Record<string, unknown>).every((v) => typeof v === "string")
  ) {
    return false;
  }
  try {
    validateAdditionalAuthorizationParams(additionalParams as Record<string, string>);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remote OAuth install — targets the explicit `wsId` passed in by the
 * dispatcher (the request's active workspace). Every workspace — personal
 * or shared — is a valid target: install, boot-state derivation, and
 * disconnect cleanup are all keyed purely on `wsId`, so the credential
 * layout under `credentials/composio/<connectorId>/` works identically
 * regardless of the target's `isPersonal` flag. Static-auth entries
 * require operator OAuth client config persisted under
 * `workspace.json#oauthOperatorApps[entry.id]` + the matching
 * client_secret in the credential store before this can proceed.
 */
async function handleInstallRemoteOAuth(
  ctx: ManageConnectorsContext,
  wsId: string,
  ws: Workspace,
  entry: DirectoryEntry,
): Promise<ToolResult> {
  if (entry.install.kind !== "remote-oauth") {
    return errResult("invariant violated: handleInstallRemoteOAuth requires remote-oauth entry");
  }

  // Cheap entry-shape validation up front (fail fast, no IO beyond the catalog
  // lookup a `provider` install needs). For `provider` entries the security-
  // critical fields are re-resolved from the server-trusted catalog and the
  // caller's discarded. The expensive remote work — Composio session create,
  // operator credential read — is deferred until after the dedup check so a
  // duplicate-install click doesn't burn an upstream Composio session.
  const validated = await validateRemoteOAuthInstall(ctx, entry, entry.install);
  if ("error" in validated) return errResult(validated.error);
  const action = validated.action;

  // Host UI placement (sidebar app, etc.) is SERVER-authored metadata. Resolve
  // it from the operator-trusted catalog by id — never the caller-supplied
  // entry — so a forged entry can't inject host chrome. Cached by the directory
  // facade. Undefined when the id isn't a known catalog connector or it declares
  // no UI. Placements are re-validated at registration (`sanitizePlacements`).
  const trustedUi = (await ctx.runtime.getConnectorDirectory().catalogById(entry.id))?.ui;

  // serverName is the slugified canonical reverse-DNS form — opaque,
  // URL-safe, filesystem-safe, collision-free by construction. See
  // `slugifyServerName` for the rule. mpak install path mirrors this.
  const serverName = slugifyServerName(entry.id);

  const lifecycle = ctx.runtime.getLifecycle();

  // Single install pipeline keyed on the explicit `wsId` the caller supplied.
  // The personal vs shared-workspace distinction is a property of the target
  // workspace (`ws.isPersonal`), not a separate code path — both produce the
  // same `BundleRef` shape and the same workspace-scoped credential layout.
  // Personal-target installs surface a different message string in `content`
  // but identical `structuredContent`.
  const isPersonalTarget = ws.isPersonal === true;

  // Dedup (which self-heals an orphaned workspace.json entry) short-circuits
  // before any expensive wiring so a re-click doesn't burn a Composio session.
  const dupResult = handleDuplicateInstall(
    ctx,
    wsId,
    ws,
    entry,
    action,
    serverName,
    isPersonalTarget,
  );
  if (dupResult) return dupResult;

  // Fresh-install: resolve the wiring now that we know we're going to commit.
  const wiring = await resolveInstallWiring(ctx, wsId, ws, entry, action);
  if ("error" in wiring) return errResult(wiring.error);
  const ref = buildRemoteBundleRef(
    action,
    serverName,
    entry.id,
    trustedUi,
    wiring.composioWiring,
    wiring.staticOAuthClient,
  );
  // Bind the curated connector-skill overlay, if one is curated for this
  // connector's identity. Best-effort + non-fatal (see `syncBoundSkills`): the
  // returned lock rides the persisted ref so uninstall cleans it up and the
  // dedupe path knows the connector has an overlay. The overlay materializes
  // into the workspace's `connector-skills/` store, NEVER the system prompt.
  const skillsLock = await lifecycle.syncBoundSkills(
    connectorSkillIdentityFrom(
      action.auth === "composio" ? action.composio?.toolkit : undefined,
      serverName,
    ),
    serverName,
    wsId,
    ctx.runtime.getWorkDir(),
  );
  if (skillsLock.length > 0) ref.skillsLock = skillsLock;
  await ctx.runtime.getWorkspaceStore().update(wsId, { bundles: [...ws.bundles, ref] });
  const wsRegistry = ctx.runtime.getRegistryForWorkspace(wsId);
  lifecycle.seedInstance(serverName, action.url, ref, undefined, wsId, undefined, wsRegistry);
  lifecycle.notifyInstalled(serverName, wsId);

  // Static-credential URL bundles authenticate without an MCP-side OAuth flow,
  // so eager-start the source here rather than waiting for the next platform
  // boot. For static / dcr bundles, source.start() is bound to
  // `lifecycle.startAuth` (called from `/v1/mcp-auth/initiate`) and doesn't run
  // here. Eager-start is a UX optimization; a failure returns a warning, not an
  // error, because the install itself has still succeeded.
  let startWarning: string | undefined;
  if (action.auth === "composio" || action.auth === "provider") {
    startWarning = await eagerStartRemoteSource(ctx, ref, wsRegistry, wsId, entry, action);
  }
  return {
    content: textContent(remoteInstallMessage(entry.name, isPersonalTarget, startWarning)),
    structuredContent: {
      ok: true,
      alreadyInstalled: false,
      serverName,
      scope: "workspace",
      wsId,
      ...(startWarning ? { warning: startWarning } : {}),
    },
    isError: false,
  };
}

/**
 * Composio-auth install prerequisites: the composio config block plus the
 * platform-env credentials it names. Returns an error string, or null when the
 * install isn't composio-auth or every prerequisite is present.
 */
function validateComposioInstall(action: RemoteOAuthInstall, entryName: string): string | null {
  if (action.auth !== "composio") return null;
  if (!action.composio) {
    return `"${entryName}" is composio-auth but missing composio config block.`;
  }
  if (!process.env.COMPOSIO_API_KEY?.trim()) {
    return (
      `"${entryName}" requires COMPOSIO_API_KEY in the platform env. ` +
      "Set the platform-wide Composio API key and restart the API."
    );
  }
  if (!process.env[action.composio.authConfigEnv]?.trim()) {
    return (
      `"${entryName}" requires ${action.composio.authConfigEnv} in the platform env. ` +
      "Create the auth config in the Composio dashboard and set the env var."
    );
  }
  return null;
}

/**
 * Cheap up-front entry-shape validation. For `auth: "provider"` the security-
 * critical fields (url + providerAuth) are re-resolved from the SERVER-trusted
 * catalog by id and the caller's discarded — a provider install mints a
 * fleet-trusted, workspace-scoped service token and ships it to the entry's URL,
 * so a workspace admin could otherwise forge an entry with an arbitrary url +
 * audience/scope and exfiltrate a fleet token or reach an in-cluster `.svc` the
 * SSRF guard protects. Returns the (possibly-rewritten) action, or an error.
 */
async function validateRemoteOAuthInstall(
  ctx: ManageConnectorsContext,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
): Promise<{ action: RemoteOAuthInstall } | { error: string }> {
  const composioErr = validateComposioInstall(action, entry.name);
  if (composioErr) return { error: composioErr };
  if (action.auth === "static" && !action.operatorSetup) {
    return { error: `"${entry.name}" is static-auth but missing operatorSetup config.` };
  }
  if (action.auth === "provider") {
    const trusted = await ctx.runtime.getConnectorDirectory().catalogById(entry.id);
    if (!trusted || trusted.auth !== "provider" || !trusted.providerAuth) {
      return {
        error: `"${entry.name}" is not a recognized platform connector — refusing a provider-auth install from an unverified entry.`,
      };
    }
    return { action: { ...action, url: trusted.url, providerAuth: trusted.providerAuth } };
  }
  return { action };
}

/**
 * Scrub the Composio session's response headers for persistence: drop the
 * `x-api-key` (re-added from the env template at transport build time) and
 * substitute any inlined copy of the API key with the env placeholder so the
 * secret never lands in workspace.json. `replaceAll` handles a future response
 * shape that repeats the key twice in one value.
 */
function scrubComposioHeaders(
  headers: Record<string, string> | undefined,
  apiKey: string,
): Record<string, string> {
  const extraHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === "x-api-key") continue;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate placeholder — resolved by `resolveEnvTemplate` at transport build time
    extraHeaders[k] = v.includes(apiKey) ? v.replaceAll(apiKey, "${COMPOSIO_API_KEY}") : v;
  }
  return extraHeaders;
}

/**
 * Composio MCP wiring (session URL + transport + x-api-key template). Called
 * only on the fresh-install branch — gating it on dedup means a re-click on an
 * installed connector doesn't initiate a new upstream Composio session and
 * orphan the prior one. The API-key template is held verbatim in workspace.json;
 * `createRemoteTransport` resolves it from `process.env.COMPOSIO_API_KEY` at
 * start time so the secret never sits at rest.
 */
async function buildComposioWiring(
  action: RemoteOAuthInstall,
  wsId: string,
  entryName: string,
): Promise<{ url: string; transport: RemoteTransportConfig } | { __err: string }> {
  if (action.auth !== "composio" || !action.composio) {
    // Unreachable — guards above ensure the shape. Typed for the caller's
    // narrowing convenience.
    return { __err: "composio wiring requested for non-composio install" };
  }
  const userId = composioUserId(wsId);
  let sessionMcp: { type: "http" | "sse"; url: string; headers?: Record<string, string> };
  try {
    sessionMcp = await createComposioSession({
      apiKey: (process.env.COMPOSIO_API_KEY ?? "").trim(),
      userId,
      toolkit: action.composio.toolkit,
      authConfigId: (process.env[action.composio.authConfigEnv] ?? "").trim(),
      ...(action.composio.tools && action.composio.tools.length > 0
        ? { tools: action.composio.tools }
        : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { __err: `Composio session creation failed for "${entryName}": ${msg}` };
  }
  const apiKey = (process.env.COMPOSIO_API_KEY ?? "").trim();
  const extraHeaders = scrubComposioHeaders(sessionMcp.headers, apiKey);
  return {
    url: sessionMcp.url,
    transport: {
      type: sessionMcp.type === "sse" ? "sse" : "streamable-http",
      auth: {
        type: "header",
        name: "x-api-key",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate placeholder — resolved by `resolveEnvTemplate` at transport build time
        value: "${COMPOSIO_API_KEY}",
      },
      ...(Object.keys(extraHeaders).length > 0 ? { headers: extraHeaders } : {}),
    },
  };
}

/**
 * Static-auth wiring: the workspace's configured operator OAuth clientId + the
 * credential-store key holding its client_secret. Gated post-dedup so a
 * duplicate-install click doesn't read the operator credential from disk.
 * Returns `__err` when setup is incomplete.
 */
async function loadStaticOAuthClient(
  ctx: ManageConnectorsContext,
  wsId: string,
  ws: Workspace,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
): Promise<{ clientId: string; clientSecretKey: string } | { __err: string }> {
  if (action.auth !== "static" || !action.operatorSetup) {
    return { __err: "static-auth wiring requested for non-static install" };
  }
  const setup = action.operatorSetup;
  const operatorApp = ws.oauthOperatorApps?.[entry.id];
  if (!operatorApp?.clientId) {
    return {
      __err: `"${entry.name}" needs operator setup before install. Configure the OAuth app at ${setup.portalUrl} and use Set up.`,
    };
  }
  const credStore = new FileCredentialStore(ctx.runtime.getWorkDir());
  const secret = await credStore.get(wsId, setup.clientSecretKey);
  if (!secret) {
    return {
      __err: `Operator client_secret for "${entry.name}" is missing — re-run Set up to seed it.`,
    };
  }
  return { clientId: operatorApp.clientId, clientSecretKey: setup.clientSecretKey };
}

/**
 * Build the BundleRef from the resolved wiring (composio session URL +
 * transport, or static client credentials). Constructed on the fresh-install
 * branch only; the dedup branches re-use the existing persisted ref.
 */
function buildRemoteBundleRef(
  action: RemoteOAuthInstall,
  serverName: string,
  entryId: string,
  trustedUi: ConnectorCatalogEntry["ui"],
  composioWiring: { url: string; transport: RemoteTransportConfig } | undefined,
  staticOAuthClient: { clientId: string; clientSecretKey: string } | undefined,
): BundleRef {
  return {
    url: composioWiring?.url ?? action.url,
    serverName,
    // Pin the transport class the source advertised. Default would be
    // streamable-http (createRemoteTransport's fallback), which is wrong for
    // vendors whose remote `type` is `sse` — PayPal / Cloudflare / Webflow / Wix
    // in the bundled catalog today. A `provider`-auth entry also carries its
    // credential class here: provider + config are copied VERBATIM from the
    // (operator-authored) catalog entry — never tenant input — which is what
    // makes a self-installable platform connector safe.
    transport:
      composioWiring?.transport ??
      (action.auth === "provider" && action.providerAuth
        ? {
            type: action.transportType,
            auth: {
              type: "provider",
              provider: action.providerAuth.provider,
              config: action.providerAuth.config,
            },
          }
        : { type: action.transportType }),
    // Post-Stage-2: every ref's oauthScope is "workspace". The install targets
    // the request's active workspace; the ref carries no per-target scope literal.
    oauthScope: "workspace",
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
    // Composio marker — carries the catalog id so the lifecycle's boot-time
    // state derivation can probe the right `connection.json` path under
    // `credentials/composio/<connectorId>/`.
    ...(action.auth === "composio" ? { composio: { connectorId: entryId } } : {}),
    // Host UI placement from the operator-trusted catalog (see `trustedUi`).
    // Persisted on the ref so the placement survives restarts; the lifecycle
    // registers + re-validates it via `startBundleSource` → `instance.ui`.
    ...(trustedUi ? { ui: trustedUi } : {}),
  };
}

/**
 * Dedup check for a remote-OAuth install. Returns the appropriate ToolResult
 * (already-installed, or a self-healed reattach when workspace.json has the
 * entry but the lifecycle lost the instance), or null for a fresh install.
 *
 * Dedups primarily on `serverName` — the canonical lifecycle key, derived from
 * `entry.id` and stable across installs. Matching on `b.url` would miss
 * composio-backed bundles whose persisted `b.url` is the per-install session URL
 * and never equals the catalog placeholder `action.url`. Falls back to URL match
 * for legacy bundles persisted before slugify-on-install (no `serverName` field).
 */
function handleDuplicateInstall(
  ctx: ManageConnectorsContext,
  wsId: string,
  ws: Workspace,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
  serverName: string,
  isPersonalTarget: boolean,
): ToolResult | null {
  const lifecycle = ctx.runtime.getLifecycle();
  const dup = ws.bundles.find((b) => {
    if (!("url" in b)) return false;
    if ("serverName" in b && b.serverName) return b.serverName === serverName;
    return b.url === action.url;
  });
  if (!dup) return null;
  const dupServerName = "serverName" in dup ? (dup.serverName ?? serverName) : serverName;
  // Self-heal: workspace.json says yes but lifecycle lost the instance (prior
  // uninstall that didn't clean workspace.json). Re-seed instead of reporting
  // alreadyInstalled — the latter would skip seedInstance and fail the next
  // OAuth initiate.
  if (!lifecycle.getInstance(dupServerName, wsId)) {
    const wsRegistry = ctx.runtime.getRegistryForWorkspace(wsId);
    lifecycle.seedInstance(dupServerName, action.url, dup, undefined, wsId, undefined, wsRegistry);
    lifecycle.notifyInstalled(dupServerName, wsId);
    return {
      content: textContent(`Reattached "${entry.name}" (recovered orphan entry).`),
      structuredContent: {
        ok: true,
        alreadyInstalled: false,
        serverName: dupServerName,
        scope: "workspace",
        wsId,
      },
      isError: false,
    };
  }
  return {
    content: textContent(
      isPersonalTarget
        ? `"${entry.name}" already installed in your personal workspace.`
        : `"${entry.name}" already installed.`,
    ),
    structuredContent: {
      ok: true,
      alreadyInstalled: true,
      serverName: dupServerName,
      scope: "workspace",
      wsId,
    },
    isError: false,
  };
}

/**
 * Resolve the fresh-install wiring for a remote-OAuth entry: the Composio
 * session (composio-auth) or the operator OAuth client (static-auth). Deferred
 * until after dedup so a duplicate-install click never burns a Composio session
 * or reads the credential. Returns `{}` for auth kinds needing neither.
 */
async function resolveInstallWiring(
  ctx: ManageConnectorsContext,
  wsId: string,
  ws: Workspace,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
): Promise<
  | {
      composioWiring?: { url: string; transport: RemoteTransportConfig };
      staticOAuthClient?: { clientId: string; clientSecretKey: string };
    }
  | { error: string }
> {
  if (action.auth === "composio") {
    const composioWiring = await buildComposioWiring(action, wsId, entry.name);
    if ("__err" in composioWiring) return { error: composioWiring.__err };
    return { composioWiring };
  }
  if (action.auth === "static") {
    const staticOAuthClient = await loadStaticOAuthClient(ctx, wsId, ws, entry, action);
    if ("__err" in staticOAuthClient) return { error: staticOAuthClient.__err };
    return { staticOAuthClient };
  }
  return {};
}

/**
 * Eager-start a freshly-installed static-credential source (composio / provider)
 * so the tool list is available immediately, rather than waiting for the next
 * platform boot. Returns a warning string on failure — the install itself has
 * still succeeded (BundleRef persisted, seedInstance run), and the next Connect
 * click runs the same start path.
 */
async function eagerStartRemoteSource(
  ctx: ManageConnectorsContext,
  ref: BundleRef,
  wsRegistry: ReturnType<Runtime["getRegistryForWorkspace"]>,
  wsId: string,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
): Promise<string | undefined> {
  try {
    await startBundleSource(ref, wsRegistry, ctx.runtime.getEventSink(), undefined, {
      allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
      wsId,
      workDir: ctx.runtime.getWorkDir(),
      bundleMcp: ctx.runtime.getBundleMcpDeps(wsId),
    });
    return undefined;
  } catch (err) {
    const startWarning = err instanceof Error ? err.message : String(err);
    log.warn(
      `[connector-tools] ${action.auth} eager-start failed for ${entry.name} in ${wsId} ` +
        `(install succeeded; click Connect to retry): ${startWarning}`,
    );
    return startWarning;
  }
}

/**
 * Success `content` string for a remote-OAuth install, folding the
 * personal-workspace and eager-start-failed variants.
 */
function remoteInstallMessage(
  entryName: string,
  isPersonalTarget: boolean,
  startWarning: string | undefined,
): string {
  if (startWarning) {
    return `Installed "${entryName}" in ${
      isPersonalTarget ? "your personal workspace" : "this workspace"
    }. Source eager-start failed (${startWarning}) — click Connect to retry.`;
  }
  return isPersonalTarget
    ? `Installed "${entryName}" in your personal workspace.`
    : `Installed "${entryName}" in this workspace.`;
}

/**
 * Mpak (stdio) install. The bundle is fetched from whichever mpak
 * registry the SDK is pointed at, spawned as a subprocess, and
 * registered in the workspace registry via the shared
 * `installBundleInWorkspace` primitive.
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
  // Honors the persisted `serverName` (canonical reverse-DNS form,
  // set at install time) so legacy short-slug installs and new
  // canonical-form installs both resolve correctly.
  const already = ws.bundles.find((b) => "name" in b && b.name === bundleName);
  if (already) {
    const existingServerName =
      ("name" in already && already.serverName) || deriveServerName(bundleName);
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

  // Install does NOT force-refresh the shared mpak cache. App *version* is an
  // org-global concern: the cache is keyed by name only (no version) and shared
  // across every workspace, so a force-pull here would let a workspace admin
  // silently bump every workspace's version on its next respawn — bypassing the
  // org_admin `manage_apps.upgrade` gate. Instead, a ws_admin install adopts
  // whatever version the org already has cached; a first-ever install cold-
  // downloads the current release via `prepareServer`. The original "stuck on a
  // bad version" incident stays cured WITHOUT a force-pull here: a gate-failing
  // cached manifest self-heals on spawn (`startBundleSource` force-repulls on a
  // HostManifestGateError, on the install path too).

  // Persist the slugified canonical reverse-DNS form as the BundleRef's
  // serverName so this install — and every lookup that follows — uses
  // the same opaque, URL-safe, collision-free identifier the catalog
  // source emits. Matches the remote-OAuth path's slugify call.
  const ref: BundleRef = { name: bundleName, serverName: slugifyServerName(entry.id) };
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
        bundleMcp: ctx.runtime.getBundleMcpDeps(wsId),
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
  void scopeHint; // Stage 2: scopeHint is workspace-only and informational
  const lifecycle = ctx.runtime.getLifecycle();

  // Stage 2: every connector is workspace-scoped. Personal connectors
  // live in the caller's personal workspace; the caller is expected to
  // disconnect them from that workspace context (the UI selects it).
  if (!wsId) return errResult("Workspace context required.");
  if (!identity) return errResult("Authentication required.");
  if (!lifecycle.getInstance(serverName, wsId)) {
    return errResult(`Bundle "${serverName}" not installed in workspace.`);
  }
  // Workspace-scope disconnect revokes OAuth tokens used by every
  // member of the workspace. A non-admin shouldn't be able to log
  // the whole workspace out of a shared connector. Personal
  // workspaces have a single admin (the owner) by invariant, so
  // the same gate cleanly covers both shapes.
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

/**
 * Uninstall a connector — full removal. For OAuth-protected URL bundles
 * we revoke tokens upstream first (so the user's grant in the vendor
 * portal is cleaned up), then `lifecycle.uninstall` stops the source,
 * removes the entry from `workspace.json`, clears credentials, and
 * unregisters placements. For local bundles (stdio / non-OAuth URL),
 * just `lifecycle.uninstall`.
 *
 * Stage 2: workspace-scope only. Personal connectors live in the user's
 * personal workspace; uninstall from that workspace context.
 */
async function handleUninstall(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  void scopeHint; // Stage 2: scopeHint is workspace-only and informational
  const lifecycle = ctx.runtime.getLifecycle();

  // Stage 2: every connector is workspace-scoped. Personal connectors
  // live in the caller's personal workspace; uninstall from that
  // workspace context (the UI selects it).
  if (!wsId) return errResult("Workspace context required.");
  if (!identity) return errResult("Authentication required.");
  if (!lifecycle.getInstance(serverName, wsId)) {
    return errResult(`Bundle "${serverName}" not installed in workspace.`);
  }
  // Workspace-scope uninstall removes a connector for every member
  // of the workspace and clears the credential file. A non-admin
  // shouldn't be able to remove a shared bundle other members rely on.
  // Personal workspaces have a single admin (the owner) by invariant.
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

  // Revoke OAuth tokens upstream first when applicable.
  const revokeResult = isUrlBundle
    ? await revokeUrlBundleTokens(lifecycle, ctx, serverName, wsId)
    : {};

  try {
    const registry = ctx.runtime.getRegistryForWorkspace(wsId);
    // Capture the manifest name BEFORE lifecycle.uninstall — the instance
    // reference is still valid afterwards but the lifecycle map drops it, and we
    // need the name to strip the matching workspace.json entry.
    const installedBundleName = instance?.bundleName;
    await lifecycle.uninstall(serverName, registry, wsId);
    await stripUninstalledBundleEntry(ctx, wsId, serverName, installedBundleName);
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

/**
 * Revoke a URL bundle's OAuth tokens upstream before local cleanup. Best-effort:
 * a 4xx from the provider shouldn't block uninstall, since the user's intent is
 * "I want this gone."
 */
async function revokeUrlBundleTokens(
  lifecycle: ReturnType<Runtime["getLifecycle"]>,
  ctx: ManageConnectorsContext,
  serverName: string,
  wsId: string,
): Promise<{ revoked?: { access?: boolean; refresh?: boolean }; revokeError?: string }> {
  try {
    const r = await lifecycle.disconnect(serverName, wsId, "_workspace", {
      workDir: ctx.runtime.getWorkDir(),
      allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
    });
    return {
      revoked: r.revoked,
      ...(r.revokeError ? { revokeError: r.revokeError } : {}),
    };
  } catch (err) {
    return { revokeError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Strip the just-uninstalled bundle from `workspace.json#bundles[]`.
 * `lifecycle.uninstall` clears its own `instances` map and the legacy global
 * `nimblebrain.json`, but not the workspace record — this removes both URL
 * bundles and named entries.
 */
async function stripUninstalledBundleEntry(
  ctx: ManageConnectorsContext,
  wsId: string,
  serverName: string,
  installedBundleName: string | undefined,
): Promise<void> {
  const wsAfter = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!wsAfter) return;
  const filtered = wsAfter.bundles.filter((b) => {
    if ("url" in b) {
      const sn = b.serverName ?? deriveServerName(b.url);
      return sn !== serverName;
    }
    if ("name" in b) {
      return b.name !== installedBundleName && b.name !== serverName;
    }
    return true;
  });
  if (filtered.length !== wsAfter.bundles.length) {
    await ctx.runtime.getWorkspaceStore().update(wsId, { bundles: filtered });
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
  void scopeHint; // Stage 2: scopeHint is workspace-only and informational
  void callerId; // unused post-Stage-2; kept for caller signature stability
  const lifecycle = ctx.runtime.getLifecycle();

  // Stage 2: every connector is workspace-scoped. The caller must
  // disambiguate the workspace (the UI selects it via the sidebar
  // navigator — see Q1 in STAGE_2_DESIGN_DECISIONS.md).
  if (!wsId) return errResult("Workspace context required.");
  if (!lifecycle.getInstance(serverName, wsId)) {
    return errResult(`Bundle "${serverName}" not installed in workspace.`);
  }

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
  void scopeHint; // Stage 2: scopeHint is workspace-only and informational

  const lifecycle = ctx.runtime.getLifecycle();
  if (!wsId) return errResult("Workspace context required.");
  if (!lifecycle.getInstance(serverName, wsId)) {
    return errResult(`Bundle "${serverName}" not installed in workspace.`);
  }

  const owner = resolvePermissionOwner(wsId, callerId, undefined);
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
 * Resolve a workspace owner pair for permission read/write. Stage 2:
 * permissions are workspace-scoped only (the legacy user-scope path is
 * gone). Returns null when no workspace context is available.
 */
function resolvePermissionOwner(
  wsId: string | null,
  callerId: string | null,
  scopeHint: string | undefined,
): { scope: "workspace"; wsId: string } | null {
  void scopeHint; // Stage 2: only workspace scope is legal
  void callerId; // unused post-Stage-2
  return wsId ? { scope: "workspace", wsId } : null;
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
  const installedHere = lifecycle.getInstance(serverName, owner.wsId) != null;
  if (!installedHere) {
    return errResult(`Connector "${serverName}" is not installed in workspace "${owner.wsId}".`);
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

// ── personal-connector grants ─────────────────────────────────────
//
// A personal connector lives in the caller's own personal workspace
// (`ws_user_<callerId>`). A grant lets the caller USE it inside a shared
// workspace they belong to — the one sanctioned crossing (fail closed at
// dispatch). The grant is the caller's own (`grantedBy = callerId`) and is
// per-granter: it only widens the granter's OWN reach, never another member's,
// so no admin gate is needed — any member may grant their own connector.

/**
 * A grantable personal connector is a **remote MCP connection** (a `remote-oauth`
 * install → `installSource: "remote"`, see `deriveInstallSource`). The admission
 * gate in `handleInstall` already keeps a personal workspace connectors-only for
 * installs made *after* it. This predicate is the **defense-in-depth backstop**
 * for personal workspaces that predate the gate (a Synapse app / mpak bundle a
 * user installed into their home workspace before this arc): such a bundle is
 * never listed or granted as a connector. The gate is the primary boundary; this
 * ensures legacy data can't leak through the read/grant paths.
 */
function isRemotePersonalConnector(instance: BundleInstance): boolean {
  return instance.installSource === "remote";
}

/**
 * `list_personal_connectors` — the caller's personal connectors and, for each,
 * the shared workspaces it's granted to. The read behind the Profile → Connectors
 * page.
 */
async function handleListPersonalConnectors(
  ctx: ManageConnectorsContext,
  callerId: string | null,
): Promise<ToolResult> {
  if (!callerId) return errResult("Authentication required.");
  const personalWsId = personalWorkspaceIdFor(callerId);
  const store = ctx.runtime.getPermissionStore();
  const lifecycle = ctx.runtime.getLifecycle();

  // The caller's whole grant map, read once (not per connector).
  const grantsByConnector = await store.listConnectorGrants(callerId);

  const connectors = [];
  for (const instance of lifecycle.getInstances()) {
    if (instance.wsId !== personalWsId) continue;
    if (!isRemotePersonalConnector(instance)) continue; // backstop for pre-gate bundles
    connectors.push({
      serverName: instance.serverName,
      displayName: instance.bundleName,
      description: instance.description ?? null,
      state: instance.state,
      grantedWorkspaces: grantsByConnector[instance.serverName] ?? [],
    });
  }
  return {
    content: textContent(`${connectors.length} personal connector(s).`),
    structuredContent: { connectors },
    isError: false,
  };
}

/**
 * `grant_connector` — grant the caller's personal connector `serverName` for use
 * inside the shared workspace `targetWsId`. Validates the connector is one the
 * caller actually installed personally, and the target is a shared workspace the
 * caller belongs to (never their own home — home is free).
 */
async function handleGrantConnector(
  ctx: ManageConnectorsContext,
  callerId: string | null,
  serverName: string,
  targetWsId: string | null,
): Promise<ToolResult> {
  if (!callerId) return errResult("Authentication required.");
  if (!serverName) return errResult("serverName is required.");
  if (!targetWsId) return errResult("wsId (the workspace to grant access to) is required.");

  const personalWsId = personalWorkspaceIdFor(callerId);
  if (targetWsId === personalWsId) {
    return errResult(
      "A personal connector is always available in your own personal workspace — no grant needed.",
    );
  }
  const instance = ctx.runtime.getLifecycle().getInstance(serverName, personalWsId);
  if (!instance || !isRemotePersonalConnector(instance)) {
    return errResult(
      `"${serverName}" is not one of your personal connectors — connect it in your profile first.`,
    );
  }
  const memberships = await ctx.runtime.getWorkspaceStore().getWorkspacesForUser(callerId);
  const target = memberships.find((w) => w.id === targetWsId);
  if (!target) {
    return errResult(`You are not a member of workspace "${targetWsId}".`);
  }

  await ctx.runtime.getPermissionStore().grantConnector(callerId, serverName, targetWsId);
  return {
    content: textContent(`Granted "${serverName}" to ${target.name}.`),
    structuredContent: { ok: true, serverName, wsId: targetWsId },
    isError: false,
  };
}

/**
 * `revoke_connector` — revoke the caller's grant of `serverName` to `targetWsId`.
 * Idempotent and lenient: revoking a grant that doesn't exist is a safe no-op.
 */
async function handleRevokeConnector(
  ctx: ManageConnectorsContext,
  callerId: string | null,
  serverName: string,
  targetWsId: string | null,
): Promise<ToolResult> {
  if (!callerId) return errResult("Authentication required.");
  if (!serverName) return errResult("serverName is required.");
  if (!targetWsId) return errResult("wsId (the workspace to revoke access from) is required.");

  await ctx.runtime.getPermissionStore().revokeConnector(callerId, serverName, targetWsId);
  return {
    content: textContent(`Revoked "${serverName}" from workspace.`),
    structuredContent: { ok: true, serverName, wsId: targetWsId },
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

  const entry = await ctx.runtime.getConnectorDirectory().catalogById(catalogId);
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
  const apps: NonNullable<Workspace["oauthOperatorApps"]> = { ...(ws.oauthOperatorApps ?? {}) };
  apps[catalogId] = {
    clientId: clientId.trim(),
    configuredAt: new Date().toISOString(),
    configuredBy: identity.id,
  };
  await persistOperatorApp(ctx, wsId, apps, credStore, clientSecretKey, hadPriorSecret);

  return {
    content: textContent(`Configured OAuth app for "${entry.name}".`),
    structuredContent: { ok: true, catalogId, clientId: apps[catalogId]?.clientId },
    isError: false,
  };
}

/**
 * Write the operator OAuth app record to workspace.json. On failure, roll back
 * the just-written client_secret so the two stores stay in lockstep — but only
 * when there was no prior secret for this key (clobbering a working credential
 * on a workspace.json hiccup is worse than leaving a stale-but-valid one).
 * Best-effort rollback: if it fails, the original write error still wins.
 */
async function persistOperatorApp(
  ctx: ManageConnectorsContext,
  wsId: string,
  apps: NonNullable<Workspace["oauthOperatorApps"]>,
  credStore: FileCredentialStore,
  clientSecretKey: string,
  hadPriorSecret: boolean,
): Promise<void> {
  try {
    await ctx.runtime.getWorkspaceStore().update(wsId, { oauthOperatorApps: apps });
  } catch (err) {
    if (!hadPriorSecret) {
      try {
        await credStore.delete(wsId, clientSecretKey);
      } catch {
        // best-effort
      }
    }
    throw err;
  }
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

  const entry = await ctx.runtime.getConnectorDirectory().catalogById(catalogId);
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
  runtime: Runtime,
  wsId: string,
  bundleName: string,
  schema: Record<string, UserConfigFieldDef>,
): Promise<Record<string, boolean>> {
  const stored = (await runtime.getWorkspaceContext(wsId).getCredentials(bundleName)) ?? {};
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

  const credentialStore = ctx.runtime.getWorkspaceContext(wsId).getCredentialStore();
  for (const { key, value } of writes) {
    if (value.length === 0) {
      // Empty string = clear that single field. Use the dedicated
      // primitive so the key is removed from the credential file
      // (rather than persisted as `{ "key": "" }` which would still
      // resolve as "configured" in shape probes that check
      // key-presence).
      await credentialStore.clear(bundleName, key);
    } else {
      await credentialStore.save(bundleName, key, value);
    }
  }

  // Mode 1 (env_inject) bundles only read user_config at spawn — env
  // vars are baked in at fork time. Saving to the credential file is
  // necessary but not sufficient; without a respawn the running
  // subprocess keeps using whatever it was launched with. Respawn so the
  // post-write state reflects the new credentials.
  const respawn = await respawnBundleAfterCredentialChange(ctx, wsId, bundleName, serverName);

  const populated = await probeUserConfigPopulated(ctx.runtime, wsId, bundleName, schema);
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

  await ctx.runtime.getWorkspaceContext(wsId).getCredentialStore().clearAll(bundleName);

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
    // workspace credential store. configDir is undefined — the
    // named-bundle path doesn't need it.
    await startBundleSource({ name: bundleName }, registry, ctx.runtime.getEventSink(), undefined, {
      wsId,
      workDir: ctx.runtime.getWorkDir(),
      allowInsecureRemotes: ctx.runtime.getAllowInsecureRemotes(),
      bundleMcp: ctx.runtime.getBundleMcpDeps(wsId),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Workspace-scoped write gate for connector mutations.
 *
 * Delegates to the single source of truth, `canWriteWorkspaceScoped`:
 * the identity must be a workspace member with the `admin` role. There
 * is no org-admin bypass — an org admin / owner who is not a workspace
 * admin member cannot install connectors. The helper fails closed on a
 * malformed workspace record (non-array `members`).
 */
function isWorkspaceAdmin(ws: Workspace, identity: UserIdentity): boolean {
  return canWriteWorkspaceScoped(identity, ws).allowed;
}

function errResult(msg: string): ToolResult {
  return { content: textContent(msg), isError: true };
}
