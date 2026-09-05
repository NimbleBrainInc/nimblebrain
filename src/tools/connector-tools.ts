import { mcpAuthCallbackUrl } from "../api/routes/mcp-auth.ts";
import { brokeredRef } from "../bundles/brokered.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../bundles/connection.ts";
import { sanitizePlacements } from "../bundles/defaults.ts";
import {
  deriveServerName,
  isReservedServerName,
  serverNameFromRef,
  slugifyServerName,
} from "../bundles/paths.ts";
import { startBundleSource } from "../bundles/startup.ts";
import type {
  BrokeredRef,
  BundleInstance,
  BundleRef,
  RemoteTransportConfig,
} from "../bundles/types.ts";
import { brokeredCatalogConfig, isBrokeredAuthKind } from "../connectors/auth-kind.ts";
import type {
  ManagedConnectorProvider,
  ManagedSession,
} from "../connectors/providers/managed-provider.ts";
import { connectorSkillIdentityFrom, type SecretHeaderRef } from "../connectors/server-detail.ts";
import { textContent } from "../engine/content-helpers.ts";
import { INTERNAL_TOOL_ANNOTATION, type ToolResult } from "../engine/types.ts";
import { HookContractError, revokeHooksForConnector } from "../hooks/provisioning.ts";
import { ensureHooks, stopWatchingHooks } from "../hooks/reconcile.ts";
import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { IdentityConnectorStore } from "../identity/connector-store.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { clearCursor } from "../notifications/cursors.ts";
import { log } from "../observability/log.ts";
import type { PermissionOwner } from "../permissions/permission-store.ts";
import type {
  ConnectorCatalogEntry,
  DirectoryEntry,
  RemoteOAuthInstall,
} from "../registries/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { validateAdditionalAuthorizationParams } from "../util/oauth-params.ts";
import { isHttpUrl } from "../util/url.ts";
import { canWriteWorkspaceScoped } from "../workspace/authz.ts";
import type { Workspace } from "../workspace/types.ts";
import { type CredentialRef, isCredentialRef } from "./credential-ref.ts";
import type { CredentialStore } from "./credential-store.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { hasMcpOAuthTokens } from "./mcp-oauth-records.ts";
import { McpSource } from "./mcp-source.ts";
import type { Tool, ToolSource } from "./types.ts";

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

/**
 * The managed-connector provider that owns `auth`, or undefined when `auth` is
 * runtime-native or no provider is registered for it.
 *
 * ONE lookup for every brokered vendor. All brokered dispatch — userId
 * derivation, session create, API-key connect, teardown, boot-state — routes
 * through the provider this returns, so the tool layer imports no vendor module
 * and gains no arm when a provider is added.
 */
function providerFor(
  ctx: ManageConnectorsContext,
  auth: string,
): ManagedConnectorProvider | undefined {
  if (!isBrokeredAuthKind(auth)) return undefined;
  return ctx.runtime.getManagedConnectorRegistry().get(auth);
}

/**
 * Whether a connector with this auth kind can install on the identity plane.
 *
 * The rule is a capability, not a vendor list: DCR, or a brokered connector
 * whose provider brokers an interactive connect (`initiate`) and can therefore
 * complete auth for one user. `static` reads a workspace-scoped operator secret
 * and `provider` mints a platform credential; both are workspace/platform-bound,
 * and their identity variants are a separate slice.
 *
 * The install gate and the picker's filter both call this, so they cannot drift.
 */
function identityInstallableAuth(ctx: ManageConnectorsContext, auth: string): boolean {
  return auth === "dcr" || providerFor(ctx, auth)?.initiate !== undefined;
}

/**
 * The operator-facing message for a brokered connector whose provider this
 * deployment has not configured. Names the config path generically because it
 * IS generic: every provider's block is `connectors.providers.<id>`.
 */
