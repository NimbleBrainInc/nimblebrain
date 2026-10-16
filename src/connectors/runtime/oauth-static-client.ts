/**
 * Resolve a URL connector's pre-registered OAuth client (Track A) — the one place
 * `oauthClient.clientSecret` or an instance operator app is dereferenced.
 *
 * Every path that builds a connection's OAuth provider calls it: boot and lazy
 * start (`startup.ts`, for a workspace or a personal connector) and `startAuth`
 * (`lifecycle.ts`, for a flow the user just started).
 * A copy per path would be one copy too many for a secret read: an
 * error-message tweak, a scope fix, or an audit field lands in one and not the
 * other, and the drift is invisible because each path is exercised separately.
 */

import { requireCredentialStore } from "../../tools/credential-store.ts";
import { instanceOperatorApp } from "./operator-apps.ts";
import { type ConnectorRef, isInstanceOAuthClient } from "./types.ts";

/** Resolved pre-registered OAuth client (Track A), with the secret dereferenced to a string. */
export type StaticOAuthClient = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
};

/**
 * Dereference `ref.oauthClient`. Returns `undefined` when the connector has no
 * static client config (the DCR path) — before touching the store, so the
 * overwhelmingly common DCR connector needs no store installed at all.
 *
 * Two forms resolve here:
 *  - an app on the ref, whose secret is read from the WORKSPACE credential
 *    store, so it needs `wsId`;
 *  - an instance operator app (`instanceApp`), read from the bound instance
 *    config for any owner, workspace or personal. It resolves only when the
 *    ref's URL is the one the catalog publishes for that app, so the operator's
 *    secret is never sent toward a server the catalog did not name.
 *
 * Every failure throws. The catalog boundary already enforced that the
 * reference is well-formed, so a miss here means the operator has not seeded
 * the value — recoverable by configuring it and restarting, which is exactly
 * what the message says. Errors abort the boot of this connector (its
 * connection enters `dead`) rather than starting a connection that cannot
 * authenticate.
 */
export async function resolveStaticOAuthClient(opts: {
  ref: ConnectorRef;
  /** The owning workspace; absent for a personal connector. */
  wsId?: string;
  /** Names the connection in the error and the audit line. */
  serverName?: string;
}): Promise<StaticOAuthClient | undefined> {
  const { ref, wsId, serverName } = opts;
  const client = ref.oauthClient;
  if (!client) return undefined;
  const forServer = serverName ? ` for ${serverName}` : "";
  if (isInstanceOAuthClient(client)) {
    return resolveInstanceClient(client.instanceApp, ref.url, forServer);
  }
  const clientSecret = client.clientSecret
    ? await revealWorkspaceSecret(client.clientSecret.key, wsId, serverName, forServer)
    : undefined;
  return {
    clientId: client.clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(client.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: client.tokenEndpointAuthMethod }
      : {}),
  };
}

/** The instance operator app `catalogId`, refused for any URL but the one it is bound to. */
function resolveInstanceClient(
  catalogId: string,
  url: string,
  forServer: string,
): StaticOAuthClient {
  const app = instanceOperatorApp(catalogId);
  if (!app) {
    throw new Error(
      `[connectors] no operator app is declared for "${catalogId}"${forServer} — ` +
        "declare it in connectors.operatorApps and restart",
    );
  }
  if (app.url !== url) {
    throw new Error(
      `[connectors] the operator app for "${catalogId}" serves ${app.url}, ` +
        `not ${url}${forServer}; reinstall the connector from the catalog`,
    );
  }
  return { clientId: app.clientId, clientSecret: app.clientSecret };
}

/** A workspace's own client secret, read and revealed (one audit line). */
async function revealWorkspaceSecret(
  key: string,
  wsId: string | undefined,
  serverName: string | undefined,
  forServer: string,
): Promise<string> {
  if (!wsId) {
    throw new Error(
      `[connectors] OAuth client_secret${forServer} is a workspace secret, ` +
        "and this connection has no workspace",
    );
  }
  const wrapped = await requireCredentialStore().get({ kind: "workspace", wsId }, key, {
    caller: "oauth:client_secret",
    purpose: serverName
      ? `pre-registered OAuth client for ${serverName}`
      : "pre-registered OAuth client",
  });
  if (!wrapped) {
    throw new Error(
      `[connectors] OAuth client_secret not found at credential key "${key}"${forServer} — ` +
        "configure it in the workspace's Connections settings (web UI)",
    );
  }
  return wrapped.reveal();
}
