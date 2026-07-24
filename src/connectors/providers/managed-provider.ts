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
 * `composio` and `provider` are the brokered kinds a `ManagedConnectorProvider`
 * can own. Kept in lockstep with the inline union on the catalog projection
 * (`registries/projection.ts`) — one string per kind.
 */
export type ConnectorAuthKind = "dcr" | "static" | "composio" | "provider";

/** A hosted MCP session minted by a provider: the remote MCP target the runtime connects to. */
export interface ManagedSession {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

/** Options for `createSession`. Per-connector + owner-derived; the broker credential is the provider's own. */
export interface CreateManagedSessionOptions {
  /** Owner-namespaced identity the provider keys the session on (see `userId`). */
  userId: string;
  /** The provider-side toolkit / server slug the session exposes. */
  toolkit: string;
  /** The provider-side auth-config id the session binds. */
  authConfigId: string;
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
  /** Stable id — the `auth-kind` this provider owns. `"composio"` today. */
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
