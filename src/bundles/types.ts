import type { UserConfigFieldDef } from "../config/workspace-credentials.ts";
import type { Connection } from "./connection.ts";

/**
 * Declaration of a UI placement in the shell layout.
 *
 * Sidebar slot convention:
 *   "sidebar" (priority < 10)  → ungrouped core nav (Home, Conversations)
 *   "sidebar" (priority >= 10) → grouped under "general"
 *   "sidebar.<group>"          → named group with label (e.g., "sidebar.apps" → "Apps")
 *   "sidebar.bottom"           → pinned to bottom zone
 *   "main"                     → app route (page content, not a nav item)
 */
export interface PlacementDeclaration {
  /** Which slot this UI fills (e.g., "sidebar", "sidebar.apps", "sidebar.bottom", "main"). */
  slot: string;
  /** ui:// resource URI served by this MCP server. */
  resourceUri: string;
  /** Display priority within the slot (lower = higher). Default: 100. For sidebar: 0-9 = ungrouped core nav, 10+ = grouped. */
  priority?: number;
  /** Human-readable label (for sidebar items, tabs, etc.). */
  label?: string;
  /** Icon (emoji or identifier). */
  icon?: string;
  /** Route path. Registers as /app/<path> (or "/" for Home). Works in sidebar and main slots. */
  route?: string;
  /** Size hint for the slot renderer. */
  size?: "compact" | "full" | "auto";
}

/** Resolved placement entry — PlacementDeclaration + the server it belongs to. */
export interface PlacementEntry extends PlacementDeclaration {
  serverName: string;
  priority: number; // Always resolved (defaults to 100)
  /** Workspace ID this placement belongs to (undefined = global/protected). */
  wsId?: string;
}

/** UI metadata stored on a bundle entry (from manifest at install time). */
export interface BundleUiMeta {
  name: string;
  icon: string;
  placements?: PlacementDeclaration[];
}

/** Transport configuration for remote MCP servers (url-based bundles). */
export interface RemoteTransportConfig {
  type?: "streamable-http" | "sse";
  auth?:
    | { type: "bearer"; token: string }
    | { type: "header"; name: string; value: string }
    | { type: "none" }
    /**
     * Non-interactive machine-plane auth produced by a named credential
     * PROVIDER (see `src/tools/credential-provider.ts`). The provider name +
     * its `config` are opaque to the kernel — for a catalog connector they come
     * from the operator-published catalog entry, never tenant input. The
     * built-in `"minted"` provider mints a short-lived, workspace-scoped service
     * token against the fleet authorizer (config:
     * `{ audience, scope, tokenUrl?, issuer? }`) and re-mints on expiry. The
     * endpoint resolves via `resolveAuthorizerTokenUrl`: `tokenUrl` is an explicit
     * per-connection endpoint override; `issuer` is the legacy identity from which
     * `${issuer}/token` is derived. Per-connection config wins over the global env.
     * No interactive OAuth, no static secret. The
     * workspace dimension is the connection's own workspace.
     */
    | { type: "provider"; provider: string; config: Record<string, unknown> };
  headers?: Record<string, string>;
  reconnection?: {
    maxReconnectionDelay?: number;
    initialReconnectionDelay?: number;
    maxRetries?: number;
  };
  sessionId?: string;
}

/**
 * One materialized connector-skill overlay bound to a bundle. Recorded on
 * the bundle's `BundleRef.skillsLock` at install so the dedupe path can tell a
 * bundle HAS a curated overlay (skip its `skill://usage`), and so the binding
 * is auditable. Cleanup on uninstall is keyed on `serverName` (it removes the
 * whole `connector-skills/<server>/` dir), not on these entries.
 */
export interface ConnectorSkillLockEntry {
  /** Overlay identity used for the lookup (e.g. `composio/gmail`). */
  identity: string;
  /** Pinned overlay-repo version the overlay was fetched at. */
  version: string;
  /** sha256 (hex) of the fetched overlay body — tamper-evidence. */
  sha: string;
  /** Materialized skill file location — recorded for traceability / debugging. */
  path: string;
}

