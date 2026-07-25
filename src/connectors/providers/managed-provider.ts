/**
 * The `ManagedConnectorProvider` seam.
 *
 * A managed-connector provider is a third party that **brokers auth**
 * (OAuth / API-key) *and* returns a **hosted MCP session** on a tenant's
 * behalf. The runtime builds a registry of these from instance config at
 * startup and dispatches all connector-auth, liveness, session, and route
 * wiring through it, so a vendor (Composio is the first) stops being a pile of
 * hardwired modules and becomes one registered implementation.
 *
 * The seam is deliberately narrow:
 *
 *   - It is for **brokered** providers only. `dcr` and `static` stay
 *     runtime-native (the runtime is the OAuth client, tokens live in our own
 *     credential store, no vendor SDK) and are NOT folded in here — that would
 *     dilute this into a god-abstraction. The unifying taxonomy remains the
 *     connector `auth-kind` enum; this registry is the *brokered subset* of it.
 *   - It covers the **auth-and-session broker role only — never tool
 *     invocation.** MCP already owns invocation; a provider that shadowed it
 *     would be the anti-pattern.
 *
 * Vendor-neutral by construction: every method takes and returns plain shapes
 * (`{ url, headers, type }`, `{ redirectUrl, connectedAccountId }`) plus the
 * vendor-free `ConnectorOwner`. No vendor SDK type crosses this boundary, and
 * the platform-side broker credential (e.g. a `COMPOSIO_API_KEY`) is the
 * provider's own detail — it is resolved inside the impl, never threaded
 * through these opts.
 */

import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../../api/types.ts";
import type { ConnectionHealthProbe } from "../../bundles/connection-probe.ts";
import type { ConnectorOwner } from "../../identity/connector-owner.ts";
import type { ConnectorDirectory } from "../../registries/directory.ts";

/**
 * The connector auth-kind taxonomy. `dcr` and `static` are runtime-native;
 * `composio`, `smithery`, and `provider` are the brokered kinds a
 * `ManagedConnectorProvider` can own. Kept in lockstep with the inline union on
 * the catalog projection (`registries/projection.ts`) — one string per kind.
 */
export type ConnectorAuthKind = "dcr" | "static" | "composio" | "smithery" | "provider";

/** A hosted MCP session minted by a provider: the remote MCP target the runtime connects to. */
export interface ManagedSession {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * Opaque provider-scoped coordinates identifying the thing just minted, for
   * the runtime to persist on the install ref and hand back to this provider's
   * probe and teardown. **Opaque to the seam, not to the runtime**: this
   * interface never reads a key, but the install path does — it validates the
   * fields its provider's ref block declares and lands them in a typed
   * `BundleRef.<provider>` shape. So a provider still needs its own typed ref
   * block and its own wiring builder; this carries the values, not the schema.
   * That is the same auth-kind taxonomy limit finding #6 records.
   *
   * Exists because a broker's session is a *stateful object on its side*, not
   * just a URL: liveness and teardown need to name it later. Without this the
   * only channel back is `url`, which forces the tool layer to parse the
   * provider's own id format out of a path — a silent-failure hazard and a
   * duplicate of a formula the provider had in hand.
   */
  providerRef?: Record<string, string>;
}

/** Options for `createSession`. Per-connector + owner-derived; the broker credential is the provider's own. */
export interface CreateManagedSessionOptions {
  /** Owner-namespaced identity the provider keys the session on (see `userId`). */
  userId: string;
  /** The provider-side toolkit / server slug the session exposes. */
  toolkit: string;
  /**
   * The provider-side auth-config id the session binds.
   *
   * OPTIONAL, because it is an *auth-broker* coordinate, not a universal one: a
   * provider that identifies a connector purely by its server slug has no
   * auth-config concept at all. Composio requires it; Smithery keys a session by
   * `(namespace, connectionId)` against a registry qualified name and omits it.
   * Providers that need it validate its presence in their own impl.
   */
  authConfigId?: string;
  /** Optional allowlist of provider tool slugs; omit to expose the toolkit's full surface. */
  tools?: string[];
}

/** Options for `initiate` (OAuth broker arm). */
export interface InitiateManagedConnectionOptions {
  userId: string;
  authConfigId: string;
  /** The runtime callback URL the vendor returns the browser to. */
  callbackUrl: string;
}

/** Options for `connectApiKey` (non-redirect / API-key broker arm). */
export interface ConnectManagedApiKeyOptions {
  userId: string;
  authConfigId: string;
  /** The connector's declared credential fields (e.g. api_key, subdomain). Never persisted by the platform. */
  fields: Record<string, string>;
}

/** Options for `findActive`. */
export interface FindActiveManagedConnectionOptions {
  userId: string;
  authConfigId: string;
}

/**
 * A brokered managed-connector provider. `createSession` is the only method
 * every provider must implement — it is the session-hosting role that defines
 * the seam. The auth-brokering methods are optional: a provider that only hosts
 * config-authed sessions implements none of them; one that does OAuth
 * implements `initiate`; one that takes an API key implements `connectApiKey`.
 * `probe` and `routes` are optional runtime contributions, wired only when the
 * provider supplies them.
 */
export interface ManagedConnectorProvider {
  /** Stable id — the `auth-kind` this provider owns (`"composio"`, `"smithery"`). */
  readonly id: ConnectorAuthKind;

  /** Owner-namespace derivation (vendor-free; no SDK load). */
  userId(owner: ConnectorOwner): string;

  /** Mint a hosted MCP session — the one method every brokered provider must implement. */
  createSession(opts: CreateManagedSessionOptions): Promise<ManagedSession>;

  /** Begin an OAuth connection: returns the URL to navigate to + the account id to persist. */
  initiate?(
    opts: InitiateManagedConnectionOptions,
  ): Promise<{ redirectUrl: string; connectedAccountId: string }>;

  /** Connect a non-redirect (API-key) auth config and verify it reaches a usable state. */
  connectApiKey?(
    opts: ConnectManagedApiKeyOptions,
  ): Promise<{ connectedAccountId: string; status: string }>;

  /** Find an already-active connection for this owner + auth config, if any. */
  findActive?(
    opts: FindActiveManagedConnectionOptions,
  ): Promise<{ id: string; status: string } | null>;

  /** Delete a connection by its id. Best-effort; never throws. */
  delete?(connectedAccountId: string): Promise<boolean>;

  /** A liveness probe for the connection revalidator, wired iff the provider supplies one. */
  probe?(directory: ConnectorDirectory): ConnectionHealthProbe;

  /** The provider's HTTP callback surface, mounted iff the provider supplies it. */
  routes?(ctx: AppContext): Hono<AppEnv>;
}
