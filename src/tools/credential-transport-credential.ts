/**
 * The `credential` transport credential — a connection authenticating with a
 * secret the WORKSPACE owns.
 *
 * This is the gateway pattern (`src/connectors/gateways/transport-credential.ts`)
 * moved down one scope, and that single change is what it exists for. A gateway
 * resolves one account-wide key, so every workspace on the instance reaches the
 * vendor as the same caller. This resolves the key from the connection's own
 * workspace, so one catalog entry installs into two workspaces and each presents
 * its own secret — a per-tenant database URL, an API key the customer owns —
 * with no vendor code, no second catalog entry, and nothing secret in
 * `workspace.json`.
 *
 * The invariant is the one every credential provider holds: **persisted state
 * names *what* credential it needs, never *where* the value comes from.** An
 * install copies `providerAuth.config` verbatim into the `BundleRef`, so the
 * config here carries a store KEY (`{ key: "acme.db_url" }`) — a name inside the
 * workspace's own store, meaningless outside it — and never an env var name or a
 * value.
 *
 * Resolution is per REQUEST, inside the `fetch` wrapper, for the same reason
 * `minted` re-mints there: the credential outlives no single build. Rotating the
 * key with a `put` is picked up by the next request, and a key deleted while a
 * connection is live fails that request naming the key rather than 401-ing
 * opaquely.
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { injectTraceparent } from "../observability/index.ts";
import {
  registerCredentialProvider,
  type TransportCredential,
  type TransportCredentialProvider,
} from "./credential-provider.ts";
import { CredentialNotFoundError, requireCredentialStore } from "./credential-store.ts";

/** The provider name an `auth: provider` catalog entry selects. */
export const CREDENTIAL_PROVIDER = "credential";

/** Default header when the config names none — the overwhelmingly common shape. */
const DEFAULT_HEADER = "Authorization";

/** Config the catalog entry carries: which key, and optionally which header. */
interface CredentialProviderConfig {
  key: string;
  header?: string;
}

function parseConfig(config: Record<string, unknown>): CredentialProviderConfig {
  if (config === null || typeof config !== "object") {
    throw new Error(
      "[credential] transport credential requires a config object ({ key }); got a `provider` auth with no `config`",
    );
  }
  const { key, header } = config;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("[credential] transport credential requires a string `key` in config");
  }
  if (header !== undefined && (typeof header !== "string" || header.length === 0)) {
    throw new Error("[credential] transport credential `header` must be a non-empty string");
  }
  return { key, ...(header ? { header } : {}) };
}

/**
 * The built-in workspace-secret credential provider.
 *
 * `config`: `{ key: string; header?: string }`. The key resolves at the
 * connection's workspace scope; `header` defaults to `Authorization` with a
 * `Bearer ` prefix, and a named header carries the secret verbatim (a vendor
 * that wants `x-api-key: <secret>` gets exactly that).
 *
 * A missing `workspaceId` is a hard error, not a fall back to the instance
 * scope. The whole point of this provider is that the secret belongs to one
 * tenant; resolving it anywhere else would hand one workspace's key to another.
 */
export const credentialTransportCredentialProvider: TransportCredentialProvider = {
  credentialFor(
    workspaceId: string | undefined,
    config: Record<string, unknown>,
  ): TransportCredential {
    if (!workspaceId) {
      throw new Error(
        "[credential] transport credential requires a workspaceId (the workspace that owns the secret)",
      );
    }
    const { key, header } = parseConfig(config);
    const store = requireCredentialStore();
    const scope = { kind: "workspace", wsId: workspaceId } as const;

    const authed: FetchLike = async (input, init) => {
      const wrapped = await store.get(scope, key, {
        caller: "transport:provider:credential",
        purpose: `authenticate remote MCP request as workspace ${workspaceId}`,
      });
      if (!wrapped) {
        throw new CredentialNotFoundError(scope, key, "a `credential` provider-auth connection");
      }
      const secret = wrapped.reveal();
      // We own this header for this connection; the transport's own headers
      // (content-type, session id) ride through via `init`.
      const headers = new Headers(init?.headers);
      if (header) {
        headers.set(header, secret);
      } else {
        headers.set(DEFAULT_HEADER, `Bearer ${secret}`);
      }
      // Continue the active trace onto the authenticated hop, matching `minted`.
      injectTraceparent(headers);
      return fetch(input as Parameters<typeof fetch>[0], { ...init, headers });
    };

    return { fetch: authed };
  },
};

/** Register the provider. Called from the composition root once the store is installed. */
export function registerCredentialTransportCredentialProvider(): void {
  registerCredentialProvider(CREDENTIAL_PROVIDER, credentialTransportCredentialProvider);
}