/** Reference to a bundle — by name (mpak cache), local path, or remote URL. */
export type BundleRef =
  | {
      name: string;
      /**
       * Canonical reverse-DNS server name from the source `ServerDetail.name`
       * (e.g. `dev.mpak.nimblebraininc/echo`). When present, used as the
       * lifecycle / route key directly. When absent (legacy installs),
       * `serverNameFromRef` falls back to `deriveServerName(name)` → short
       * slug for backward compat.
       */
      serverName?: string;
      env?: Record<string, string>;
      allowedEnv?: string[];
      trustScore?: number | null;
      ui?: BundleUiMeta | null;
      /** Materialized connector-skill overlays bound to this bundle. */
      skillsLock?: ConnectorSkillLockEntry[];
    }
  | {
      path: string;
      serverName?: string;
      env?: Record<string, string>;
      allowedEnv?: string[];
      trustScore?: number | null;
      ui?: BundleUiMeta | null;
      /** Materialized connector-skill overlays bound to this bundle. */
      skillsLock?: ConnectorSkillLockEntry[];
    }
  | {
      url: string;
      serverName?: string;
      transport?: RemoteTransportConfig;
      trustScore?: number | null;
      ui?: BundleUiMeta | null;
      /** Materialized connector-skill overlays bound to this bundle. */
      skillsLock?: ConnectorSkillLockEntry[];
      /**
       * OAuth identity scope for this URL bundle. `"workspace"` is the
       * only legal value: one identity per `(workspace, server)`, shared
       * across workspace members. Personal connectors bind to the owning
       * user's personal workspace (`personalWorkspaceIdFor(userId)`).
       */
      oauthScope?: "workspace";
      /**
       * Opt in to the headless authorize-redirect probe. Default false.
       * Set only for bundles whose OAuth provider 302s straight to our
       * callback with a code (Reboot's `Anonymous` dev provider). MUST stay
       * false for normal interactive providers — a server-side `/authorize`
       * probe spins up a vendor auth session bound to our PKCE challenge
       * before the user acts and makes the vendor reject the user's real
       * code (`invalid_code`). See `headlessAuthProbe` in
       * `WorkspaceOAuthProvider`.
       */
      headlessAuthProbe?: boolean;
      /**
       * Pre-registered OAuth client config. Required for vendors that don't
       * support Dynamic Client Registration (RFC 7591) — Gmail, Outlook,
       * HubSpot, Asana, Zoom Marketplace user-OAuth apps. Operator pre-
       * registers an app in the vendor's developer portal, gets back a
       * `client_id` (and usually a `client_secret`), and points this field
       * at it.
       *
       * When present, the OAuth provider skips DCR — `clientInformation()`
       * returns the static client; `saveClientInformation()` is a no-op.
       * `clientSecret` is NEVER inline — it's a reference into the
       * credential store, resolved per-request so the secret doesn't sit
       * in workspace.json. Operators configure the secret in the web UI
       * (the workspace's Connections settings).
       *
       * Omit for vendors that DO support DCR (Granola, Notion). DCR is the
       * default path; static config is the opt-in.
       */
      oauthClient?: OAuthClientConfig;
      /**
       * OAuth scopes the bundle requests. Threaded into the provider's
       * `clientMetadata.scope` so the authorize URL carries the right
       * `scope=` param. Surfaces the requested permissions on the review
       * surface (admin reading workspace.json sees what the bundle asks
       * for) and lets the same MCP server be installed at different
       * permission levels (e.g., Gmail read-only vs. read+send).
       *
       * Omit to use server defaults — correct for DCR servers that derive
       * scopes automatically (Granola, Notion).
       */
      scopes?: string[];
      /**
       * Extra query params appended to the authorize URL. Covers Google's
       * `access_type=offline` + `prompt=consent` (needed for refresh-token
       * issuance) and any vendor-specific parameter. Static strings only —
       * no template interpolation.
       *
       * **Reserved keys rejected at config load** (`client_id`,
       * `redirect_uri`, `response_type`, `state`, `code_challenge`,
       * `code_challenge_method`, `scope`) so config can't override
       * security-critical params the provider sets itself.
       */
      additionalAuthorizationParams?: Record<string, string>;
      /**
       * Composio-backed connectors carry the catalog id forward so the
       * lifecycle's boot-time state check can probe the right
       * `connection.json` (under `credentials/composio/<connectorId>/`
       * rather than `credentials/mcp-oauth/<serverName>/tokens.json`).
       * Set at install time by `handleInstallRemoteOAuth`'s composio
       * branch. Undefined for dcr/static OAuth bundles.
       */
      composio?: { connectorId: string };
    };

/**
 * Config for a pre-registered OAuth client (Track A — alternative to DCR).
 * Lives on the URL bundle ref. The provider reads `clientId` directly
 * and resolves `clientSecret` per-request via `CredentialStore` (the
 * value is never inline in `workspace.json`).
 */
export interface OAuthClientConfig {
  /** OAuth `client_id` from the vendor's developer portal. */
  clientId: string;
  /**
   * Reference to the client secret in the workspace credential store.
   * Configured in the web UI (the workspace's Connections settings).
   * Omit for public PKCE-only clients (rare for pre-registered).
   */
  clientSecret?: { ref: "credential"; key: string };
  /**
   * Token endpoint auth method. Defaults to "none" (PKCE-only public
   * client) when `clientSecret` is absent; "client_secret_post" is the
   * common case when a secret is present. "client_secret_basic" is
   * supported for vendors that mandate it.
   */
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
}