function brokerNotConfiguredMessage(entryName: string, auth: string): string {
  // Every provider resolves its settings from `connectors.providers.<id>` and
  // its credential from `<ID>_API_KEY` as the one env fallback (see
  // `providers/registry.ts`), so naming both is generic, not a per-vendor case.
  const envVar = `${auth.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return (
    `"${entryName}" is brokered by "${auth}", which is not configured on this platform. ` +
    `Declare connectors.providers.${auth} in nimblebrain.json (or set ${envVar} in the ` +
    "platform env) and restart the API."
  );
}

/** Inputs to {@link deriveConnectorStatus}. Subset of InstalledEntry's
 *  shape so the helper has a small, testable surface. */
export interface StatusInputs {
  /** BundleState as exposed by the lifecycle. */
  state: string;
  /** True when a static-auth catalog entry has no operator OAuth client configured. */
  missingOperatorSetup?: boolean;
  /** Last connection error from the principal Connection (crashed / dead / reauth_required). */
  lastError?: string;
}

/**
 * Collapse a connector's underlying flags into a generic, type-agnostic
 * status for the UI. Six values:
 *
 *   ready          — works
 *   needs_setup    — admin must configure the operator OAuth client before
 *                     this is usable
 *   needs_auth     — workspace member must (re)authenticate (Connect / Reconnect)
 *   connecting     — OAuth flow in flight
 *   failed         — connection dead with no actionable next step
 *   starting       — connection being established
 *
 * Priority — setup blocks auth blocks usage. A static-auth connector whose
 * OAuth never succeeded because the operator clientSecret is missing surfaces
 * as `needs_setup` (the actionable cause), never as `failed`.
 *
 * The connector-type detail — *which* credentials missing, *what* button
 * label — is left to the UI, derived from the other InstalledConnector
 * fields. This helper's job is the discriminator + a human-readable
 * reason string for tooltips / banners.
 */
export function deriveConnectorStatus(input: StatusInputs): {
  status: "ready" | "needs_setup" | "needs_auth" | "connecting" | "failed" | "starting";
  statusReason?: string;
} {
  // 1. Setup gates everything. Operator OAuth missing → admin acts first.
  if (input.missingOperatorSetup) {
    return { status: "needs_setup", statusReason: "OAuth app not configured for this workspace." };
  }
  // 2. Auth lifecycle. Reconnect outranks first-time connect (a token
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
  // 3. Transient flows.
  if (input.state === "pending_auth") {
    return { status: "connecting" };
  }
  if (input.state === "starting") {
    return { status: "starting" };
  }
  // 4. Failures. Reported with the reason; the web client decides the
  //    affordance (`resolveAction` in ConnectorStatusHero.tsx — Reconnect,
  //    usually). `dead` covers a connector whose boot-start failed, which the
  //    doors revive on next use.
  if (input.state === "crashed" || input.state === "dead" || input.state === "stopped") {
    return {
      status: "failed",
      ...(input.lastError ? { statusReason: input.lastError } : {}),
    };
  }
  // 5. Default — running, no missing config, no failed connection.
  return { status: "ready" };
}

export function createManageConnectorsTool(ctx: ManageConnectorsContext): InProcessTool {
  return {
    name: "manage_connectors",
    description:
      "List, install, and disconnect remote MCP connectors. Workspace connectors are shared by all members; user connectors are personal and follow you across workspaces.",
    meta: { [INTERNAL_TOOL_ANNOTATION]: true },
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
            "get_redirect_uri",
            "list_bound_skills",
            "list_personal_connectors",
            "list_personal_catalog",
            "grant_connector",
            "revoke_connector",
            "set_secret",
            "delete_secret",
            "list_secret_keys",
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
            "Target workspace. For `install`: defaults to the request's workspace (X-Workspace-Id), so the web shell installs into the workspace it's viewing without passing this; supply it only to install elsewhere. For `grant_connector` / `revoke_connector`: the workspace to grant/revoke the caller's personal connector to (any workspace the caller belongs to, including their own personal one) — REQUIRED and explicit (no header fallback).",
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
          enum: ["workspace", "identity"],
          description:
            "For `install`: `scope: \"identity\"` installs the entry as a PERSONAL connector on the caller's own identity (no workspace) instead of into a workspace — the Profile → Connectors action. Otherwise a workspace-vs-user scope hint for `list_installed` / `list_tools` / `uninstall` / `disconnect`. The permission actions (`get_permissions` / `set_permissions` / `list_tools_with_permissions`) IGNORE this and auto-resolve scope from where the connector is installed — a personal connector (on the caller's identity) is user-scoped, anything else is workspace-scoped — so passing `scope` cannot pin their target.",
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
            "For connect_api_key: map of the connector's declared Composio field key → value (e.g. api_key, subdomain); handed to Composio and never persisted by the platform.",
          additionalProperties: { type: "string" },
        },
        key: {
          type: "string",
          description:
            'Credential-store key (required for set_secret and delete_secret). Dotted-namespace form, e.g. `acme.db_url`. This is the name a connector\'s config references with `{ ref: "credential", key }`.',
        },
        value: {
          type: "string",
          description:
            "The secret (set_secret only). Stored in the workspace credential store and never returned by any action — `list_secret_keys` reports keys and timestamps only. Setting an existing key replaces it, which is how a key is rotated.",
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
          return handleListToolsWithPermissions(ctx, args.wsId, args.callerId, args.serverName);
        case "install":
          return handleInstall(ctx, args.identity, args.entry, args.installWsId, args.scope);
        case "connect_api_key":
          return handleConnectApiKey(ctx, args.wsId, args.identity, args.catalogId, args.fields);
        case "disconnect":
          // A personal connector's only teardown is full removal (there's no
          // "de-auth but keep installed" half-state on the identity plane), so
          // both disconnect and uninstall with scope:identity route here.
          if (args.scope === "identity")
            return handleDisconnectIdentity(ctx, args.identity, args.serverName);
          return handleDisconnect(ctx, args.wsId, args.identity, args.serverName, args.scope);
        case "uninstall":
          if (args.scope === "identity")
            return handleDisconnectIdentity(ctx, args.identity, args.serverName);
          return handleUninstall(ctx, args.wsId, args.identity, args.serverName, args.scope);
        case "get_permissions":
          return handleGetPermissions(ctx, args.wsId, args.callerId, args.serverName);
        case "set_permissions":
          return handleSetPermissions(ctx, args.wsId, args.callerId, args.serverName, args.tools);
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
        case "get_redirect_uri":
          return handleGetRedirectUri(args.identity);
        case "list_bound_skills":
          return handleListBoundSkills(ctx, args.wsId);
        case "list_personal_connectors":
          return handleListPersonalConnectors(ctx, args.callerId);
        case "list_personal_catalog":
          return handleListPersonalCatalog(ctx, args.callerId);
        case "grant_connector":
          return handleGrantConnector(ctx, args.callerId, args.serverName, args.grantTargetWsId);
        case "revoke_connector":
          return handleRevokeConnector(ctx, args.callerId, args.serverName, args.grantTargetWsId);
        case "set_secret":
          return handleSetSecret(ctx, args.wsId, args.identity, args.key, args.value);
        case "delete_secret":
          return handleDeleteSecret(ctx, args.wsId, args.identity, args.key);
        case "list_secret_keys":
          return handleListSecretKeys(ctx, args.wsId, args.identity);
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
  /** Credential-store key for the secret actions. */
  key: string;
  /**
   * Secret value for `set_secret`. NOT trimmed here: leading/trailing
   * whitespace can be part of a secret, and the one thing a store must not do is
   * quietly hand back something other than what was set. `set_secret` rejects a
   * value that is *only* whitespace instead.
   */
  value: string;
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
    key: str(input.key).trim(),
    value: str(input.value),
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
 * page — Browse needs the unified shape so registry entries and curated
 * remote services render side-by-side.
 *
 * Per-registry failures are isolated and surfaced in `errors` so the
 * UI can show partial results with a "missing X" hint. Workspace
 * `connectorsAllowList` filters apply only to curated entries today
 * (upstream registries have not shipped a scoping primitive yet).
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
  const credStore = wsId ? ctx.runtime.getCredentialStore() : null;
  const isOperatorConfigured =
    wsId && ws && credStore
      ? async (catalogId: string, clientSecretKey: string): Promise<boolean> => {
          if (!ws.oauthOperatorApps?.[catalogId]?.clientId) return false;
          const secret = await credStore.get({ kind: "workspace", wsId }, clientSecretKey, {
            caller: "connector-tools:list_directory",
            purpose: "report whether operator OAuth setup is complete",
          });
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
  state: string;
  // Stage 2: only workspace-scope connectors exist. Personal connectors
  // live in the caller's personal workspace; the legacy `"user"` arm was
  // removed in T008/T009 — every population site below emits `"workspace"`.
  scope: "workspace";
  interactive: boolean;
  toolCount: number;
  /**
   * Brand icon URL, from the catalog entry this connector matched. Falls
   * through to the deterministic letter avatar when unset (the connector
   * isn't in any enabled registry, or the fetch failed).
   */
  iconUrl?: string;
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
   * Generic, type-agnostic status the UI renders without re-deriving
   * from the underlying BundleState + credential probes. Six values
   * collapse what would otherwise be ~10 specific failure modes —
   * the connector-type detail (which credentials missing, which
   * action label) is derived in the UI from the other fields.
   *
   * Priority when multiple flags apply: setup blocks auth blocks
   * usage. needs_setup > needs_auth > failed > connecting/starting >
   * ready.
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
  credStore: CredentialStore;
  catalogByUrl: Map<string, ConnectorCatalogEntry>;
  catalogById: Map<string, ConnectorCatalogEntry>;
  resolveUserLabel: (userId: string) => Promise<string | undefined>;
  /** When set, `buildInstalledEntry` skips every instance except this one
   *  before any per-instance IO. */
  onlyServerName?: string;
}

/**
 * Match a bundle instance's ref to its catalog entry. Prefers a URL match;
 * EVERY brokered bundle stores a per-install session URL that misses
 * `catalogByUrl`, so they fall back to the catalog id their provider stamped on
 * the ref at install — recovered by `brokeredRef`, which owns the
 * provider list.
 *
 * The fallback must cover each brokered kind: without it the connector reads as
 * uncatalogued — slug instead of display name, letter avatar instead of icon,
 * and every catalog-gated section of the Configure page dark.
 */
function resolveInstanceCatalog(
  instance: BundleInstance,
  catalogByUrl: Map<string, ConnectorCatalogEntry>,
  catalogById: Map<string, ConnectorCatalogEntry>,
): { url: string | undefined; cat: ConnectorCatalogEntry | undefined } {
  const ref = instance.ref;
  const url = ref?.url;
  const connectorId = ref ? brokeredRef(ref)?.connectorId : undefined;
  let cat = url ? catalogByUrl.get(url) : undefined;
  if (!cat && connectorId) {
    cat = catalogById.get(connectorId);
  }
  return { url, cat };
}

/**
 * How long a remote connector's memoized `tools/list` is trusted before the
 * connector read surfaces (Configure page, installed list) force a re-fetch.
 * A remote server redeployed at the same URL changes its advertised tools with
 * no lifecycle signal to an already-connected source — no `stop`, no restart,
 * no native `tools/list_changed` — so without this the surface the UI shows
 * (and the agent's callable set) stays pinned to the first-connect snapshot.
 * Short enough that a redeploy surfaces within a page reload or two; long
 * enough that a burst of reads coalesces onto one round-trip.
 */
const REMOTE_TOOL_LIST_MAX_AGE_MS = 30_000;

/**
 * Tools for a connector's read surface, kept fresh for remote sources. Local /
 * stdio sources change their tool set only via respawn (which already drops
 * the memo), so they read the memo directly; only remote sources need the
 * age-gated re-fetch. A refresh that finds a changed surface fans out through
 * the source's `toolsChanged` seam, so the agent's tool union and the LLM tool
 * list converge with what the UI now shows (never one without the other).
 */
async function readConnectorTools(source: ToolSource): Promise<Tool[]> {
  if (source instanceof McpSource && source.isRemote()) {
    return source.toolsWithMaxAge(REMOTE_TOOL_LIST_MAX_AGE_MS);
  }
  return source.tools();
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
      toolCount = (await readConnectorTools(src)).length;
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
  credStore: CredentialStore,
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
    // A presence probe, not a use: `get` without a `reveal` writes no audit line.
    const wrapped = await credStore.get({ kind: "workspace", wsId }, oauthClient.clientSecret.key, {
      caller: "connector-tools:list_installed",
      purpose: "report whether operator OAuth setup is complete",
    });
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
 * Enrich an entry with its live OAuth connection state + operator OAuth audit
 * config. Skipped when the instance carries no ref (an instance seeded before
 * its ref was persisted), which leaves the entry with the state the lifecycle
 * already reported.
 */
async function applyConnectionProbes(
  entry: InstalledEntry,
  deps: InstalledEntryDeps,
  instance: BundleInstance,
  url: string | undefined,
  cat: ConnectorCatalogEntry | undefined,
): Promise<void> {
  if (!url || !instance.ref) return;
  await applyRemoteConnectionState(
    entry,
    instance,
    instance.ref,
    url,
    cat,
    deps.credStore,
    deps.wsId,
  );
  await applyOperatorOAuth(entry, cat, deps.ws, deps.resolveUserLabel);
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

  const { url, cat } = resolveInstanceCatalog(instance, deps.catalogByUrl, deps.catalogById);
  const { toolCount, handshakeVersion } = await probeToolCountAndVersion(
    deps.registry,
    instance.serverName,
  );
  // Derive from SANITIZED placements (consistent with the catalog projection),
  // so a sole spoofed placement doesn't light the chip while rendering nothing.
  const interactive =
    cat?.interactive === true || sanitizePlacements(instance.ui?.placements).length > 0;
  // Brand icon comes from the catalog match; undefined is fine — the UI falls
  // back to a deterministic letter avatar.
  const iconUrl = cat?.iconUrl;

  const entry: InstalledEntry = {
    serverName: instance.serverName,
    bundleName: instance.bundleName,
    version: instance.version,
    ...(handshakeVersion ? { handshakeVersion } : {}),
    state: instance.state,
    // Provisional — overwritten by deriveConnectorStatus below once every probe
    // (operatorOAuth, lastError) has been resolved on the entry. Initial value
    // satisfies the public InstalledConnector contract that `status` is
    // required.
    status: "ready",
    scope: "workspace",
    interactive,
    toolCount,
    ...(iconUrl ? { iconUrl } : {}),
  };

  await applyConnectionProbes(entry, deps, instance, url, cat);

  // Derive the generic UI status last so it sees every populated probe
  // (operatorOAuth gate, lastError).
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
  const credStore = ctx.runtime.getCredentialStore();
  // One directory instance per request — its memoized `servers()`
  // means catalogByUrl + catalogByIdMap share a single fetch even
  // though they're called separately. Reaching for the lookup tables
  // (rather than the raw catalog list + manual map-build) keeps the
  // construction concern inside the facade.
  const directory = ctx.runtime.getConnectorDirectory();
  const catalogByUrl = await directory.catalogByUrl();
  // O(1) catalog lookups for brokered bundles whose persisted `ref.url` is a
  // per-install session URL and therefore misses `catalogByUrl`. Built once per
  // request.
  const catalogById = await directory.catalogByIdMap();
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
  // Workspace-scope entries: walk every connector visible in the workspace
  // registry.
  //
  // Read directly from the lifecycle's instance map, NOT the shorthand
  // `getBundleInstancesForWorkspace` — see the rationale on that method for why
  // its registry filter is load-bearing and why this page must bypass it.
  //
  // The short version: a connector can be installed and unregistered (torn down
  // by Disconnect, or a boot-start that failed), and this page is where the user
  // clicks Connect / Reconnect to get it back. Filtering it out would hide the
  // only affordance that recovers it.
  if ((scope === "all" || scope === "workspace") && wsId) {
    const deps: InstalledEntryDeps = {
      ctx,
      wsId,
      ws: await ctx.runtime.getWorkspaceStore().get(wsId),
      registry: ctx.runtime.getRegistryForWorkspace(wsId),
      credStore,
      catalogByUrl,
      catalogById,
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
 * the value-shape gate (`isHttpUrl` for remote URLs,
 * reserved-OAuth-params for the install action). The entry came from a client over the tool surface, not
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
  scope: string | undefined,
): Promise<ToolResult> {
  const entry = parseDirectoryEntry(rawEntry);
  if (!entry) return errResult("entry with install action is required.");
  if (!identity) return errResult("Authentication required.");

  // Identity-target install: `scope: "identity"` installs a PERSONAL connector on
  // the caller's own identity (the Profile → Connectors action) — no workspace,
  // credentials bound to the user. Branch before the workspace requirement below.
  if (scope === "identity") {
    return handleInstallIdentity(ctx, identity, entry);
  }

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

  const admission = workspaceInstallAdmission(ws, identity, entry);
  if (admission) return admission;

  switch (entry.install.kind) {
    case "remote-oauth": {
      const collision = await personalConnectorCollisionGuard(ctx, identity.id, ws, entry);
      if (collision) return collision;
      return handleInstallRemoteOAuth(ctx, wsId, ws, entry);
    }
    case "direct-url":
      return errResult("direct-url install is not yet supported.");
  }
}

/**
 * Gate a workspace-target install: admin role, the workspace connector allow-list,
 * and the personal-workspace connector-only rule. Returns an error result to
 * short-circuit on, or `null` to proceed.
 *
 * Admin role gates every install — workspace-shared connectors widen the
 * workspace's tool / credential surface for every member, and personal
 * workspaces invariably have the owner as admin, so this covers the personal
 * path uniformly. A personal workspace is a CONNECTOR space (the user's own
 * remote MCP connections, grantable into shared rooms): only `remote-oauth` is
 * admitted, keeping "a bundle in your personal workspace" == "a grantable
 * personal connector" true by construction.
 */
function workspaceInstallAdmission(
  ws: Workspace,
  identity: UserIdentity,
  entry: DirectoryEntry,
): ToolResult | null {
  if (!isWorkspaceAdmin(ws, identity)) {
    return {
      content: textContent("Workspace admin role required to install connectors."),
      structuredContent: { error: "permission_denied" },
      isError: true,
    };
  }
  const allowList = ws.connectorsAllowList;
  if (
    allowList &&
    Array.isArray(allowList) &&
    allowList.length > 0 &&
    !allowList.includes(entry.id)
  ) {
    return errResult(`Connector "${entry.id}" not visible in this workspace.`);
  }
  if (ws.isPersonal === true && entry.install.kind !== "remote-oauth") {
    return errResult(
      `Your personal workspace is for connectors — remote MCP connections. ` +
        `"${entry.id}" installs as a "${entry.install.kind}" bundle; install it into a shared workspace instead.`,
    );
  }
  return null;
}

/**
 * Forbid the collision (workspace side): a serverName can't be both a personal
 * connector and a SHARED-workspace install, or `resolvePermissionOwner` (which
 * resolves a personal connector first) could never address the workspace copy's
 * policy. Returns an error result when the caller already has a personal
 * connector of the same name, else `null`. The caller's own personal workspace
 * is the legacy personal home, not a shared collision — skip it.
 */
async function personalConnectorCollisionGuard(
  ctx: ManageConnectorsContext,
  callerId: string,
  ws: Workspace,
  entry: DirectoryEntry,
): Promise<ToolResult | null> {
  if (ws.isPersonal === true) return null;
  const serverName = slugifyServerName(entry.id);
  const personal = await new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() }).get(
    callerId,
    serverName,
  );
  if (!personal) return null;
  return errResult(
    `"${entry.id}" is already one of your personal connectors — a connector can't be both a ` +
      `personal connector and a workspace install. Uninstall it from your profile first, or ` +
      `grant your personal connector to this workspace instead.`,
  );
}

/**
 * `install` with `scope: "identity"` — install a remote MCP connection as a
 * PERSONAL connector on the caller's own identity (`users/<id>/connectors.json`),
 * not into any workspace. The identity-plane sibling of `handleInstallRemoteOAuth`.
 *
 * DCR and interactive-connect brokered connectors install here. `dcr` (standard
 * dynamic-client-registration OAuth) authenticates via the interactive Connect
 * flow (`POST /v1/mcp-auth/initiate-identity` → `startIdentityAuth`). A brokered
 * connector binds the broker-side identity to the caller (`{type:"user"}`, not a
 * workspace); its only owner-scoped state is the provider's namespaced user id
 * plus an opaque connection pointer (the broker credential is platform-global),
 * and the connect round-trip runs through the provider's own callback routes.
 * `static` reads an operator client secret from the workspace credential store
 * and `provider` carries a platform/fleet auth class — both workspace/platform-
 * bound and rejected here (their identity variants are a separate slice).
 */
async function handleInstallIdentity(
  ctx: ManageConnectorsContext,
  identity: UserIdentity,
  entry: DirectoryEntry,
): Promise<ToolResult> {
  const callerId = identity.id;

  // Personal connectors are remote MCP connections (mirrors the personal-
  // workspace admission rule). Other install kinds belong in a shared workspace.
  if (entry.install.kind !== "remote-oauth") {
    return errResult(
      `Personal connectors are remote MCP connections. "${entry.id}" installs as a ` +
        `"${entry.install.kind}" bundle — install it into a shared workspace instead.`,
    );
  }

  // Gate: a personal connector must be one the CALLER can complete a connect
  // for. That is DCR, or a brokered connector whose provider brokers an
  // interactive connect (`initiate`) — the capability, not a vendor name, so a
  // third provider that brokers OAuth qualifies without editing this line and
  // one that does not (Smithery, whose setup lives on its own hosted page) is
  // refused. `static` reads a workspace-scoped operator secret and `provider`
  // mints a platform credential; both are workspace/platform-bound. Fail fast,
  // before any wiring.
  // An unconfigured broker is a deploy problem, not an unsupported plane —
  // say which before the capability gate turns it into "not supported here".
  const brokerProvider = providerFor(ctx, entry.install.auth);
  if (isBrokeredAuthKind(entry.install.auth) && !brokerProvider) {
    return errResult(brokerNotConfiguredMessage(entry.name, entry.install.auth));
  }
  if (!identityInstallableAuth(ctx, entry.install.auth)) {
    return errResult(
      `"${entry.name}" uses "${entry.install.auth}" auth, which isn't supported for personal ` +
        `connectors yet — only standard OAuth (DCR) and brokered connectors that support an ` +
        `interactive connect can install on your identity today. Install it into a shared ` +
        `workspace instead.`,
    );
  }

  // `validateRemoteOAuthInstall` re-resolves a brokered entry's block from the
  // trusted catalog — the same bound the workspace path applies, and the reason
  // the caller's own block never reaches `createSession`. static/provider are
  // already rejected above. The action shape is validated upstream by
  // `parseDirectoryEntry`.
  const validated = await validateRemoteOAuthInstall(ctx, entry, entry.install);
  if ("error" in validated) return errResult(validated.error);
  const action = validated.action;

  const serverName = slugifyServerName(entry.id);

  // Reserved-name guard: a connector whose slug collides with a system-tool
  // prefix (e.g. `nb`) would surface its tools as `nb__…` in the trusted system
  // band. Workspace registries can't hit this — the real `nb` system source
  // already occupies that slot, so a colliding interactive connect is skipped
  // (`startAuthInner`'s `!hasSource`), and eager-started workspace sources also
  // pass `startBundleSource`'s `validateServerName`. The identity registry
  // carries no system source, so neither applies; reject at the install boundary
  // (and again in `startIdentityAuth`) to keep a reserved-name record out of
  // connectors.json.
  if (isReservedServerName(serverName)) {
    return errResult(
      `"${entry.id}" resolves to "${serverName}", a name reserved for NimbleBrain system ` +
        `tools. Pick a connector with a different id.`,
    );
  }

  // Idempotency (identity side): if this connector is already installed on the
  // caller's identity, short-circuit BEFORE any wiring — a re-install must not
  // mint a fresh brokered session and orphan the prior one. The workspace path
  // guards the same way (`handleDuplicateInstall`, before `resolveInstallWiring`).
  // `add` upserts, so the record survives either way; this just defers the
  // session-create and keeps the contract idempotent (brokered and DCR alike).
  const existing = await new IdentityConnectorStore({
    workDir: ctx.runtime.getWorkDir(),
  }).get(callerId, serverName);
  if (existing) {
    return {
      content: textContent(
        `"${entry.name}" is already a personal connector. Connect it to authenticate.`,
      ),
      structuredContent: { ok: true, alreadyInstalled: true, serverName, scope: "identity" },
      isError: false,
    };
  }

  // Forbid the collision (identity side): reject if this serverName already
  // exists as a shared-workspace install in any workspace the caller belongs to
  // (a connector can't be both a personal connector and a workspace install).
  const collidingWsId = await findSharedWorkspaceInstall(ctx, callerId, serverName);
  if (collidingWsId) {
    return errResult(
      `"${entry.id}" is already installed as a connector in a workspace you belong to — ` +
        `a connector can't be both a personal connector and a workspace install. Use it ` +
        `there, or uninstall it from that workspace first.`,
    );
  }

  // Host UI placement is SERVER-authored: resolve from the operator-trusted
  // catalog by id, never the caller's entry (a forged entry can't inject chrome).
  const trustedUi = (await ctx.runtime.getConnectorDirectory().catalogById(entry.id))?.ui;

  // Resolve install wiring, owner-generic. DCR carries none (no session, no
  // client secret). A brokered connector creates the upstream session bound to
  // the caller's identity (`{type:"user"}`, not a workspace) and returns the
  // per-install session URL plus a transport naming its credential provider —
  // the same wiring the workspace path builds via `resolveInstallWiring`,
  // owner-swapped.
  let brokeredWiring: BrokeredWiring | undefined;
  if (brokerProvider) {
    const wiring = await buildBrokeredWiring(
      brokerProvider,
      action,
      { type: "user", userId: callerId },
      entry.id,
      entry.name,
    );
    if ("__err" in wiring) return errResult(wiring.__err);
    brokeredWiring = wiring;
  }

  // Strip the `oauthScope: "workspace"` literal `buildRemoteBundleRef` stamps for
  // the workspace path — an identity ref is user-owned structurally, by its
  // location in `connectors.json`, and carries no scope field (see
  // `IdentityConnectorStore`). The brokered marker, when present, rides the ref
  // so the Connect route and list handler key on it.
  const ref = buildRemoteBundleRef(action, serverName, trustedUi, brokeredWiring, undefined);
  delete (ref as { oauthScope?: "workspace" }).oauthScope;

  // The connector-skill overlay (`syncBoundSkills`) is workspace-keyed; the
  // identity-plane overlay (materializing into the user's skill store) is a
  // follow-up. It's best-effort / non-fatal, so skipping it doesn't affect the
  // connector's function — do NOT fake a wsId to force it.

  await new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() }).add(callerId, ref);

  // No eager-start: a connector has no live credentials until the user completes
  // the interactive Connect flow — DCR via `POST /v1/mcp-auth/initiate-identity`
  // (`startIdentityAuth`), a brokered one via that provider's own initiate route.
  // Both callbacks start the source into the user registry
  // (`getIdentityConnectorSource`) when the browser returns. Install only persists
  // the record.
  return {
    content: textContent(
      `Installed "${entry.name}" as a personal connector. Connect it to authenticate.`,
    ),
    structuredContent: { ok: true, alreadyInstalled: false, serverName, scope: "identity" },
    isError: false,
  };
}

/**
 * The id of a SHARED workspace the caller belongs to that already installs
 * `serverName`, or `null`. Skips the caller's own personal workspace (the legacy
 * personal home — not a shared collision). Reads persisted `workspace.json`
 * bundles, so it's pod-independent (a self-heal / cold pod can't hide a
 * collision). Install-time enforcement only: a collision that forms later — the
 * caller joins a workspace that already installs `serverName` — isn't caught
 * here, and `resolvePermissionOwner` resolves it personal-first by a stated rule.
 */
async function findSharedWorkspaceInstall(
  ctx: ManageConnectorsContext,
  callerId: string,
  serverName: string,
): Promise<string | null> {
  const workspaces = await ctx.runtime.getWorkspaceStore().getWorkspacesForUser(callerId);
  for (const ws of workspaces) {
    if (ws.isPersonal === true) continue;
    if (ws.bundles.some((b) => serverNameFromRef(b) === serverName)) return ws.id;
  }
  return null;
}

/**
 * `connect_api_key` — authenticate an already-installed brokered connector
 * whose upstream takes a key rather than a browser redirect. The non-redirect
 * sibling of a provider's OAuth connect route: there is no redirect, so it's a
 * tool action, not a route (no state cookie, no callback — the two reasons that
 * path stays a route). The web shell renders a form from the connector's
 * declared fields and submits the values here.
 *
 * The tool owns authorization, source registration and connection state. What
 * the fields MEAN — which are required, how they reach the broker, what gets
 * recorded — is the provider's, behind `connectApiKey`.
 *
 * Trust posture (mirrors the OAuth path):
 *  - The connector and its field declarations come from the SERVER-trusted
 *    catalog (`catalogById`), never the caller. The only caller input is the
 *    connectorId and the field *values*.
 *  - Field values are handed to the broker and NEVER persisted by the platform —
 *    the provider keeps only an opaque pointer, exactly like the OAuth path. We
 *    don't custody the user's key.
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

  const resolved = await resolveApiKeyConnector(ctx, catalogId);
  if ("error" in resolved) return errResult(resolved.error);
  const { entry, config, provider, connectApiKey } = resolved;

  const serverName = slugifyServerName(catalogId);
  const owner: ConnectorOwner = { type: "workspace", wsId };
  const workDir = ctx.runtime.getWorkDir();
  const brokered: BrokeredRef = { provider: entry.auth, connectorId: catalogId };
  const lifecycle = ctx.runtime.getLifecycle();

  // Authz: a FIRST connect is member-level, matching the OAuth connect route.
  // But a RE-CONNECT/rotation replaces and revokes the shared credential every
  // member's agent runs under — destructive like `disconnect`, which is
  // admin-gated. So gate only the rotation case on workspace admin. A provider
  // with no `hasConnection` cannot distinguish the two and gets the member-level
  // treatment its own connect semantics imply.
  const alreadyConnected = provider.hasConnection?.({ owner, brokered, workDir }) ?? false;
  if (alreadyConnected && !isWorkspaceAdmin(ws, identity)) {
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

  let connected: { status: string } | { error: string };
  try {
    connected = await connectApiKey({
      owner,
      workDir,
      connectorId: catalogId,
      config,
      fields: stringFields(rawFields),
    });
  } catch (err) {
    // A THROW is a broker failure — genericize it so a rejected credential never
    // echoes back what was submitted. A returned `{ error }` is the provider's
    // own caller/operator-facing message and passes through verbatim.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[connect_api_key] ${entry.auth} connect failed for ${catalogId} in ${wsId}: ${msg}`);
    return errResult(
      "Could not connect with the provided credentials. Check the key (and any " +
        "region / subdomain) and try again.",
    );
  }
  if ("error" in connected) return errResult(connected.error);

  lifecycle.recordConnectionStateChange(serverName, wsId, WORKSPACE_PRINCIPAL_ID, "running");

  return {
    content: textContent(`Connected ${entry.name}.`),
    structuredContent: { connected: true, serverName, status: connected.status },
    isError: false,
  };
}

/**
 * Narrow a wire payload to string values. Anything else is dropped rather than
 * coerced — the provider validates what remains against its own declaration, and
 * a non-string arriving where a credential field is expected is a caller bug the
 * provider's "required" check surfaces by name.
 */
function stringFields(raw: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") fields[k] = v;
  }
  return fields;
}

