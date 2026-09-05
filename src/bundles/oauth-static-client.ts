/**
 * Resolve a URL bundle's pre-registered OAuth client (Track A) — the one place
 * `oauthClient.clientSecret` is dereferenced.
 *
 * Two call sites need it and they are on opposite sides of the lifecycle: boot
 * (`startup.ts`, building the provider for a connection that already exists) and
 * `startAuth` (`lifecycle.ts`, building it for a flow the user just started).
 * They had a copy each, which is one copy too many for a secret read: an
 * error-message tweak, a scope fix, or an audit field lands in one and not the
 * other, and the drift is invisible because each path is exercised separately.
 */

import { requireCredentialStore } from "../tools/credential-store.ts";
import type { BundleRef } from "./types.ts";

/** Resolved pre-registered OAuth client (Track A), with the secret dereferenced to a string. */
export type StaticOAuthClient = {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic";
};

/**
 * Dereference `ref.oauthClient` against the workspace credential store.
 * Returns `undefined` when the bundle has no static client config (the DCR path)
 * — before touching the store, so the overwhelmingly common DCR bundle needs no
 * store installed at all.
 *
 * A configured-but-missing secret throws. The catalog boundary already enforced
 * that the reference is well-formed, so a miss here means the operator has not
 * seeded the value — recoverable by configuring it and restarting, which is
 * exactly what the message says. Errors abort the boot of this bundle (its
 * connection enters `dead`) rather than starting a connection that cannot
 * authenticate.
 */
export async function resolveStaticOAuthClient(opts: {
  ref: BundleRef;
  wsId: string;
  /** Names the connection in the error and the audit line. */
  serverName?: string;
}): Promise<StaticOAuthClient | undefined> {
  const { ref, wsId, serverName } = opts;
  if (!ref.oauthClient) return undefined;

  let resolvedSecret: string | undefined;
  if (ref.oauthClient.clientSecret) {
    const key = ref.oauthClient.clientSecret.key;
    const wrapped = await requireCredentialStore().get({ kind: "workspace", wsId }, key, {
      caller: "oauth:client_secret",
      purpose: serverName
        ? `pre-registered OAuth client for ${serverName}`
        : "pre-registered OAuth client",
    });
    if (!wrapped) {
      const forServer = serverName ? ` for ${serverName}` : "";
      throw new Error(
        `[bundles] OAuth client_secret not found at credential key "${key}"${forServer} — ` +
          "configure it in the workspace's Connections settings (web UI)",
      );
    }
    resolvedSecret = wrapped.reveal();
  }

  return {
    clientId: ref.oauthClient.clientId,
    ...(resolvedSecret ? { clientSecret: resolvedSecret } : {}),
    ...(ref.oauthClient.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: ref.oauthClient.tokenEndpointAuthMethod }
      : {}),
  };
}
