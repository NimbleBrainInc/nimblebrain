/**
 * Instance OAuth clients — the OAuth client an `auth: static` catalog entry signs
 * in with, declared once in `connectors.oauthClients` instead of set up in each
 * workspace.
 *
 * A vendor without dynamic client registration (DCR) needs a pre-registered client,
 * and the client belongs to whoever holds the vendor relationship: with one
 * instance per tenant, the operator. One declaration makes the entry installable
 * in every workspace and on every person's identity, and each connection signs
 * in with its own account. The secret is the operator's, never a workspace's,
 * which is why a connector ref names the client (`oauthClient.instanceClient`) and
 * never carries a copy of its id or a reference to its secret.
 *
 * ## Bound to the catalog's URL
 *
 * The token endpoint a secret is sent to is discovered from the connection's
 * URL. So the client is bound, at boot, to the URL the trusted catalog publishes
 * for its id, and resolving it for any other URL fails closed. Without the bind,
 * a ref naming the client beside a URL of the caller's choosing would hand the
 * operator's secret to that server's authorization server.
 *
 * Bound once in `Runtime.start`, after `setConnectorsConfig` and before any
 * connector starts, and read synchronously afterwards — the leaf resolver
 * (`oauth-static-client.ts`) holds no runtime. Rotating a client is a config
 * change and a restart, like every instance-scope secret.
 */

import { log } from "../../observability/log.ts";
import type { ConnectorCatalogEntry } from "../catalog/types.ts";
import { declaredOAuthClients } from "../providers/config.ts";

/** A declared OAuth client, resolved and bound to its catalog entry's URL. */
export interface InstanceOAuthClient {
  /** The catalog id of the `auth: static` entry this client serves. */
  catalogId: string;
  clientId: string;
  clientSecret: string;
  /** The remote URL the trusted catalog publishes for `catalogId`. */
  url: string;
}

let _bound = new Map<string, InstanceOAuthClient>();

/**
 * The env var an OAuth client's secret falls back to: the catalog id
 * upper-cased with every non-alphanumeric run collapsed to `_`, then
 * `_CLIENT_SECRET`. `com.example/mcp` reads `COM_EXAMPLE_MCP_CLIENT_SECRET`.
 */
export function oauthClientSecretEnvVar(catalogId: string): string {
  return `${catalogId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}_CLIENT_SECRET`;
}

/**
 * Resolve every declared client and bind it to its catalog entry.
 *
 * Throws when a declared client has no `clientId` or no secret (declared or from
 * its env var): a deploy that names a client means to serve it, and finding out at
 * the first sign-in is later than it needs to be. A blank value counts as
 * absent, because a templated deploy renders an unset value to `""`.
 *
 * An id the catalog does not publish as an `auth: static` entry is logged and
 * left unbound, so nothing can use it. The catalog is shared across tenants and
 * can lose an entry without this tenant's config changing; that must not stop
 * the instance from booting.
 */
export async function bindInstanceOAuthClients(
  loadCatalogById: () => Promise<Map<string, ConnectorCatalogEntry>>,
): Promise<void> {
  const bound = new Map<string, InstanceOAuthClient>();
  const declaredClients = Object.entries(declaredOAuthClients() ?? {});
  // Read the catalog only when there is something to bind against it.
  const catalogById = declaredClients.length > 0 ? await loadCatalogById() : new Map();
  for (const [catalogId, declared] of declaredClients) {
    const clientId = declared.clientId?.trim();
    if (!clientId) {
      throw new Error(
        `[instance-oauth-clients] connectors.oauthClients["${catalogId}"] has no clientId`,
      );
    }
    const envVar = oauthClientSecretEnvVar(catalogId);
    const clientSecret = declared.clientSecret?.trim() || process.env[envVar]?.trim();
    if (!clientSecret) {
      throw new Error(
        `[instance-oauth-clients] connectors.oauthClients["${catalogId}"] has no clientSecret, ` +
          `declared or in ${envVar}`,
      );
    }
    const entry = catalogById.get(catalogId);
    if (entry?.auth !== "static") {
      log.error(
        `[instance-oauth-clients] connectors.oauthClients["${catalogId}"] matches no auth: static ` +
          "catalog entry; it is not used",
      );
      continue;
    }
    bound.set(catalogId, { catalogId, clientId, clientSecret, url: entry.url });
  }
  _bound = bound;
}

/** The instance OAuth client for a catalog id, or undefined when the operator declared none. */
export function instanceOAuthClient(catalogId: string): InstanceOAuthClient | undefined {
  return _bound.get(catalogId);
}

/** Test-only. Drop every bound client. */
export function _resetInstanceOAuthClientsForTest(): void {
  _bound = new Map();
}