/** Bundle lifecycle states. */
export type BundleState =
  | "starting"
  | "running"
  | "crashed"
  | "dead"
  | "stopped"
  /**
   * URL bundle is installed but no tokens exist for this principal. Initial
   * state for a freshly-installed URL bundle, and the resting state after
   * `disconnect`. UI shows "Connect" — clicking initiates the OAuth flow
   * (transitioning to `pending_auth`).
   */
  | "not_authenticated"
  /**
   * URL bundle is actively in an OAuth flow. The user (or agent) clicked
   * Connect; we've captured an authorization URL and are awaiting the
   * browser callback. Tools are unavailable until the callback completes
   * (transitions to `running`) or fails (transitions to `dead`).
   */
  | "pending_auth"
  /**
   * URL bundle was previously `running` but its refresh token failed (rotated,
   * revoked, or AS rejected). Tools that need this connection will fail until
   * the user reconnects. UI shows "Reconnect" — clicking initiates a fresh
   * OAuth flow (transitioning to `pending_auth`).
   *
   * Distinct from `not_authenticated` so the UI can surface a stronger
   * affordance ("your previously-working connection broke") and from
   * `dead` so the UI knows reconnection is the recovery path.
   */
  | "reauth_required";

/** MCP server config — how to spawn the process. */
export interface McpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * MCPB manifest.json — supports v0.3 and v0.4 formats.
 *
 * Both versions nest mcp_config under `server`:
 *   { "server": { "type": "python", "mcp_config": { "command": "python", ... } } }
 *
 * See: https://github.com/modelcontextprotocol/mcpb/tree/main/schemas
 */
export interface BundleManifest {
  manifest_version?: string;
  name: string;
  version: string;
  description?: string;
  author?: { name: string; email?: string; url?: string };
  server: {
    type: "python" | "node" | "binary" | "uv";
    entry_point?: string;
    mcp_config: McpConfig;
  };
  /** Per-bundle credential schema. Fields are resolved at startup against the
   *  workspace credential store and `mcp_config.env` env aliases — see
   *  `resolveUserConfig` and `substituteUserConfigFromEnv` in `startup.ts`. */
  user_config?: Record<string, UserConfigFieldDef>;
  _meta?: Record<string, unknown>;
}

/** Host manifest metadata at _meta["ai.nimblebrain/host"]. */
export interface HostManifestMeta {
  host_version: "1.0" | "1.1";
  name?: string;
  icon?: string;
  /**
   * RESERVED — not consumed by the host (grouping/briefing prioritization is
   * not wired to it). Tolerated for back-compat; slated for removal (nimblebrain#503).
   */
  category?: string;
  placements?: PlacementDeclaration[];
  primaryView?: { resourceUri: string };
  briefing?: BriefingBlock;
  /**
   * NimbleBrain host capabilities this bundle requires or prefers. Keys are
   * vendor-namespaced extension keys (e.g. `"ai.nimblebrain/host-resources"`)
   * matching the platform's `ClientCapabilities.extensions` advertisement.
   * Each value declares the bundle's requirements for that capability.
   *
   * Entries with `required: true` cause install to fail if the platform
   * does not advertise the capability. Entries with `required: false` (or
   * omitted) are prefers-but-adapts — bundles use the SDK's availability
   * check at runtime and fall back gracefully (e.g. structured tool error
   * teaching the agent to retry with inline content).
   *
   * Presence of this field requires `host_version: "1.1"` (enforced by
   * the JSON Schema's `if/then`).
   */
  host_capabilities?: Record<string, HostCapabilityRequirement>;
}

/** Bundle's requirement against one NimbleBrain host capability. */
export interface HostCapabilityRequirement {
  /**
   * When true, the platform must advertise this capability in
   * ClientCapabilities.extensions or install is refused. Default: false.
   */
  required?: boolean;
}

/** Briefing declaration — how this app contributes to the daily briefing. */
export interface BriefingBlock {
  priority?: "high" | "medium" | "low";
  facets: BriefingFacet[];
}

/** A single briefing facet — one dimension of summary data.
 *  Resolved via one of: entity (disk query), resource (MCP resource read), or tool (MCP tool call). */
