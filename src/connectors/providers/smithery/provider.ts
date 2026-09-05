/**
 * `SmitheryProvider` — Smithery as a registered `ManagedConnectorProvider`.
 *
 * This is provider #2, and its value is that it implements a **strict subset**
 * of the seam. Composio implements every arm (both auth brokers, findActive,
 * delete, hasConnection, its own callback routes); Smithery implements
 * `createSession`, `cleanup` and a liveness `probe`. If the interface were
 * secretly Composio-shaped, this file could not exist without changing it.
 *
 * What Smithery does NOT implement, and why — each is a genuine property of the
 * vendor, not an omission of convenience:
 *
 *   - `initiate` — Smithery's OAuth arm is *fused into the upsert*. You discover
 *     `auth_required` as the status of a created connection and send the user to
 *     a Smithery-hosted `setupUrl`. There is nowhere to hand Smithery our
 *     `callbackUrl`, so `InitiateManagedConnectionOptions` has no meaning here.
 *   - `routes` — follows from the above: the OAuth round-trip lands back at
 *     Smithery, not at us, so this provider contributes no HTTP callback
 *     surface. (Composio owns `/v1/composio-auth/*` precisely because its
 *     callback URL is registered at the vendor.)
 *   - `connectApiKey` / `findActive` — both are blocked on the *option shape*,
 *     not the vendor. Smithery identifies a connection by
 *     `(namespace, connectionId)` where the connection id is derived from the
 *     owner AND the server slug. Those two option types carry `authConfigId`
 *     but not `toolkit`, so there is no way to say *which* connector is meant.
 *     Smithery supports both operations natively (`PUT` with `headers`, `GET`);
 *     the seam simply cannot address them yet. See the PR notes.
 *
 *   - `delete` — the seam's arm takes a bare connection id, which cannot carry
 *     the namespace a Smithery DELETE must target. Smithery's teardown is the
 *     `cleanup` arm instead, which is handed the whole brokered ref and reads
 *     the namespace and host recorded on it at install.
 *
 * The Connect API client is imported dynamically, mirroring the Composio
 * discipline: constructing the provider and holding it in the registry links
 * nothing.
 *
 * **Known: an abandoned setup leaves a connection at the broker.** The upsert
 * creates it before the status is known, so an `auth_required` / `input_required`
 * answer throws with no ref persisted — and uninstall teardown can only address
 * what a ref names. It self-heals if the user completes setup and retries (the
 * connection id is deterministic per owner+server, so the retry adopts it) and
 * leaks only if they abandon. Compensating-deleting on the throw path would add
 * its own failure mode for a case that resolves itself on retry.
 */

import type { ConnectorOwner } from "../../../identity/connector-owner.ts";
import type {
  BrokeredCleanupResult,
  BrokeredStateOptions,
  CreateManagedSessionOptions,
  ManagedConnectorProvider,
  ManagedSession,
} from "../managed-provider.ts";
import type { SmitheryClientOptions } from "./client.ts";
import { validateSmitheryConfig } from "./config.ts";
import { SmitheryConnectionProbe } from "./connection-probe.ts";
import { smitheryCoordinatesFrom } from "./coordinates.ts";
import { SMITHERY_PROVIDER_ID } from "./id.ts";
import { SMITHERY_CREDENTIAL_PROVIDER } from "./transport-credential.ts";

/**
 * Owner-namespaced identity Smithery keys connections on, carried as
 * `metadata.userId` so a namespace's connections can be filtered per owner.
 *
 * Same formula as Composio's: workspace ids are not globally unique across
 * tenants (`ws_01abc` exists in every tenant), so `NB_TENANT_ID` is what
 * disambiguates the broker-side namespace. Vendor-free — no client load.
 */
export function smitheryUserId(owner: ConnectorOwner): string {
  const tid = process.env.NB_TENANT_ID?.trim();
  const base = owner.type === "workspace" ? owner.wsId : `user:${owner.userId}`;
  return tid ? `${tid}:${base}` : base;
}

/** The platform-wide Smithery broker credential. Present by construction — the provider is built only when configured. */
function clientOptions(): SmitheryClientOptions {
  const { apiKey, baseUrl, namespace } = validateSmitheryConfig();
  return { apiKey, baseUrl, namespace };
}

/**
 * Smithery's catalog block: one field, the registry qualified name
 * (`nimblebrain/bassethound`). Read defensively — the value came off a YAML file
 * or a registry response, so the declared type is a claim, not a fact.
 */
function serverFrom(config: Record<string, unknown>): string {
  return typeof config.server === "string" ? config.server.trim() : "";
}

/**
 * Mint a hosted MCP session for one (owner, server) pair.
 *
 * The upsert is idempotent, so a re-install re-uses the existing connection
 * rather than orphaning one. Smithery has no auth-config concept and takes no
 * per-connection tool allowlist — a connection exposes the upstream server's own
 * surface — so its catalog block carries neither, which is exactly why the seam
 * passes the block through opaquely instead of naming Composio's coordinates.
 */
