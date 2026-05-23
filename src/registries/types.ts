/**
 * The connector registry layer surfaces installable connectors from a
 * configurable set of sources (curated YAML, mpak.dev, future MCP
 * registry, etc.) through one facade — `ConnectorDirectory`. Clients
 * never construct sources or aggregate them by hand; they ask the
 * directory for `list()`, `catalogByUrl()`, `iconByPackage()`, etc.,
 * and uniform behavior (scope filtering, error aggregation,
 * projection, dedup) lives in one place.
 *
 * Source contracts are deliberately narrow: a `ConnectorSource` does
 * one thing — `fetch()` returns the raw upstream `ServerDetail[]` for
 * its instance. Caching is the source's private business; filtering,
 * projection, and lookup tables live in the directory.
 *
 * Configuration drives which sources are loaded. Operators can
 * configure multiple instances of the same source type with different
 * `RegistryConfig` rows — e.g. one mpak instance scoped to
 * `nimblebraininc/*` plus another pointing at a self-hosted mpak —
 * because each row gets its own `ConnectorSource` instance.
 *
 * Seeded defaults (see `RegistryStore`):
 *
 *   - `static`  — bundled curated catalog of remote OAuth services
 *     (Granola, Notion, HubSpot, etc.) shipped with the platform.
 *     Locked. Operator overrides via `NB_REGISTRIES` JSON.
 *   - `mpak`    — the mpak.dev open MCP bundle registry. Default on;
 *     operator can disable, scope, or point at a self-hosted instance.
 *
 * Future registry types (planned, not implemented):
 *   - `mcp`        — upstream MCP registry (`/v1/servers/...`) once
 *     the upstream service stabilizes.
 *   - `custom-url` — paste-a-URL flow for any remote MCP server
 *     (advanced; bypasses curation).
 */

import type { ServerDetail } from "../connectors/server-detail.ts";

/** Stable registry kind, used for source-type-driven dispatch. */
export type RegistryType = "static" | "mpak" | "mcp" | "custom-url";

/** Persistable configuration for a registry. Stored in `registries.json`. */
export interface RegistryConfig {
  id: string;
  name: string;
  type: RegistryType;
  enabled: boolean;
  /**
   * For `static`: filesystem path to the YAML/JSON `ServerDetail[]`
   * file. For `mpak` / `mcp`: registry HTTP base URL when the operator
   * has overridden the SDK default; absent otherwise (the SDK owns its
   * own default).
   */
  url?: string;
  /**
   * Restrict this registry's surfaced entries to one or more
   * namespaces. Match is OR-of-prefixes against either:
   *
   *   - `ServerDetail.name` reverse-DNS prefix (e.g. `ai.nimblebrain`
   *     matches `ai.nimblebrain/echo`), OR
   *   - the npm scope of any `packages[].identifier` (e.g.
   *     `nimblebraininc` matches `@nimblebraininc/echo`).
   *
   * Either match is sufficient. Empty / undefined = no filter.
   * Applied uniformly by the facade across every source type.
   */
  scopes?: string[];
  /**
   * Locked registries can't be disabled or removed by the admin UI —
   * the bundled static registry is locked because it ships with the
   * platform and removing it would leave first-time users with nothing.
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
  /**
   * Stable identifier — the upstream `ServerDetail.name` (reverse-DNS
   * form). Unique within `(registryId, id)`; registries can repeat ids
   * across themselves.
   */
  id: string;
  registryId: string;
  registryType: RegistryType;
  name: string;
  description: string;
  iconUrl?: string;
  tags?: string[];
  /**
   * Default install target. UI uses this to filter Personal vs Workspace
   * browse. `"workspace"` installs into the active workspace; `"personal"`
   * installs into the caller's personal workspace.
   */
  defaultBinding: "personal" | "workspace";
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
  /**
   * Transport class the vendor advertises in `ServerDetail.remotes[].type`.
   * Threaded into the BundleRef's `transport.type` at install so
   * `createRemoteTransport` instantiates the right SDK client class.
   * Without this, every install defaults to `streamable-http` and SSE-
   * only servers (PayPal, Cloudflare Bindings, Webflow, Wix) would fail
   * the handshake.
   */
  transportType: "streamable-http" | "sse";
  auth: "dcr" | "static" | "composio";
  requiredScopes?: string[];
  additionalAuthorizationParams?: Record<string, string>;
  operatorSetup?: { portalUrl: string; hint: string; clientSecretKey: string };
  /**
   * Required for `auth: "composio"`. Names the Composio toolkit and
   * the env var holding the auth-config id. See
   * `NimbleBrainConnectorMeta.composio` for the canonical shape.
   */
  composio?: { toolkit: string; authConfigEnv: string; tools?: string[] };
}

/**
 * mpak bundle install. The package is fetched via mpak SDK and
 * spawned as a stdio subprocess. `MpakSource` emits these from
 * mpak.dev's search results; `StaticSource` may also emit them when
 * a curated `ServerDetail` declares a `packages[]` entry.
 */
export interface MpakBundleInstall {
  kind: "mpak-bundle";
  /** Scoped package name, e.g., `@nimblebraininc/echo`. */
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
 * Per-call context handed to `ConnectorDirectory.list`. Carries the
 * pieces a workspace-aware projection might need (e.g.
 * `operatorConfigured` on static entries) without coupling the
 * directory to the runtime singleton.
 */
export interface ListEntriesContext {
  /** The workspace whose state determines workspace-aware fields. */
  wsId?: string;
  /**
   * Async lookup: does the workspace have valid operator OAuth app
   * config (both clientId + client_secret) for this catalog id?
   * Returns false if either piece is missing. Returns null if the
   * caller didn't supply this resolver — the projection treats that
   * as "I can't compute this; leave the field undefined."
   */
  isOperatorConfigured?: (catalogId: string, clientSecretKey: string) => Promise<boolean>;
}

/**
 * A connector source. Narrowed to one method on purpose: returns the
 * raw upstream `ServerDetail[]` for this source's instance. Caching,
 * freshness strategy, and backend-specific quirks (HTTP vs file vs
 * SDK) are private to the implementation — the directory doesn't see
 * them. Filtering, projection, error aggregation, and lookup tables
 * are the directory's job, not the source's.
 *
 * Implementations: `StaticSource`, `MpakSource`. Future: `McpSource`,
 * `DirectUrlSource`.
 */
export interface ConnectorSource {
  /** Stable id from the source's `RegistryConfig` — used in error tags. */
  readonly id: string;
  /** Backend-specific fetch. May throw on transport / parse errors. */
  fetch(): Promise<ServerDetail[]>;
}