export interface BriefingFacet {
  name: string;
  label: string;
  type: "attention" | "upcoming" | "activity" | "delta" | "kpi";
  entity?: string;
  resource?: string;
  tool?: string;
  tool_input?: Record<string, unknown>;
  query?: Record<string, unknown>;
  metric?: "count" | "sum" | "list";
  field?: string;
  highlight?: string;
  description?: string;
}

/** Runtime tracking for an installed bundle. One per source. */
export interface BundleInstance {
  /** Short server name (e.g. "ipinfo"). Used as the ToolRegistry source key. */
  serverName: string;
  /** Scoped manifest name (e.g. "@nimblebraininc/ipinfo"). Used for identity/display. */
  bundleName: string;
  /** The config key used to find this bundle in nimblebrain.json (name, path, or url value). */
  configKey?: string;
  /**
   * How this bundle was installed. Distinguishes registry bundles (which can be
   * version-checked / upgraded against mpak) from local dev copies and remote
   * URL connectors. `check_updates` / `upgrade` apply only to `"registry"`.
   */
  installSource?: "registry" | "local" | "remote";
  /** Version from manifest. */
  version: string;
  /** Human-readable description from the manifest. */
  description?: string;
  /** Current lifecycle state. */
  state: BundleState;
  /** MTF trust score from mpak (0-100), or null if unavailable. */
  trustScore: number | null;
  /** UI placement metadata from _meta["ai.nimblebrain/host"]. */
  ui: BundleUiMeta | null;
  /** Briefing metadata from _meta["ai.nimblebrain/host"].briefing. */
  briefing: BriefingBlock | null;
  /** Whether this is an Upjack app or plain MCP server. */
  type: "upjack" | "plain";
  /**
   * Workspace that owns this instance. Required — every bundle instance
   * belongs to exactly one workspace. Global/platform sources are
   * in-process MCP servers (`defineInProcessApp`), not BundleInstance,
   * so they never reach this type.
   */
  wsId: string;
  /** Absolute path to the entity data root (e.g., {wsDir}/data/{bundle}/apps/crm/data). Resolved at startup. */
  entityDataRoot?: string;
  /**
   * OAuth identity scope for URL bundles. `"workspace"` is the only legal
   * value — one shared identity per `(workspace, server)`. Personal
   * connectors are workspace-scoped to the user's personal workspace
   * (`personalWorkspaceIdFor(userId)`). Undefined for non-URL bundles.
   */
  oauthScope?: "workspace";
  /**
   * Per-principal Connections for URL bundles. Each entry is one
   * (bundle, principal) tuple owning an McpSource and its OAuth state
   * machine. For workspace-scoped bundles this map has exactly one entry
   * keyed `WORKSPACE_PRINCIPAL_ID` ("_workspace"); for member-scoped
   * (Step 3) it lazily grows with one entry per active member.
   *
   * `state` above is a derived summary of these — see
   * `summarizeConnectionState` in `connection.ts` and the rules
   * documented there. Updated by lifecycle on every connection transition.
   *
   * Empty / undefined for non-URL bundles (stdio, in-process); they never
   * speak OAuth.
   */
  connections?: Map<string, Connection>;
  /**
   * Original `BundleRef` for URL bundles, retained on the instance so
   * lifecycle can reconstruct sources on-demand. Carries the URL,
   * transport config, oauthClient and scopes. Undefined for non-URL
   * bundles — named/local bundles don't need to spawn additional
   * sources after boot.
   */
  ref?: BundleRef;
}

/** Metadata extracted from a local bundle's manifest during startup. */
export interface LocalBundleMeta {
  /** Scoped manifest name (e.g., "@nimblebraininc/hello"). */
  manifestName?: string;
  version: string;
  /** Human-readable description from manifest. */
  description?: string;
  ui: BundleUiMeta | null;
  briefing: BriefingBlock | null;
  type: "upjack" | "plain";
  /** Upjack namespace from manifest (e.g., "apps/crm"). */
  upjackNamespace?: string;
}

/** Result from starting a bundle source — includes the actual registered source name. */
export interface StartBundleResult {
  meta: LocalBundleMeta | null;
  /** The actual source name registered in the ToolRegistry. */
  sourceName: string;
  /**
   * Raw bundle manifest, populated when one was read during startup
   * (local-path and named-registry bundles). Null for remote bundles, where
   * the platform discovers tools over the wire and has no local manifest.
   * Lifecycle callers use this instead of re-reading the manifest, so there
   * is one source of truth for bundle metadata per startup.
   */
  manifest: BundleManifest | null;
}

/** App info returned by GET /v1/apps. */
export interface AppInfo {
  name: string;
  bundleName: string;
  version: string;
  status: BundleState;
  type: "upjack" | "plain";
  toolCount: number;
  trustScore: number;
  ui: BundleUiMeta | null;
}