/**
 * Resolve everything `connect_api_key` needs about the target: the trusted
 * catalog entry, the provider that brokers it, its opaque catalog block, and the
 * provider's narrowed `connectApiKey` arm.
 *
 * The arm is captured here rather than re-read at the call site because the
 * intervening awaits would widen an optional property back to `undefined`.
 */
async function resolveApiKeyConnector(
  ctx: ManageConnectorsContext,
  catalogId: string,
): Promise<
  | {
      entry: ConnectorCatalogEntry;
      config: Record<string, unknown>;
      provider: ManagedConnectorProvider;
      connectApiKey: NonNullable<ManagedConnectorProvider["connectApiKey"]>;
    }
  | { error: string }
> {
  const entry = await ctx.runtime.getConnectorDirectory().catalogById(catalogId);
  if (!entry) return { error: `Connector "${catalogId}" not in catalog.` };
  const config = brokeredCatalogConfig(entry);
  if (!config) return { error: `Connector "${catalogId}" is not brokered (auth=${entry.auth}).` };
  const provider = providerFor(ctx, entry.auth);
  if (!provider) return { error: brokerNotConfiguredMessage(entry.name, entry.auth) };
  const connectApiKey = provider.connectApiKey;
  if (!connectApiKey) {
    return {
      error:
        `"${entry.name}" is brokered by "${entry.auth}", which has no API-key connect. ` +
        "Use its own Connect flow instead.",
    };
  }
  return { entry, config, provider, connectApiKey };
}

