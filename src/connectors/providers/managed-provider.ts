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
import type { BrokeredRef } from "../../bundles/types.ts";
import type { ConnectorOwner } from "../../identity/connector-owner.ts";
import type { ConnectorDirectory } from "../../registries/directory.ts";

/**
 * The auth-kind taxonomy, re-exported so the seam and its taxonomy read as one
 * thing at the import site. Defined in `../auth-kind.ts`, which imports nothing.
 */
export {
  type ConnectorAuthKind,
  isBrokeredAuthKind,
  isRuntimeNativeAuthKind,
  RUNTIME_NATIVE_AUTH_KINDS,
  type RuntimeNativeAuthKind,
} from "../auth-kind.ts";

/** A hosted MCP session minted by a provider: the remote MCP target the runtime connects to. */
export interface ManagedSession {
  type: "http" | "sse";
  url: string;
  /**
   * Extra request headers the runtime persists on the ref's transport, verbatim.
   *
   * **A provider MUST NOT return a header carrying its broker credential** — not
   * the credential header itself, and not a copy of the value inlined under
   * another name. The runtime writes these into `workspace.json` as-is and
   * cannot check the rule for you: which header holds the secret, and what the
   * secret is, are the provider's own details. The credential's one channel is
   * `credentialProvider` below, which attaches it at transport-build time so
   * neither the value nor the name of the variable holding it is ever at rest.
   *
   * Scrubbing belongs in the provider, at the boundary where the vendor's
   * response is first read (Composio's `createSession` does it; Smithery returns
   * no headers at all).
   */
  headers?: Record<string, string>;
  /**
   * Opaque provider-scoped coordinates identifying the thing just minted. The
   * runtime persists them verbatim at `BundleRef.brokered.providerRef` and
   * hands them back to this provider's probe and teardown.
   *
   * **Opaque end to end.** The install path validates nothing in here and the
   * kernel reads no key from it; only the provider that returned it does. That
   * is what lets a provider be a folder plus a registry line — there is no
   * per-vendor ref block to declare and no per-vendor wiring builder to write.
   *
   * Exists because a broker's session is a *stateful object on its side*, not
   * just a URL: liveness and teardown need to name it later. Without this the
   * only channel back is `url`, which forces the tool layer to parse the
   * provider's own id format out of a path — a silent-failure hazard and a
   * duplicate of a formula the provider had in hand.
   *
   * A provider that needs a coordinate MUST return it here and fail
   * `createSession` if it cannot: a session persisted without one is a
   * connector the probe and uninstall can never address.
   */
  providerRef?: Record<string, string>;
  /**
   * The registered transport-credential provider that attaches this session's
   * broker credential at transport-build time (see
   * `src/connectors/gateways/transport-credential.ts`). The runtime writes it
   * to the persisted `transport.auth` as `{ type: "provider", provider }`, so
   * neither the secret nor the name of the environment variable holding it is
   * ever at rest in `workspace.json`.
   *
   * Omit only for a session that needs no credential attached.
   */
  credentialProvider?: string;
}

/**
 * Options for `createSession`. Owner-derived identity plus the connector's own
 * catalog block; the broker credential is the provider's own detail.
 */
export interface CreateManagedSessionOptions {
  /** Owner-namespaced identity the provider keys the session on (see `userId`). */
  userId: string;
  /** The catalog entry id being installed. Provider-neutral; for messages and its own records. */
  connectorId: string;
  /**
   * The connector's provider-specific catalog block, verbatim and **opaque to
   * the kernel** — the operator-authored config the catalog carries under the
   * key naming this provider (`composio:`, `smithery:`, …). The provider reads
   * its own fields out of it and validates them at its own boundary.
   *
   * This is the noun half of the seam. Threading a kernel-typed `toolkit` /
   * `authConfigId` / `tools` triple instead meant every provider's coordinates
   * had to be expressible in Composio's vocabulary, and a provider whose
   * coordinates were not (Smithery's `(namespace, connectionId)`) had to smuggle
   * them through a field named for something else.
   */
  config: Record<string, unknown>;
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
  /** Whose connection this is. The provider derives its own namespaced id from it. */
  owner: ConnectorOwner;
  /** The runtime's resolved work directory — where the provider records the result. */
  workDir: string;
  /** The catalog entry id being connected. */
  connectorId: string;
  /** The connector's provider-specific catalog block, verbatim and opaque to the kernel. */
  config: Record<string, unknown>;
  /**
   * Raw field values submitted by the connecting user, unvalidated. The
   * provider checks them against what its own catalog block declares — the
   * declaration is the provider's schema, so the kernel cannot enforce it.
   * Handed to the broker and NEVER persisted by the platform.
   */
  fields: Record<string, string>;
}

