/**
 * A connector registry is a *source of installable connectors*. The
 * platform aggregates entries from every enabled registry into a
 * single browse experience — the user picks something to install,
 * and the install action dispatches by entry type.
 *
 * Registries are configured at the instance level (Settings → Org →
 * Registries). The two seeded defaults are:
 *
 *   - "curated"  — the hardcoded NimbleBrain catalog of remote OAuth
 *     services (Granola, Notion, HubSpot, etc.). Always on, locked.
 *   - "mpak"     — mpak.dev open MCP bundle registry. Default on; the
 *     org admin can disable or point at a different mpak instance.
 *
 * Future registry types (planned, not implemented):
 *   - "directory"  — JSON catalog mounted by an operator (per-org
 *     curated list for SOC2-conscious tenants).
 *   - "custom-url" — paste-a-URL flow for any remote MCP server
 *     (advanced; bypasses curation).
 */

/** Stable registry kind, used for source-type-driven dispatch. */
export type RegistryType = "curated" | "mpak" | "directory" | "custom-url";

/** Persistable configuration for a registry. Stored in registries.json. */
export interface RegistryConfig {
  id: string;
  name: string;
  type: RegistryType;
  enabled: boolean;
  /** For type === "mpak" or "directory": the registry endpoint or path. */
  url?: string;
  /**
   * Locked registries can't be disabled or removed by the admin UI —
   * the curated registry is locked because it ships with the platform
   * and removing it would leave first-time users with nothing.
   */
  locked?: boolean;
}

/**
 * One row in the Browse directory. The shape is uniform across
 * registry types so the UI doesn't have to special-case rendering;
 * the install dispatch happens via the `install` discriminated
 * union.
 */
export interface DirectoryEntry {
  /** Unique within (registryId, id) — registries can repeat ids. */
  id: string;
  registryId: string;
  registryType: RegistryType;
  name: string;
  description: string;
  iconUrl?: string;
  tags?: string[];
  /** Recommended scope. UI uses this to filter Personal vs Workspace browse. */
  defaultScope: "user" | "workspace";
  install: InstallAction;
  /**
   * For static-auth entries: whether the workspace has operator OAuth
   * app credentials configured (both clientId in workspace.json and
   * client_secret in the credential store). DCR / mpak / direct-url
   * entries leave this undefined — operator setup doesn't apply.
   *
   * Browse uses this to flip the row affordance:
   *   - undefined or true  → "Install" button
   *   - false              → "Set up" (admin only) / "Operator setup
   *     required" (non-admin)
   */
  operatorConfigured?: boolean;
}

/** How to install an entry — varies by source type. */
export type InstallAction = RemoteOAuthInstall | MpakBundleInstall | DirectUrlInstall;

/**
 * Curated remote OAuth service. The existing connector catalog flow:
 * lifecycle.install adds the URL bundle to workspace.json, then
 * /v1/mcp-auth/initiate kicks off the OAuth round-trip.
 */
export interface RemoteOAuthInstall {
  kind: "remote-oauth";
  url: string;
  auth: "dcr" | "static";
  requiredScopes?: string[];
  additionalAuthorizationParams?: Record<string, string>;
  operatorSetup?: { portalUrl: string; hint: string; clientSecretKey: string };
}

/**
 * mpak bundle install. The package is fetched via mpak SDK and
 * spawned as a stdio subprocess. CuratedRegistry emits these from
 * the bundled stdio-catalog.yaml; future MpakRegistry implementations
 * will emit them from mpak.dev's search results.
 *
 * TODO(mpak-registry): when the live mpak.dev fetch lands, this type
 * needs `version` (selected release) and `mpakUrl` (download href)
 * back. Both fields existed in an earlier draft and were trimmed
 * because CuratedRegistry doesn't need them — but the discriminated
 * union has to widen again before MpakRegistry can do useful work.
 */
export interface MpakBundleInstall {
  kind: "mpak-bundle";
  /** Scoped package name, e.g., "@nimblebraininc/echo". */
  package: string;
}

/**
 * User pasted a remote MCP server URL directly. Future. Reserved here
 * so the discriminated union is closed.
 */
export interface DirectUrlInstall {
  kind: "direct-url";
  url: string;
}

/**
 * Per-call context handed to a registry's `listEntries`. Carries the
 * pieces a registry might need to compute workspace-aware fields
 * (e.g. `operatorConfigured` on curated entries) without coupling the
 * registry to the runtime singleton.
 *
 * Optional today — registries that don't need it (mpak stub) can
 * ignore it. As more registries gain workspace-aware computation
 * this becomes the seam for threading whatever they need.
 */
export interface ListEntriesContext {
  /** The workspace whose state determines workspace-aware fields. */
  wsId?: string;
  /**
   * Async lookup: does the workspace have valid operator OAuth app
   * config (both clientId + client_secret) for this catalog id?
   * Returns false if either piece is missing. Returns null if the
   * caller didn't supply this resolver — registries treat that as
   * "I can't compute this; leave the field undefined."
   */
  isOperatorConfigured?: (catalogId: string, clientSecretKey: string) => Promise<boolean>;
}

/** A registry implementation. */
export interface ConnectorRegistry {
  readonly config: RegistryConfig;
  /** List entries this registry currently surfaces. May hit the network. */
  listEntries(ctx?: ListEntriesContext): Promise<DirectoryEntry[]>;
}