async function createSession(opts: CreateManagedSessionOptions): Promise<ManagedSession> {
  const server = serverFrom(opts.config);
  if (!server) {
    throw new Error(
      `Smithery install of "${opts.connectorId}": smithery config block is missing a \`server\`.`,
    );
  }
  const options = clientOptions();
  const {
    SmitheryConnectionNotReadyError,
    smitheryConnectionId,
    smitheryMcpUrl,
    upsertSmitheryConnection,
  } = await import("./client.ts");

  const connectionId = smitheryConnectionId(opts.userId, server);
  const connection = await upsertSmitheryConnection(options, connectionId, {
    server,
    name: server,
    metadata: { userId: opts.userId, server },
  });

  const status = connection.status;
  if (status?.state === "auth_required" || status?.state === "input_required") {
    throw new SmitheryConnectionNotReadyError(
      status.state,
      status.setupUrl,
      status.state === "auth_required"
        ? `Smithery connection for "${server}" needs authorization${
            status.setupUrl ? ` — complete it at ${status.setupUrl}` : ""
          }.`
        : `Smithery connection for "${server}" needs configuration${
            status.setupUrl ? ` — provide it at ${status.setupUrl}` : ""
          }.`,
    );
  }
  if (status?.state === "error") {
    throw new Error(
      `Smithery connection for "${server}" is in an error state: ${
        status.message ?? "no detail supplied"
      }`,
    );
  }

  // Smithery hosts the MCP endpoint per connection. `connected` and
  // `disconnected` are both usable — Smithery re-establishes the upstream leg on
  // demand ("stateless for you").
  //
  // Deliberately NO `headers`. That field reports headers the VENDOR returned
  // for the runtime to persist alongside the transport — Composio's path scrubs
  // and keeps them; Smithery returns none. Its bearer is the broker credential,
  // which has exactly one home: the `smithery` credential provider, attaching it
  // at transport-build time. Returning a copy would put the live key in a value
  // nothing reads, which is what this seam exists to stop.
  return {
    type: "http",
    url: smitheryMcpUrl(options, connectionId),
    credentialProvider: SMITHERY_CREDENTIAL_PROVIDER,
    // What the probe reads and uninstall deletes. Host and namespace travel with
    // the connection so a later config repoint can't point either at a different
    // broker or namespace than the one it was created at.
    providerRef: { connectionId, namespace: options.namespace, baseUrl: options.baseUrl },
  };
}

/**
 * Build the Smithery `ManagedConnectorProvider`. Called only when Smithery is
 * configured (`buildManagedConnectorRegistry`), so the API key and namespace are
 * both set.
 */
export function createSmitheryProvider(): ManagedConnectorProvider {
  // The operator can disable JUST the liveness sweep without disabling the
  // connector's session brokering. When off, omit `probe` entirely so the
  // runtime wires none for this provider — same shape as Composio's, and the
  // reason the revalidator wiring in `server.ts` stays provider-agnostic.
  const { monitorEnabled } = validateSmitheryConfig();
  return {
    id: SMITHERY_PROVIDER_ID,
    userId: smitheryUserId,
    createSession,
    cleanup,
    ...(monitorEnabled ? { probe: () => new SmitheryConnectionProbe(clientOptions()) } : {}),
  };
}

/**
 * The `cleanup` arm: delete the brokered connection. There is no local state to
 * drop — Smithery stores credentials write-only on its side — so the broker
 * delete IS the whole teardown, and `localDeleted` is always false.
 *
 * `namespace` and `baseUrl` come from the REF, not from current config, so a
 * repointed config can't DELETE against the wrong host or namespace, where a 404
 * would read as "already gone" and report success while the real connection
 * survives.
 */
async function cleanup(opts: BrokeredStateOptions): Promise<BrokeredCleanupResult> {
  const coords = smitheryCoordinatesFrom(opts.brokered.providerRef);
  if (!coords) {
    return {
      upstreamDeleted: false,
      localDeleted: false,
      lastError:
        `Smithery ref for "${opts.brokered.connectorId}" carries no connection coordinates — ` +
        "nothing to revoke.",
    };
  }
  const { upstreamDeleted, lastError } = await cleanupSmitheryBundle(coords);
  return { upstreamDeleted, localDeleted: false, ...(lastError ? { lastError } : {}) };
}

/**
 * Tear down a smithery-backed bundle's brokered connection.
 *
 * The reason it exists at all: uninstall-without-prior-disconnect is the
 * realistic flow, and without a teardown the connection — plus, for any
 * OAuth-backed Smithery connector, the user's upstream grant that Smithery
 * holds — stays alive at the broker forever with no revoke path in the product.
 *
 * Exported for its own direct tests; the runtime reaches it through the
 * provider's `cleanup` arm. Best-effort — never throws.
 */
export async function cleanupSmitheryBundle(opts: {
  connectionId: string;
  namespace: string;
  baseUrl: string;
}): Promise<{ upstreamDeleted: boolean; lastError?: string }> {
  try {
    // Inside the try: resolution validates `baseUrl` and throws on a bad one,
    // and this function is contractually best-effort.
    if (!validateSmitheryConfig().apiKey) {
      return {
        upstreamDeleted: false,
        lastError: "Smithery is not configured — cannot revoke the brokered connection.",
      };
    }
    const { deleteSmitheryConnection } = await import("./client.ts");
    const options = clientOptions();
    await deleteSmitheryConnection(
      { ...options, namespace: opts.namespace, baseUrl: opts.baseUrl },
      opts.connectionId,
    );
    return { upstreamDeleted: true };
  } catch (err) {
    return {
      upstreamDeleted: false,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}
