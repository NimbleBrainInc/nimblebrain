import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  registerCredentialProvider,
  type TransportCredential,
  type TransportCredentialProvider,
} from "../tools/credential-provider.ts";
import {
  createMintingFetch,
  getDefaultServiceTokenCache,
  resolveAuthorizerTokenUrl,
} from "./tenant-key-mint.ts";

/** The provider name a catalog/source auth config selects: `{ type: "provider";
 *  provider: "minted"; config: { audience, scope, issuer? } }`. */
export const MINTED_PROVIDER = "minted";

/**
 * The platform minting provider. Mints a short-lived, workspace-scoped service
 * token against the fleet authorizer and attaches it as the transport's `fetch`
 * (re-minted on expiry / 401). This is the thin adapter that keeps the kernel's
 * generic transport seam ignorant of the NimbleBrain mint protocol — the mint
 * machinery (`tenant-key-mint.ts`) stays a kernel capability (the host artifact
 * read path uses it too), but `remote-transport.ts` reaches it only through this
 * registered provider, never by import.
 *
 * `config`: `{ audience: string; scope: string; tokenUrl?: string; issuer?: string }`.
 * The authorizer token endpoint resolves via `resolveAuthorizerTokenUrl`: an explicit
 * `tokenUrl` (config or `NB_FLEET_AUTHORIZER_TOKEN_URL`) wins, else `${issuer}/token`
 * from `NB_FLEET_AUTHORIZER_ISSUER` (legacy fallback). Workspace comes from the
 * connection (the dimension the token is scoped to), NOT from config.
 */
export const mintedCredentialProvider: TransportCredentialProvider = {
  credentialFor(
    workspaceId: string | undefined,
    config: Record<string, unknown>,
  ): TransportCredential {
    if (!workspaceId) {
      throw new Error(
        "minted transport credential requires a workspaceId (the connection's workspace dimension)",
      );
    }
    if (config === null || typeof config !== "object") {
      throw new Error(
        "minted transport credential requires a config object ({ audience, scope }); got a `provider` auth with no `config`",
      );
    }
    const tokenUrl = resolveAuthorizerTokenUrl({
      tokenUrl: typeof config.tokenUrl === "string" ? config.tokenUrl : undefined,
      issuer: typeof config.issuer === "string" ? config.issuer : undefined,
    });
    if (!tokenUrl) {
      throw new Error(
        "minted transport credential requires the authorizer token endpoint (set NB_FLEET_AUTHORIZER_TOKEN_URL, or NB_FLEET_AUTHORIZER_ISSUER for the legacy `<issuer>/token` fallback)",
      );
    }
    const { audience, scope } = config;
    if (typeof audience !== "string" || audience.length === 0) {
      throw new Error("minted transport credential requires a string `audience` in config");
    }
    if (typeof scope !== "string" || scope.length === 0) {
      throw new Error("minted transport credential requires a string `scope` in config");
    }
    const fetch = createMintingFetch({
      cache: getDefaultServiceTokenCache(),
      tokenUrl,
      workspace: workspaceId,
      audience,
      scope,
    }) as FetchLike;
    return { fetch };
  },
};

/**
 * Register the built-in credential providers. Called once at the composition
 * root (the `serve` command, and any embedder boot). Idempotent.
 */
export function registerBuiltinCredentialProviders(): void {
  registerCredentialProvider(MINTED_PROVIDER, mintedCredentialProvider);
}