/**
 * Bring the MCP source online before the provider records the connection (the
 * OAuth adopt path's ordering invariant, so boot-state derivation stays
 * honest). A connector with no ref yet has never been installed, so this
 * doubles as the "install first" guard. Returns an error string, or null on
 * success.
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
 * Validate the wire payload as a `DirectoryEntry`. Tools/JSON arrive
 * as `unknown` from the dispatcher and the entry came from a client,
 * not the registry — anyone with API access can construct a payload.
 * Same threat model as the catalog `iconUrl` allowlist (a malicious
 * entry attempting to coerce the install path into an attacker-
 * controlled package name or URL).
 *
 * Per-kind shape:
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
function parseDirectoryEntry(input: unknown): DirectoryEntry | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.name !== "string") return null;
  const install = e.install as { kind?: unknown; url?: unknown } | undefined;
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
  return kind === "remote-oauth" || kind === "direct-url";
}

/**
 * Per-kind value-shape gate: remote-oauth URLs must parse as `http(s):` (the
 * protocol allowlist that keeps a malformed entry from slipping a
 * `javascript:` / `data:` / `file:` URL into connector creation). direct-url
 * has no value-shape check yet (parked behind an errResult).
 */
function isInstallPayloadValid(install: { kind?: unknown; url?: unknown }): boolean {
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
 * layout under `credentials/<provider>/<connectorId>/` works identically
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
  // lookup a `provider` or brokered install needs), which also re-resolves those
  // entries' security-critical fields from the server-trusted catalog. The
  // expensive remote work — the brokered session create, the operator credential
  // read — is deferred until after the dedup check so a duplicate-install click
  // doesn't burn an upstream session.
  const validated = await validateRemoteOAuthInstall(ctx, entry, entry.install);
  if ("error" in validated) return errResult(validated.error);
  const action = validated.action;

  // Host UI placement (sidebar app, etc.) is SERVER-authored metadata. Resolve
  // it from the operator-trusted catalog by id — never the caller-supplied
  // entry — so a forged entry can't inject host chrome. Cached by the directory
  // facade. Undefined when the id isn't a known catalog connector. Placements
  // are re-validated at registration (`sanitizePlacements`).
  const trusted = await ctx.runtime.getConnectorDirectory().catalogById(entry.id);
  const trustedUi = trusted?.ui;

  // serverName is the slugified canonical reverse-DNS form — opaque,
  // URL-safe, filesystem-safe, collision-free by construction. See
  // `slugifyServerName` for the rule.
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
  // before any expensive wiring so a re-click doesn't burn a brokered session.
  const dupResult = await handleDuplicateInstall(
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
    trustedUi,
    wiring.brokeredWiring,
    wiring.staticOAuthClient,
  );
  // Bind the curated connector-skill overlay, if one is curated for this
  // connector's identity. Best-effort + non-fatal (see `syncBoundSkills`): the
  // returned lock rides the persisted ref so uninstall cleans it up and the
  // dedupe path knows the connector has an overlay. The overlay materializes
  // into the workspace's `connector-skills/` store, NEVER the system prompt.
  const skillsLock = await lifecycle.syncBoundSkills(
    connectorSkillIdentityFrom(
      // From the operator-trusted catalog entry, NEVER the caller's action: the
      // identity is interpolated into the overlay fetch path, so a field the
      // caller controls chooses which repository is read. `action` carries the
      // caller's own object for every auth kind the install does not re-resolve
      // (`parseDirectoryEntry` strips no unknown install fields), which is
      // exactly the provenance this must not depend on. Same source
      // `connector-skill-reconcile` reads it from.
      trusted?.composio?.toolkit,
      // Derive the overlay identity from the canonical reverse-DNS name
      // (`com.dropbox/mcp` → `dropbox`), NOT the slugified serverName
      // (`com-dropbox-mcp`) — the slug has no dotted structure to split on, so
      // it derives the whole slug and 404s the overlay for every DCR connector.
      entry.id,
    ),
    serverName,
    wsId,
    ctx.runtime.getWorkDir(),
  );
  if (skillsLock.length > 0) ref.skillsLock = skillsLock;
  await ctx.runtime.getWorkspaceStore().update(wsId, { bundles: [...ws.bundles, ref] });
  const wsRegistry = ctx.runtime.getRegistryForWorkspace(wsId);
  await lifecycle.seedInstance(serverName, action.url, ref, undefined, wsId);
  lifecycle.notifyInstalled(serverName, wsId);

  // Static-credential URL bundles authenticate without an MCP-side OAuth flow,
  // so eager-start the source here rather than waiting for the next platform
  // boot. For static / dcr bundles, source.start() is bound to
  // `lifecycle.startAuth` (called from `/v1/mcp-auth/initiate`) and doesn't run
  // here. Eager-start is a UX optimization; a failure returns a warning, not an
  // error, because the install itself has still succeeded.
  let startWarning: string | undefined;
  if (isBrokeredAuthKind(action.auth) || action.auth === "provider") {
    startWarning = await eagerStartRemoteSource(ctx, ref, wsRegistry, wsId, entry, action);
  }

  // Inbound hooks the connector declares. Runs after the eager start because it
  // has to call a tool on the server; for a connector whose source starts later
  // (interactive OAuth) this is a no-op and the same reconcile runs when the
  // connection reaches `running`. It joins that reconcile's run rather than
  // racing it — see `singleFlight` in `hooks/reconcile.ts`.
  //
  // A contract violation is a WARNING, not an error, for the same reason the
  // eager start above returns one: by this line the ref is persisted, the
  // instance is seeded and the source is running, so the install has succeeded
  // and saying otherwise describes state we kept. The check cannot move ahead
  // of that commit — it needs the server's tool list, and the source is not
  // started until after the ref is written — and reporting a failed install for
  // a connector that is installed sends the operator to a retry that
  // `handleDuplicateInstall` short-circuits, which is how the check would end up
  // firing exactly once and then never again.
  const hookWarning = await provisionDeclaredHooks(ctx, wsId, serverName);

  const warning = [startWarning, hookWarning].filter(Boolean).join(" ") || undefined;
  return {
    content: textContent(remoteInstallMessage(entry.name, isPersonalTarget, warning)),
    structuredContent: {
      ok: true,
      alreadyInstalled: false,
      serverName,
      scope: "workspace",
      wsId,
      ...(warning ? { warning } : {}),
    },
    isError: false,
  };
}