/** Options for `findActive`. */
export interface FindActiveManagedConnectionOptions {
  userId: string;
  authConfigId: string;
}

/**
 * What `cleanup` and `hasConnection` are asked about: one owner's install of
 * one brokered connector.
 *
 * `workDir` is passed rather than resolved inside the provider so a provider
 * reads the SAME root the install and the OAuth callback wrote under — they
 * diverge exactly when an operator sets `workDir` in `nimblebrain.json` without
 * `NB_WORK_DIR`, and a provider resolving its own would probe the wrong root
 * and report every connector unconnected at boot.
 */
export interface BrokeredStateOptions {
  /** Whose install this is — a workspace, or a user's personal connector. */
  owner: ConnectorOwner;
  /** The brokered coordinates from the install ref. */
  brokered: BrokeredRef;
  /** The runtime's resolved work directory. */
  workDir: string;
}

/** What `cleanup` managed to tear down. Best-effort by contract — never throws. */
export interface BrokeredCleanupResult {
  /** The brokered connection (and any upstream grant it held) was deleted at the provider. */
  upstreamDeleted: boolean;
  /** Provider-owned local state under `credentials/<provider>/<connectorId>/` was removed. */
  localDeleted: boolean;
  /** First error encountered, reported rather than thrown. */
  lastError?: string;
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
  /**
   * Stable id — the brokered `auth` kind this provider owns (`"composio"`,
   * `"smithery"`). It is the value a catalog entry's `auth` names, the key its
   * catalog config block sits under, the `provider` stamped on the install ref,
   * and the directory segment its local state lives in. It must not collide
   * with a runtime-native kind.
   */
  readonly id: string;

  /** Owner-namespace derivation (vendor-free; no SDK load). */
  userId(owner: ConnectorOwner): string;

  /** Mint a hosted MCP session — the one method every brokered provider must implement. */
  createSession(opts: CreateManagedSessionOptions): Promise<ManagedSession>;

  /** Begin an OAuth connection: returns the URL to navigate to + the account id to persist. */
  initiate?(
    opts: InitiateManagedConnectionOptions,
  ): Promise<{ redirectUrl: string; connectedAccountId: string }>;

  /**
   * Connect a non-redirect (API-key) auth config, verify it reaches a usable
   * state, and record the connection as this provider records one.
   *
   * Two failure channels, deliberately. A returned `{ error }` is a caller- or
   * operator-facing message that is SAFE TO SURFACE VERBATIM (a required field
   * missing, an unknown field, a connector whose scheme is not API-key, missing
   * operator config). A **thrown** error is a broker failure the caller must
   * genericize, so a rejected credential never echoes back what was submitted.
   */
  connectApiKey?(
    opts: ConnectManagedApiKeyOptions,
  ): Promise<{ status: string } | { error: string }>;

  /** Find an already-active connection for this owner + auth config, if any. */
  findActive?(
    opts: FindActiveManagedConnectionOptions,
  ): Promise<{ id: string; status: string } | null>;

  /** Delete a connection by its id. Best-effort; never throws. */
  delete?(connectedAccountId: string): Promise<boolean>;

  /**
   * Tear down one owner's brokered install: revoke the connection (and any
   * upstream grant the broker holds) and drop the provider's own local state.
   *
   * MUST NOT throw — a broker that is down or unconfigured must not sink an
   * uninstall. Report what happened in the result instead.
   *
   * The kernel removes `credentials/<provider>/<connectorId>/` itself afterwards
   * as defense-in-depth, so a provider that keeps nothing locally implements
   * only the revoke half and reports `localDeleted: false`.
   *
   * Omit entirely when the provider has nothing to tear down.
   */
  cleanup?(opts: BrokeredStateOptions): Promise<BrokeredCleanupResult>;

  /**
   * Whether this owner has actually completed a connection for this connector —
   * the signal boot-state derivation needs to tell a connector that is merely
   * installed (`not_authenticated`, "Connect") from one that is ready to start.
   *
   * SYNCHRONOUS and local by contract: it runs once per installed connector on
   * the boot path, so it reads disk state the provider already wrote, never the
   * broker's API. A provider whose connectors carry their credential from the
   * moment they are installed (nothing to connect per-user) omits this, and the
   * kernel falls back to the generic static-auth / persisted-token check.
   */
  hasConnection?(opts: BrokeredStateOptions): boolean;

  /** A liveness probe for the connection revalidator, wired iff the provider supplies one. */
  probe?(directory: ConnectorDirectory): ConnectionHealthProbe;

  /** The provider's HTTP callback surface, mounted iff the provider supplies it. */
  routes?(ctx: AppContext): Hono<AppEnv>;
}
