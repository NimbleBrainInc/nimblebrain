/**
 * The connector registry layer surfaces installable connectors from a
 * configurable set of sources (curated YAML, a future upstream MCP
 * registry, etc.) through one facade — `ConnectorDirectory`. Clients
 * never construct sources or aggregate them by hand; they ask the
 * directory for `list()`, `catalogByUrl()`, `catalogById()`, etc.,
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
 * `RegistryConfig` rows — e.g. two curated catalogs at different paths —
 * because each row gets its own `ConnectorSource` instance.
 *
 * Seeded default (see `RegistryStore`):
 *
 *   - `static`  — bundled curated catalog of remote OAuth services
 *     (Granola, Notion, HubSpot, etc.) shipped with the platform.
 *     Locked. Operator overrides via `NB_REGISTRIES` JSON.
 */

import type { ConnectorAuthKind } from "../connectors/auth-kind.ts";
import type {
  ComposioConnectorConfig,
  ServerDetail,
  SmitheryConnectorConfig,
} from "../connectors/server-detail.ts";
import type { CredentialRef } from "../tools/credential-ref.ts";

/**
 * Registry kind, keyed into the directory's source-factory map. Open on
 * purpose: a build that does not carry a source for some type surfaces no
 * entries from that registry rather than failing to compile against a closed
 * enum, so adding the upstream MCP registry source is one factory entry and
 * one file.
 */
export type RegistryType = string;

/** Persistable configuration for a registry. Stored in `registries.json`. */
export interface RegistryConfig {
  id: string;
  name: string;
  type: RegistryType;
  enabled: boolean;
  /**
   * For `static`: filesystem path to the directory of YAML/JSON
   * `ServerDetail` files. For an HTTP-backed source: the registry base URL.
   */
  url?: string;
  /**
   * Restrict this registry's surfaced entries to one or more
   * namespaces. Match is OR-of-prefixes against either:
   *
   *   - `ServerDetail.name` reverse-DNS prefix (e.g. `ai.nimblebrain`
   *     matches `ai.nimblebrain/echo`), OR
   *   - the npm scope of any `packages[].identifier` (e.g.
   *     `acme` matches `@acme/echo`).
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
   * Offered for personal (identity-plane) connection — the curated set the
   * profile's Connectors page presents. Set from the connector's
   * `_meta.ai.nimblebrain/connector.personal`; the hard gate is still DCR auth
   * (`list_personal_catalog` filters `install.auth === "dcr"`).
   */
  personal?: boolean;
  install: InstallAction;
  /**
   * For static-auth entries: whether the workspace has operator OAuth
   * app credentials configured (both clientId in workspace.json and
   * client_secret in the credential store). DCR / direct-url entries
   * leave this undefined — operator setup doesn't apply.
   *
   * Browse uses this to flip the row affordance:
   *   - undefined or true  → "Install" button
   *   - false              → "Set up" (admin only) / "Operator setup
   *     required" (non-admin)
   */
  operatorConfigured?: boolean;
}

/** How to install an entry — varies by source type. */
export type InstallAction = RemoteOAuthInstall | DirectUrlInstall;

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
  /**
   * Runtime-native kind, or the id of the brokered provider that owns this
   * connector. See `NimbleBrainConnectorMeta.auth`.
   */
  auth: ConnectorAuthKind;
  requiredScopes?: string[];
  additionalAuthorizationParams?: Record<string, string>;
  operatorSetup?: { portalUrl: string; hint: string; clientSecretKey: string };
  /**
   * A brokered entry's provider config block, carried under the key naming its
   * provider. The install path reads whichever block `auth` names via
   * `brokeredCatalogConfig` and hands it to that provider verbatim; these two
   * typed fields document the shapes we ship rather than enumerating what is
   * accepted.
   */
  composio?: ComposioConnectorConfig;
  smithery?: SmitheryConnectorConfig;
  /**
   * Required for `auth: "provider"`. Names the credential provider and its
   * opaque config (e.g. `{ provider: "minted", config: { audience, scope } }`).
   * Operator-authored in the catalog — the install path copies it verbatim into
   * the BundleRef's `transport.auth`, NEVER taking provider/config from tenant
   * input. That is what keeps a self-installable platform connector safe.
   */
  providerAuth?: { provider: string; config: Record<string, unknown> };
  /**
   * Workspace-owned secrets bound to outgoing headers, as credential references
   * (see `NimbleBrainConnectorMeta.secretHeaders`). Operator-authored in the
   * catalog and re-read from the trusted entry at install, then copied verbatim
   * into the BundleRef's `transport.headers` — a caller-supplied value is
   * discarded, because a forged header name would let a workspace admin decide
   * what a fleet-trusted connection sends.
   */
  secretHeaders?: Record<string, CredentialRef>;
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
 * Implementations: `StaticSource`. Future: an upstream-MCP-registry
 * source, `DirectUrlSource`.
 */
export interface ConnectorSource {
  /** Stable id from the source's `RegistryConfig` — used in error tags. */
  readonly id: string;
  /** Backend-specific fetch. May throw on transport / parse errors. */
  fetch(): Promise<ServerDetail[]>;
}