/**
 * Provision a freshly-installed connector's declared hooks.
 *
 * Returns a WARNING string naming the offending declaration when the
 * connector's manifest breaks the hook contract, or `undefined` on success, on
 * a connector with no hooks, and on a runtime with no hooks door. Never an
 * error: by the time this runs the install has committed, so the caller
 * surfaces it beside the eager-start warning rather than reporting a failure
 * for a connector that is installed and running.
 *
 * The violation stays visible after the install returns — the same reconcile
 * re-runs (and re-logs) on every transition to `running`, so a restart or a
 * reconnect re-reports it rather than the check firing once and going quiet.
 */
async function provisionDeclaredHooks(
  ctx: ManageConnectorsContext,
  wsId: string,
  serverName: string,
): Promise<string | undefined> {
  try {
    await ensureHooks(ctx.runtime.getHookReconcileDeps(), wsId, serverName);
    return undefined;
  } catch (err) {
    if (err instanceof HookContractError) return err.message;
    // Anything else (the source went away mid-install, a transient store
    // error) leaves the connector installed and the stream unprovisioned —
    // recoverable with `rotate_hook`, and not worth failing an install over.
    log.warn("[hooks] install-time provisioning failed", {
      connector: serverName,
      workspace_id: wsId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// ── Inbound hooks (install / uninstall only) ─────────────────────────
//
// Installing a connector provisions its declared streams and uninstalling
// revokes them, both as a consequence of the connector's own lifecycle — that
// is all this file does with hooks. INSPECTING and ROTATING a stream live in
// `tools/platform/hooks.ts`, because those answer about the hook itself rather
// than about the connector, and the operator asking them needs the delivery
// URL — the one thing this file's tools deliberately never returned.
//
// They were both here once, and the split is what the earlier arrangement was
// guarding against: two surfaces over one lifecycle drift, and they did, with
// only one of them refusing a rotation against a server that was not running.
// The resolution is one surface each rather than a guard in both.

/**
 * What a brokered provider produces at install time: the minted session URL,
 * the transport that reaches it, and the coordinates the runtime persists on
 * the BundleRef so the probe and teardown can name the session later.
 *
 * The broker credential never appears here. The transport names a credential
 * PROVIDER (`auth: { type: "provider", provider }`), which attaches the secret
 * at transport-build time — so neither the value nor the environment variable's
 * name is at rest in workspace.json.
 */
interface BrokeredWiring {
  url: string;
  transport: RemoteTransportConfig;
  brokered: BrokeredRef;
}

/**
 * Check an operator-authored `secretHeaders` block before it becomes transport
 * config: every value must be a `{ ref: "credential", key }` pointer.
 *
 * A literal here would be a secret at rest in a catalog file, which is the copy
 * the credential store exists to remove — so it is refused rather than passed
 * through. Refusing at install (and naming the header) beats dropping the entry
 * silently: a connection missing the header reaches the service and fails there,
 * where the cause is a driver error rather than a catalog typo.
 *
 * Returns the bare reference, dropping the entry's optional `label` / `help`.
 * Those exist so the install dialog can ask a person a readable question; the
 * transport resolves a key, so carrying them into `workspace.json` would put
 * display copy in persisted connection config for nothing to read.
 */
function validateSecretHeaders(
  entryName: string,
  secretHeaders: Record<string, SecretHeaderRef> | undefined,
): { headers?: Record<string, CredentialRef> } | { error: string } {
  if (!secretHeaders) return {};
  const headers: Record<string, CredentialRef> = {};
  for (const [name, value] of Object.entries(secretHeaders)) {
    if (!isCredentialRef(value)) {
      return {
        error:
          `"${entryName}" declares secretHeaders["${name}"] as something other than ` +
          'a credential reference. Every value must be { ref: "credential", key } — ' +
          "a catalog entry names the secret, it never carries one.",
      };
    }
    headers[name] = { ref: "credential", key: value.key };
  }
  return { headers };
}

/**
 * Cheap up-front entry-shape validation. Two kinds of entry have their
 * security-critical fields re-resolved from the SERVER-trusted catalog by id,
 * with the caller's discarded:
 *
 *   - `auth: "provider"` mints a fleet-trusted, workspace-scoped service token
 *     and ships it to the entry's URL, so a workspace admin could otherwise
 *     forge an entry with an arbitrary url + audience/scope and exfiltrate a
 *     fleet token or reach an in-cluster `.svc` the SSRF guard protects.
 *   - **every brokered entry** spends the PLATFORM's broker credential to
 *     create a connection at the operator's account, so the target the provider
 *     is pointed at must come from the operator-published catalog. Otherwise a
 *     workspace admin forges an entry naming any server the broker can reach and
 *     gets a pre-authenticated, eager-started MCP source charged to the
 *     operator. This check IS the bound: a provider may have no incidental one
 *     (Composio happens to need a per-toolkit auth-config id declared first;
 *     Smithery needs nothing).
 *
 * Returns the (possibly-rewritten) action, or an error.
 */
async function validateRemoteOAuthInstall(
  ctx: ManageConnectorsContext,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
): Promise<{ action: RemoteOAuthInstall } | { error: string }> {
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
    const secretHeaders = validateSecretHeaders(entry.name, trusted.secretHeaders);
    if ("error" in secretHeaders) return secretHeaders;
    return {
      action: {
        ...action,
        url: trusted.url,
        providerAuth: trusted.providerAuth,
        // Read back from the trusted entry, never the caller's: the header NAME
        // decides what a fleet-trusted connection sends, and the key decides
        // which of the workspace's secrets it sends. A forged pair is a workspace
        // admin choosing both.
        ...(secretHeaders.headers ? { secretHeaders: secretHeaders.headers } : {}),
      },
    };
  }
  if (isBrokeredAuthKind(action.auth)) {
    const trusted = await ctx.runtime.getConnectorDirectory().catalogById(entry.id);
    const config = trusted?.auth === action.auth ? brokeredCatalogConfig(trusted) : undefined;
    if (!config) {
      return {
        error:
          `"${entry.name}" is not a recognized "${action.auth}" connector — ` +
          "refusing a brokered install from an unverified entry.",
      };
    }
    // Replace the caller's block with the operator-published one, under the key
    // the convention puts it at, so the wiring below reads a trusted value.
    return { action: { ...action, [action.auth]: config } as RemoteOAuthInstall };
  }
  return { action };
}

/**
 * Brokered MCP wiring: ask the provider for a session and shape the result into
 * a persistable ref + transport. Called only on the fresh-install branch —
 * gating it on dedup means a re-click on an installed connector doesn't mint a
 * second upstream session and orphan the prior one.
 *
 * Nothing here is vendor-shaped. The catalog block goes in opaque, the session
 * comes back naming its own credential provider and carrying its own opaque
 * coordinates, and both are persisted verbatim.
 */
async function buildBrokeredWiring(
  provider: ManagedConnectorProvider,
  action: RemoteOAuthInstall,
  owner: ConnectorOwner,
  entryId: string,
  entryName: string,
): Promise<BrokeredWiring | { __err: string }> {
  const config = brokeredCatalogConfig(action);
  if (!config) {
    // Unreachable — `validateRemoteOAuthInstall` re-resolves the block from the
    // trusted catalog and refuses when there is none. Typed for narrowing.
    return { __err: `"${entryName}" is missing its "${action.auth}" config block.` };
  }
  let session: ManagedSession;
  try {
    session = await provider.createSession({
      userId: provider.userId(owner),
      connectorId: entryId,
      config,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { __err: `${action.auth} session creation failed for "${entryName}": ${msg}` };
  }

  // A coordinate the provider NAMED but left blank is worse than one it omitted:
  // the ref still reads as brokered, so the revalidator claims it and answers
  // `indeterminate` forever while uninstall silently skips teardown. Key-agnostic
  // by necessity — the kernel does not know which coordinates this provider
  // needs, only that a named one must carry a value.
  for (const [key, value] of Object.entries(session.providerRef ?? {})) {
    if (value) continue;
    return {
      __err:
        `${action.auth} session for "${entryName}" returned an empty "${key}" coordinate — ` +
        "refusing to persist a connector the revalidator and uninstall cannot address.",
    };
  }

  return {
    url: session.url,
    transport: {
      type: session.type === "sse" ? "sse" : "streamable-http",
      // Name the credential, don't point at where it lives: the provider's
      // registered transport-credential attaches the secret at transport-build
      // time, so neither it nor an env var's NAME lands in workspace.json.
      ...(session.credentialProvider
        ? {
            auth: {
              type: "provider" as const,
              provider: session.credentialProvider,
              config: {},
            },
          }
        : {}),
      ...(session.headers && Object.keys(session.headers).length > 0
        ? { headers: session.headers }
        : {}),
    },
    brokered: {
      provider: action.auth,
      connectorId: entryId,
      ...(session.providerRef ? { providerRef: session.providerRef } : {}),
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
  const credStore = ctx.runtime.getCredentialStore();
  const secret = await credStore.get({ kind: "workspace", wsId }, setup.clientSecretKey, {
    caller: "connector-tools:install",
    purpose: `verify operator client_secret is seeded for ${entry.name}`,
  });
  if (!secret) {
    return {
      __err: `Operator client_secret for "${entry.name}" is missing — re-run Set up to seed it.`,
    };
  }
  return { clientId: operatorApp.clientId, clientSecretKey: setup.clientSecretKey };
}

/**
 * Build the BundleRef from the resolved wiring (a brokered session URL +
 * transport, or static client credentials). Constructed on the fresh-install
 * branch only; the dedup branches re-use the existing persisted ref.
 */
function buildRemoteBundleRef(
  action: RemoteOAuthInstall,
  serverName: string,
  trustedUi: ConnectorCatalogEntry["ui"],
  brokeredWiring: BrokeredWiring | undefined,
  staticOAuthClient: { clientId: string; clientSecretKey: string } | undefined,
): BundleRef {
  return {
    url: brokeredWiring?.url ?? action.url,
    serverName,
    // Pin the transport class the source advertised. Default would be
    // streamable-http (createRemoteTransport's fallback), which is wrong for
    // vendors whose remote `type` is `sse` — PayPal / Cloudflare / Webflow / Wix
    // in the bundled catalog today. A `provider`-auth entry also carries its
    // credential class here: provider + config are copied VERBATIM from the
    // (operator-authored) catalog entry — never tenant input — which is what
    // makes a self-installable platform connector safe. That provenance is
    // specific to THIS branch: a brokered session also yields provider auth,
    // but from a broker's session response, so `provider` auth alone is not a
    // catalog-provenance signal (see `isMintedFleetSource`).
    transport:
      brokeredWiring?.transport ??
      (action.auth === "provider" && action.providerAuth
        ? {
            type: action.transportType,
            auth: {
              type: "provider",
              provider: action.providerAuth.provider,
              config: action.providerAuth.config,
            },
            // The workspace's own secrets, as references. They ride alongside the
            // provider credential rather than replacing it: `auth` is how the
            // connection proves who is calling, these are what that caller may
            // open. The transport resolves each one per connection at the
            // connection's workspace scope, so two workspaces installing this
            // same entry send different values and a rotation is a `put`.
            ...(action.secretHeaders ? { headers: action.secretHeaders } : {}),
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
    // Brokered marker: who brokered this install, which catalog entry it came
    // from (the persisted url is a per-install session URL, so a url→catalog
    // lookup misses), and the provider's own opaque coordinates for its probe
    // and teardown.
    ...(brokeredWiring ? { brokered: brokeredWiring.brokered } : {}),
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
 * brokered bundles whose persisted `b.url` is the per-install session URL and
 * never equals the catalog placeholder `action.url`. Falls back to URL match
 * for legacy bundles persisted before slugify-on-install (no `serverName` field).
 */
async function handleDuplicateInstall(
  ctx: ManageConnectorsContext,
  wsId: string,
  ws: Workspace,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
  serverName: string,
  isPersonalTarget: boolean,
): Promise<ToolResult | null> {
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
    await lifecycle.seedInstance(dupServerName, action.url, dup, undefined, wsId);
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
 * Resolve the fresh-install wiring for a remote-OAuth entry: the brokered
 * session, or the operator OAuth client (static-auth). Deferred until after
 * dedup so a duplicate-install click never mints a brokered session or reads
 * the credential. Returns `{}` for auth kinds needing neither.
 */
async function resolveInstallWiring(
  ctx: ManageConnectorsContext,
  wsId: string,
  ws: Workspace,
  entry: DirectoryEntry,
  action: RemoteOAuthInstall,
): Promise<
  | {
      brokeredWiring?: BrokeredWiring;
      staticOAuthClient?: { clientId: string; clientSecretKey: string };
    }
  | { error: string }
> {
  if (isBrokeredAuthKind(action.auth)) {
    const provider = providerFor(ctx, action.auth);
    if (!provider) return { error: brokerNotConfiguredMessage(entry.name, action.auth) };
    const brokeredWiring = await buildBrokeredWiring(
      provider,
      action,
      { type: "workspace", wsId },
      entry.id,
      entry.name,
    );
    if ("__err" in brokeredWiring) return { error: brokeredWiring.__err };
    return { brokeredWiring };
  }
  if (action.auth === "static") {
    const staticOAuthClient = await loadStaticOAuthClient(ctx, wsId, ws, entry, action);
    if ("__err" in staticOAuthClient) return { error: staticOAuthClient.__err };
    return { staticOAuthClient };
  }
  return {};
}

/**
 * Eager-start a freshly-installed static-credential source (brokered / provider)
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
    await startBundleSource(ref, wsRegistry, ctx.runtime.getEventSink(), {
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

async function handleDisconnect(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  void scopeHint; // workspace-only path; `scope:"identity"` is routed upstream
  const lifecycle = ctx.runtime.getLifecycle();

  // Workspace connectors only. A personal (identity-owned) connector is
  // disconnected via `handleDisconnectIdentity`, which the dispatcher routes to
  // for `scope:"identity"` before reaching here — so this path always has a
  // workspace.
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
 * Workspace connectors only — a personal (identity-owned) connector is removed
 * via `handleDisconnectIdentity` (the dispatcher routes `scope:"identity"` there).
 */
async function handleUninstall(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  serverName: string,
  scopeHint: string | undefined,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  void scopeHint; // workspace-only path; `scope:"identity"` is routed upstream
  const lifecycle = ctx.runtime.getLifecycle();

  // Workspace connectors only. A personal (identity-owned) connector is removed
  // via `handleDisconnectIdentity` (dispatcher routes `scope:"identity"` there
  // before reaching here) — so this path always has a workspace.
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

  // Revoke OAuth tokens upstream first when applicable.
  const revokeResult = instance?.ref
    ? await revokeUrlBundleTokens(lifecycle, ctx, serverName, wsId)
    : {};

  try {
    const registry = ctx.runtime.getRegistryForWorkspace(wsId);
    await lifecycle.uninstall(serverName, registry, wsId);
    await stripUninstalledBundleEntry(ctx, wsId, serverName);
    // Retire every hook this connector held. The door independently refuses a
    // delivery for an uninstalled connector — it needs the connector's base URL
    // to have anywhere to forward to — so this is not the only thing that stops
    // one. It is what keeps a later reinstall from resurrecting a key id whose
    // URL has been in the wild the whole time.
    await revokeHooksForConnector(ctx.runtime.getWorkspaceStore(), wsId, serverName);
    // And reset the outbox position. The cursor is the emitting server's own
    // opaque value, carrying an epoch it may reset while the connector is gone,
    // so a reinstall resuming from a stale one would ask a question its outbox
    // can no longer answer. Bootstrap costs only what was emitted while nobody
    // was installed to receive it.
    await clearCursor(ctx.runtime.getWorkspaceStore(), wsId, serverName);
    // And drop the tool-set watch, whose closure would otherwise hold a source
    // nothing routes to any more.
    stopWatchingHooks(wsId, serverName);
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
 * Strip the just-uninstalled connector from `workspace.json#bundles[]`.
 * `lifecycle.uninstall` clears its own `instances` map and the legacy global
 * `nimblebrain.json`, but not the workspace record.
 */
async function stripUninstalledBundleEntry(
  ctx: ManageConnectorsContext,
  wsId: string,
  serverName: string,
): Promise<void> {
  const wsAfter = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!wsAfter) return;
  // `deriveServerName` needs a string; a legacy or malformed row has no `url`,
  // and throwing here would fail the uninstall of a *different*, healthy
  // connector. Such a row matches nothing, so it is retained untouched.
  const filtered = wsAfter.bundles.filter((b) => {
    if (b.serverName) return b.serverName !== serverName;
    if (typeof b.url !== "string" || b.url.length === 0) return true;
    return deriveServerName(b.url) !== serverName;
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
    const tools = await readConnectorTools(source);
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
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");

  const lifecycle = ctx.runtime.getLifecycle();
  if (!wsId) return errResult("Workspace context required.");
  if (!lifecycle.getInstance(serverName, wsId)) {
    return errResult(`Bundle "${serverName}" not installed in workspace.`);
  }

  const owner = await resolvePermissionOwner(ctx, wsId, callerId, serverName);
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
      readConnectorTools(source),
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
 * Resolve the policy owner for a connector's permission read/write. A
 * **personal connector** (installed on the caller's identity — in their
 * `connectors.json`) owns its per-tool policy under `{scope:"user"}`, the same
 * record the identity-door dispatch gate reads. Any other connector is
 * workspace-scoped (`{scope:"workspace", wsId}`). Returns null when neither a
 * personal connector nor a workspace is available.
 */
async function resolvePermissionOwner(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
): Promise<PermissionOwner | null> {
  if (callerId && serverName) {
    const personal = await new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() }).get(
      callerId,
      serverName,
    );
    if (personal) return { scope: "user", userId: callerId };
  }
  return wsId ? { scope: "workspace", wsId } : null;
}

async function handleGetPermissions(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const owner = await resolvePermissionOwner(ctx, wsId, callerId, serverName);
  if (!owner) return errResult("Could not resolve permission owner — sign in or pick a workspace.");

  const tools = await ctx.runtime.getPermissionStore().getConnector(owner, serverName);
  return {
    content: textContent(`Permissions: ${Object.keys(tools).length} non-default entries.`),
    structuredContent: { scope: owner.scope, serverName, tools },
    isError: false,
  };
}

/**
 * Admission for a workspace-scope tool-policy write: the connector must be
 * installed here, and the caller must be a workspace admin. Returns the
 * refusal, or null to proceed — same shape as `workspaceInstallAdmission`.
 *
 * Tool policy decides what the workspace's agent may call, for every member,
 * so a non-admin must not set it on everyone else's behalf. Personal
 * workspaces have a single admin (the owner) by invariant, so one gate covers
 * both shapes. User-scope policy takes no gate: it governs the caller's own
 * personal connector and widens nobody else's reach — the same reasoning the
 * grant handlers spell out.
 */
async function workspacePolicyAdmission(
  ctx: ManageConnectorsContext,
  wsId: string,
  serverName: string,
): Promise<ToolResult | null> {
  // Reject unknown serverName up front. Permission entries for a non-existent
  // connector would sit unused (the runtime gate keys on installed-source
  // dispatch); failing fast surfaces typos at write time.
  if (ctx.runtime.getLifecycle().getInstance(serverName, wsId) == null) {
    return errResult(`Connector "${serverName}" is not installed in workspace "${wsId}".`);
  }
  const identity = ctx.getIdentity();
  if (!identity) return errResult("Authentication required.");
  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return errResult(`Workspace "${wsId}" not found.`);
  if (!isWorkspaceAdmin(ws, identity)) {
    return {
      content: textContent("Workspace admin role required to set tool permissions."),
      structuredContent: { error: "permission_denied" },
      isError: true,
    };
  }
  return null;
}

async function handleSetPermissions(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  callerId: string | null,
  serverName: string,
  toolsInput: Record<string, unknown>,
): Promise<ToolResult> {
  if (!serverName) return errResult("serverName is required.");
  const owner = await resolvePermissionOwner(ctx, wsId, callerId, serverName);
  if (!owner) return errResult("Could not resolve permission owner — sign in or pick a workspace.");

  // A personal connector's existence is already confirmed by
  // `resolvePermissionOwner` (it's in the caller's identity store); a
  // workspace connector needs the admission check below.
  if (owner.scope === "workspace") {
    const refused = await workspacePolicyAdmission(ctx, owner.wsId, serverName);
    if (refused) return refused;
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
// A personal connector is installed on the caller's identity (their
// `connectors.json`). A grant lets the caller USE it inside a workspace they
// belong to — any workspace, including their own personal one (a personal
// workspace is just a workspace); reaching it there fails closed at dispatch
// without an active grant. The grant is the caller's own (`grantedBy =
// callerId`) and is per-granter: it only widens the granter's OWN reach, never
// another member's, so no admin gate is needed — any member may grant their own
// connector.
//
// A caller's personal connectors are all remote MCP connections (install admits
// only `remote-oauth`), so the grant / list handlers trust that every entry is a
// connector and don't re-derive "is this a connector."

/**
 * `list_personal_catalog` — the curated set of connectors offered for PERSONAL
 * (identity-plane) connection: operator-flagged `personal` connectors, narrowed
 * to what `handleInstallIdentity` will actually accept, minus the ones the
 * caller already installed on their identity. The read behind the profile "Add a
 * connector" picker.
 *
 * Both sides read the same predicate ({@link identityInstallableAuth}), so the
 * offered set is a subset of the acceptable set by construction — the picker can
 * never present a connector the install then refuses.
 */
async function handleListPersonalCatalog(
  ctx: ManageConnectorsContext,
  callerId: string | null,
): Promise<ToolResult> {
  if (!callerId) return errResult("Authentication required.");

  // Personal connectors are identity-owned and workspace-independent: read the
  // whole directory (no wsId → no workspace allow-list) and filter.
  const { entries } = await ctx.runtime.getConnectorDirectory().list({});

  // Drop connectors the caller already installed on their identity.
  const installed = await new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() }).list(
    callerId,
  );
  const installedServerNames = new Set(
    installed.map((ref) => serverNameFromRef(ref)).filter((n): n is string => n !== null),
  );

  const catalog = entries.filter(
    (e) =>
      e.personal === true &&
      e.install.kind === "remote-oauth" &&
      // Lockstep with handleInstallIdentity's gate — offered ⊆ acceptable.
      identityInstallableAuth(ctx, e.install.auth) &&
      !installedServerNames.has(slugifyServerName(e.id)),
  );

  return {
    content: textContent(`${catalog.length} connector(s) available for personal connection.`),
    structuredContent: { catalog },
    isError: false,
  };
}

/**
 * `list_personal_connectors` — the caller's personal connectors and, for each,
 * the workspaces it's granted to. The read behind the Profile → Connectors page.
 */
async function handleListPersonalConnectors(
  ctx: ManageConnectorsContext,
  callerId: string | null,
): Promise<ToolResult> {
  if (!callerId) return errResult("Authentication required.");
  const store = ctx.runtime.getPermissionStore();

  // The caller's whole grant map, read once (not per connector).
  const grantsByConnector = await store.listConnectorGrants(callerId);

  // Source of truth is the identity plane — `users/<id>/connectors.json` via
  // `IdentityConnectorStore`, not the legacy `ws_user_` registry.
  const refs = await new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() }).list(
    callerId,
  );

  // Enrich display metadata from the operator-trusted catalog (keyed by the same
  // slug the ref stamps) — the URL ref carries no human name/description. Falls
  // back to the slug when the catalog no longer lists the connector.
  const catalog = await ctx.runtime.getConnectorDirectory().catalogEntries();
  const byServerName = new Map(catalog.map((e) => [slugifyServerName(e.id), e]));

  const workDir = ctx.runtime.getWorkDir();
  const owner = { type: "user", userId: callerId } as const;
  const lifecycle = ctx.runtime.getLifecycle();
  // Resolve names first, in their own pass: a stored row this build cannot
  // name is dropped here rather than rendered under a name no Connect route
  // resolves. Keeping it out of the projection below leaves that closure
  // exactly as it was.
  const named = refs.flatMap((ref) => {
    const serverName = serverNameFromRef(ref);
    if (serverName !== null) return [{ ref, serverName }];
    log.warn(
      `[connectors] personal connector row names no server (url: ${JSON.stringify(ref.url)}) — omitted from the listing.`,
    );
    return [];
  });
  const connectors = await Promise.all(
    named.map(async ({ ref, serverName }) => {
      const cat = byServerName.get(serverName);
      // Auth kind + (for a brokered connector) the catalog connector id are read
      // from the stored ref, not the catalog — they're what the Connect route keys
      // on and must survive a catalog entry being renamed or removed. The brokered
      // marker is stamped at install by `buildRemoteBundleRef`; its absence means
      // DCR.
      const brokered = brokeredRef(ref);
      // Connected = authenticated, derived from PERSISTED credentials (the stored
      // token record for DCR, whatever the provider records for a brokered one) — which survive
      // a pod restart — OR the source already warm in this pod. Presence, NOT
      // validity: token expiry/revocation detection is the deferred reauth slice.
      // Persistence matters because `isIdentityConnectorRunning` is same-pod-only:
      // on a fresh pod an authed connector would otherwise report
      // `not_authenticated` and offer a Connect that then fails (it's already
      // authed). The agent lazy-starts the source from these same credentials, so
      // an authed-but-cold connector is genuinely usable.
      const authed = brokered
        ? (ctx.runtime
            .getManagedConnectorRegistry()
            .get(brokered.provider)
            ?.hasConnection?.({ owner, brokered, workDir }) ?? false)
        : await hasMcpOAuthTokens(workDir, owner, serverName);
      return {
        serverName,
        displayName: cat?.name ?? serverName,
        description: cat?.description ?? null,
        // Brand icon from the operator-trusted catalog (same source the "Add a
        // connector" picker renders), so an installed connector shows its icon too.
        ...(cat?.iconUrl ? { iconUrl: cat.iconUrl } : {}),
        // The Connect route differs by auth: DCR keys on serverName
        // (`/v1/mcp-auth/initiate-identity`); a brokered connector keys on the
        // catalog connector id and goes through its provider's own initiate route.
        // The profile UI branches on this.
        auth: brokered ? brokered.provider : "dcr",
        ...(brokered ? { connectorId: brokered.connectorId } : {}),
        // `authed` carries the common case; the warmth check is a deliberate
        // backstop, not redundancy — `warm` doesn't strictly imply `authed` (creds
        // can be deleted after the source warms), and it also catches a future
        // personal-connector auth type whose creds this `authed` derivation doesn't
        // yet know to look for. A live source is genuinely serving ⇒ `running`.
        state:
          authed || lifecycle.isIdentityConnectorRunning(callerId, serverName)
            ? ("running" as const)
            : ("not_authenticated" as const),
        grantedWorkspaces: grantsByConnector[serverName] ?? [],
      };
    }),
  );
  return {
    content: textContent(`${connectors.length} personal connector(s).`),
    structuredContent: { connectors },
    isError: false,
  };
}

/**
 * `grant_connector` — grant the caller's personal connector `serverName` for use
 * inside the workspace `targetWsId`. Validates the connector is one the caller
 * installed on their identity, and the target is a workspace the caller belongs
 * to. The grant is required in EVERY workspace, including the caller's own
 * personal one (a personal workspace is just a workspace — no free-at-home).
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

  // The connector must be one the caller installed on their identity.
  const installed = await new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() }).get(
    callerId,
    serverName,
  );
  if (!installed) {
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
 * `disconnect` / `uninstall` with `scope: "identity"` — fully remove a PERSONAL
 * connector from the caller's identity. Revokes every workspace grant first (no
 * grant should outlive the connector), then tears down the source, deletes the
 * identity credentials, and drops the install record
 * (`lifecycle.uninstallIdentityConnector`). The inverse of install + Connect +
 * grant; the connector leaves "Your connectors" and is offered again under "Add a
 * connector". Not-installed is an error (nothing to remove).
 */
async function handleDisconnectIdentity(
  ctx: ManageConnectorsContext,
  identity: UserIdentity | null,
  serverName: string,
): Promise<ToolResult> {
  if (!identity) return errResult("Authentication required.");
  if (!serverName) return errResult("serverName is required.");
  const callerId = identity.id;

  const store = new IdentityConnectorStore({ workDir: ctx.runtime.getWorkDir() });
  if (!(await store.get(callerId, serverName))) {
    return errResult(`"${serverName}" is not one of your personal connectors.`);
  }

  // Revoke every workspace grant FIRST — fail-closed, so a dangling grant never
  // references a removed connector. Read the connector's grants and revoke each
  // (idempotent).
  const grantedWorkspaces = await ctx.runtime
    .getPermissionStore()
    .getConnectorGrants(callerId, serverName);
  for (const wsId of grantedWorkspaces) {
    await ctx.runtime.getPermissionStore().revokeConnector(callerId, serverName, wsId);
  }

  // Drop the connector's per-tool allow/deny policies too — personal-connector
  // policies live under the user-scope record (`resolvePermissionOwner` →
  // `{scope:"user"}`). They have no meaning once the connector is gone, and
  // leaving them lets a stale "always allow" silently rebind on a reconnect (same
  // deterministic serverName). Mirrors the workspace uninstall's `deleteConnector`.
  await ctx.runtime
    .getPermissionStore()
    .deleteConnector({ scope: "user", userId: callerId }, serverName);

  // Full teardown: stop + drop the source, delete identity credentials, remove the
  // install record.
  await ctx.runtime
    .getLifecycle()
    .uninstallIdentityConnector(callerId, serverName, { workDir: ctx.runtime.getWorkDir() });

  return {
    content: textContent(
      grantedWorkspaces.length > 0
        ? `Disconnected "${serverName}" and revoked access in ${grantedWorkspaces.length} workspace(s).`
        : `Disconnected "${serverName}".`,
    ),
    structuredContent: {
      ok: true,
      scope: "identity",
      serverName,
      revokedWorkspaces: grantedWorkspaces.length,
    },
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
  const credStore = ctx.runtime.getCredentialStore();
  const hadPriorSecret =
    (await credStore.get({ kind: "workspace", wsId }, clientSecretKey, {
      caller: "connector-tools:setup_operator",
      purpose: "decide whether a failed workspace.json write may roll the secret back",
    })) !== null;
  await credStore.put({ kind: "workspace", wsId }, clientSecretKey, clientSecret.trim());

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
  credStore: CredentialStore,
  clientSecretKey: string,
  hadPriorSecret: boolean,
): Promise<void> {
  try {
    await ctx.runtime.getWorkspaceStore().update(wsId, { oauthOperatorApps: apps });
  } catch (err) {
    if (!hadPriorSecret) {
      try {
        await credStore.delete({ kind: "workspace", wsId }, clientSecretKey);
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
    const credStore = ctx.runtime.getCredentialStore();
    await credStore.delete({ kind: "workspace", wsId }, clientSecretKey).catch(() => {});
  }

  return {
    content: textContent(`Removed OAuth app config for "${entry.name}".`),
    structuredContent: { ok: true, catalogId },
    isError: false,
  };
}

// ── Workspace secrets ───────────────────────────────────────────────
//
// The operator surface on the credential store's WORKSPACE scope: seed a key,
// remove one, list what is set. Instance scope is deliberately absent — those
// are the deployment's own keys (LLM providers, brokers, the IdP) and belong to
// whoever can edit `nimblebrain.json` or reach the CLI, not to a workspace admin
// with a chat session.
//
// No action returns a value, ever. `list_secret_keys` answers "is it set, and
// when was it last written" because that is the whole of what an operator needs
// to know a reference will resolve; returning the secret would put every
// workspace's keys one tool call from a conversation transcript.

/** Resolve and admin-gate the workspace a secret action targets. */
async function requireSecretAdmin(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  verb: string,
): Promise<{ wsId: string } | ToolResult> {
  if (!wsId) return errResult("Workspace context required.");
  if (!identity) return errResult("Authentication required.");
  const ws = await ctx.runtime.getWorkspaceStore().get(wsId);
  if (!ws) return errResult(`Workspace "${wsId}" not found.`);
  if (!isWorkspaceAdmin(ws, identity)) {
    return {
      content: textContent(`Workspace admin role required to ${verb} workspace secrets.`),
      structuredContent: { error: "permission_denied" },
      isError: true,
    };
  }
  return { wsId };
}

/**
 * `set_secret` — write a workspace secret, creating or replacing it.
 *
 * Replacing is the rotation path: a `put` on the same key is picked up by the
 * next connection that resolves a reference to it, with no config edit and no
 * restart. So there is no separate `rotate_secret` action; there is nothing for
 * it to do that this does not.
 */
async function handleSetSecret(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  key: string,
  value: string,
): Promise<ToolResult> {
  const gate = await requireSecretAdmin(ctx, wsId, identity, "set");
  if ("content" in gate) return gate;
  if (!key) return errResult("key is required.");
  if (value.trim() === "") {
    return errResult(
      "value is required. To remove a secret use delete_secret — storing a blank " +
        "value would make a reference resolve to an empty header instead of failing.",
    );
  }
  try {
    await ctx.runtime.getCredentialStore().put({ kind: "workspace", wsId: gate.wsId }, key, value);
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
  return {
    content: textContent(`Stored secret "${key}".`),
    structuredContent: { ok: true, key },
    isError: false,
  };
}

/** `delete_secret` — remove a workspace secret. Idempotent; absent is not an error. */
async function handleDeleteSecret(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
  key: string,
): Promise<ToolResult> {
  const gate = await requireSecretAdmin(ctx, wsId, identity, "delete");
  if ("content" in gate) return gate;
  if (!key) return errResult("key is required.");
  try {
    await ctx.runtime.getCredentialStore().delete({ kind: "workspace", wsId: gate.wsId }, key);
  } catch (err) {
    return errResult(err instanceof Error ? err.message : String(err));
  }
  return {
    content: textContent(`Removed secret "${key}".`),
    structuredContent: { ok: true, key },
    isError: false,
  };
}

/** `list_secret_keys` — which keys this workspace has set, and when each was written. */
async function handleListSecretKeys(
  ctx: ManageConnectorsContext,
  wsId: string | null,
  identity: UserIdentity | null,
): Promise<ToolResult> {
  const gate = await requireSecretAdmin(ctx, wsId, identity, "list");
  if ("content" in gate) return gate;
  const keys = await ctx.runtime.getCredentialStore().list({ kind: "workspace", wsId: gate.wsId });
  return {
    content: textContent(`${keys.length} secret${keys.length === 1 ? "" : "s"} set.`),
    structuredContent: { keys },
    isError: false,
  };
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
