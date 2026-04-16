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
    | { type: "none" };
  headers?: Record<string, string>;
  reconnection?: {
    maxReconnectionDelay?: number;
    initialReconnectionDelay?: number;
    maxRetries?: number;
  };
  sessionId?: string;
}

/** Reference to a bundle — by name (mpak cache), local path, or remote URL. */
export type BundleRef =
  | {
      name: string;
      /**
       * Pin to a specific registry version (e.g., "0.2.0"). When omitted, the
       * mpak SDK resolves the latest published version at startup — which
       * breaks reproducible deployments and rollback. Set this to lock the
       * version in nimblebrain.json / workspace config.
       */
      version?: string;
      env?: Record<string, string>;
      allowedEnv?: string[];
      protected?: boolean;
      trustScore?: number | null;
      ui?: BundleUiMeta | null;
    }
  | {
      path: string;
      env?: Record<string, string>;
      allowedEnv?: string[];
      protected?: boolean;
      trustScore?: number | null;
      ui?: BundleUiMeta | null;
    }
  | {
      url: string;
      serverName?: string;
      transport?: RemoteTransportConfig;
      protected?: boolean;
      trustScore?: number | null;
      ui?: BundleUiMeta | null;
    };

/** Bundle lifecycle states. */
export type BundleState = "starting" | "running" | "crashed" | "dead" | "stopped";

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
  _meta?: Record<string, unknown>;
}

/** Host manifest metadata at _meta["ai.nimblebrain/host"]. */
export interface HostManifestMeta {
  host_version: "1.0";
  name?: string;
  icon?: string;
  category?: string;
  placements?: PlacementDeclaration[];
  primaryView?: { resourceUri: string };
  settings?: {
    id: string;
    label: string;
    icon: string;
    resourceUri: string;
  };
  briefing?: BriefingBlock;
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
  /** Whether the bundle is protected from uninstall. */
  protected: boolean;
  /** Whether this is an Upjack app or plain MCP server. */
  type: "upjack" | "plain";
  /** Workspace ID this instance belongs to (undefined = global/protected). */
  wsId?: string;
  /** Absolute path to the entity data root (e.g., {wsDir}/data/{bundle}/apps/crm/data). Resolved at startup. */
  entityDataRoot?: string;
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

/** Env vars injected into protected default bundles for internal host communication. */
export interface InternalBundleEnv {
  NB_INTERNAL_TOKEN: string;
  NB_HOST_URL: string;
}

/** Result from starting a bundle source — includes the actual registered source name. */
export interface StartBundleResult {
  meta: LocalBundleMeta | null;
  /** The actual source name registered in the ToolRegistry. */
  sourceName: string;
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
